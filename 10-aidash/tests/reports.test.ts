import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { taskCreateSchema } from '../src/shared/schemas.js';
import type { ReportRunView } from '../src/shared/types.js';
import { periodRange, periodRangeFromKey } from '../src/server/services/report-period.js';
import {
  api,
  createHarness,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

const CHANNEL = 'devhost/myproj/reports';
const REPORT_CONTENT = '# 本期结论\n\n- 完成 3 项\n- 风险 1 项';

let harness: TestHarness | null = null;
let app: RunningApp | null = null;
let fake: FakeLlm | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  await fake?.close();
  fake = null;
  harness?.close();
  harness = null;
});

interface FakeLlm {
  base: string;
  requests: Array<{ system: string; user: string }>;
  /** 延迟可在批次中途改：前一批用 0，后一批用 2000 来测取消。 */
  delayMs: number;
  /** 从第 N 次调用起返回 500（0 = 不失败），用于验证多目标批次的中途失败。 */
  failFrom: number;
  close: () => Promise<void>;
}

/**
 * 假 LLM 网关。
 *
 * 汇报走真实 HTTP 才能验证取消时 AbortSignal 确实断开了 fetch；
 * 需要“生成中来取消”的用例用 delayMs 拖住响应。
 */
async function startFakeLlm(delayMs = 0): Promise<FakeLlm> {
  const requests: FakeLlm['requests'] = [];
  const state = { delayMs, failFrom: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const system = body.messages?.[0]?.content ?? '';
      const user = body.messages?.[1]?.content ?? '';
      // 汇报完成后学习器也会调用模型，但它不是“汇报生成”请求。
      // 不单独分流的话，生成次数、顺序、failFrom 序号都会被多出来的一次调用打乱，
      // 用例测的就不再是汇报本身的逻辑。
      if (system.includes('AIDash 的记忆整理助手')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"lines":[]}' } }] }));
        return;
      }
      requests.push({ system, user });
      // 调用序号在请求到达时就固定，后续改 requests 不会影响本次判断。
      const callNo = requests.length;
      const respond = (): void => {
        if (res.writableEnded || res.destroyed) return;
        if (state.failFrom > 0 && callNo >= state.failFrom) {
          // 故意不回 JSON：走 llm.chat 的 HTTP 错误分支，等价于网关故障。
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('boom');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: REPORT_CONTENT } }] }));
      };
      if (state.delayMs > 0) setTimeout(respond, state.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    requests,
    get delayMs(): number {
      return state.delayMs;
    },
    set delayMs(value: number) {
      state.delayMs = value;
    },
    get failFrom(): number {
      return state.failFrom;
    },
    set failFrom(value: number) {
      state.failFrom = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function configure(h: TestHarness, base: string): void {
  h.ctx.services.settings.update(
    {
      llm_endpoint: base,
      llm_model: 'deepseek-flash',
      llm_mode: 'max',
      llm_api_key: 'sk-page-key',
    },
    testCtx(),
  );
}

function seedTask(h: TestHarness, title = '修复登录 500'): string {
  return h.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: CHANNEL, title }),
    testCtx(),
  ).task.id;
}

/**
 * 后台生成不阻塞 HTTP；测试用短轮询等它落库，超时直接失败而不是留下悬挂用例。
 * ManualClock 下多个批次的 started_at 相同，runs[0] 可能是旧批次；必须按 id 找。
 */
async function waitForIdle(
  h: TestHarness,
  runId: string,
  timeoutMs = 5_000,
): Promise<ReportRunView> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = h.ctx.services.reports.status();
    if (!state.running) {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) throw new Error(`no report run recorded for ${runId}`);
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('report run did not finish in time');
}

describe('周期边界', () => {
  const now = new Date(2026, 9, 24, 12, 0, 0).getTime(); // 2026-10-24 周六，本地时区

  it('六种周期的 key 与窗口按本地日历计算', () => {
    expect(periodRange('day', now)).toMatchObject({
      key: '2026-10-24',
      start: new Date(2026, 9, 24).getTime(),
      end: new Date(2026, 9, 25).getTime(),
    });
    // 周六所在 ISO 周从 10-19（周一）开始。
    expect(periodRange('week', now)).toMatchObject({
      key: '2026-W43',
      start: new Date(2026, 9, 19).getTime(),
      end: new Date(2026, 9, 26).getTime(),
    });
    expect(periodRange('month', now).key).toBe('2026-10');
    expect(periodRange('quarter', now).key).toBe('2026-Q4');
    expect(periodRange('half', now).key).toBe('2026-H2');
    expect(periodRange('year', now).key).toBe('2026');
  });

  it('由历史 key 反推窗口，解析失败时退回当前周期', () => {
    expect(periodRangeFromKey('month', '2026-06', now)).toMatchObject({
      start: new Date(2026, 5, 1).getTime(),
      end: new Date(2026, 6, 1).getTime(),
    });
    expect(periodRangeFromKey('week', '2026-W43', now).start).toBe(
      periodRange('week', now).start,
    );
    expect(periodRangeFromKey('month', '不是 key', now).key).toBe('2026-10');
  });
});

describe('汇报生成', () => {
  it('“更新汇报”按 日→周→月→季→半年→年 顺序生成六条', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);
    seedTask(h);

    const run = h.ctx.services.reports.startPeriodUpdate(testCtx());
    expect(run.total).toBe(6);
    const finished = await waitForIdle(h, run.id);
    expect(finished.status).toBe('done');
    expect(finished.completed).toBe(6);
    expect(fake.requests).toHaveLength(6);

    // 生成顺序看请求顺序，不看列表排序：ManualClock 下六条 updated_at 相同，
    // 列表按 id 打破平局，ULID 随机段不保证插入顺序。
    const labels = fake.requests.map(
      (request) => /汇报类型：(\S+)/.exec(request.user)?.[1] ?? '',
    );
    expect(labels).toEqual(['日报', '周报', '月报', '季度报', '半年报', '年报']);

    const list = h.ctx.services.reports.list({ kind: 'period', page_size: 20 });
    expect(list.total).toBe(6);
    expect(new Set(list.items.map((item) => item.period))).toEqual(
      new Set(['day', 'week', 'month', 'quarter', 'half', 'year']),
    );
    for (const item of list.items) {
      expect(item.status).toBe('ready');
      expect(item.content_md).toContain('本期结论');
      expect(item.generated_at).not.toBeNull();
      expect(item.source_count).toBeGreaterThan(0);
    }
    // 提示词取 report 能力，且素材里带上了真实任务标题。
    expect(fake.requests[0]?.system).toContain('研发经理');
    // 汇报口径必须偏“提效与能力成长”，而不是堆数据；决策项只有值得要资源时才出现。
    expect(fake.requests[0]?.system).toContain('提效与能力成长');
    expect(fake.requests[0]?.system).toContain('本期无需老板决策');
    expect(fake.requests.some((request) => request.user.includes('修复登录 500'))).toBe(true);
  });

  it('同一时间只允许一个批次；结束之后可以再次发起', async () => {
    fake = await startFakeLlm(150);
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const firstRun = h.ctx.services.reports.startPeriodUpdate(testCtx());
    expect(() =>
      h.ctx.services.reports.startTopic(
        { instruction: '写一份专题', targetReportIds: [] },
        testCtx(),
      ),
    ).toThrowError(/REPORT_RUNNING/);

    await waitForIdle(h, firstRun.id);
    // 结束后闸门释放，不会永久卡死。
    const secondRun = h.ctx.services.reports.startPeriodUpdate(testCtx());
    await waitForIdle(h, secondRun.id);
  });

  it('取消会穿透正在等待的模型请求，并把当前一条标为已取消', async () => {
    fake = await startFakeLlm(2_000);
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const run = h.ctx.services.reports.startPeriodUpdate(testCtx());
    // 等后台真正进入模型调用，确保取消打在 fetch 上，而不是还没开始。
    const started = Date.now();
    while (fake.requests.length === 0 && Date.now() - started < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fake.requests).toHaveLength(1);

    h.ctx.services.reports.cancel(run.id, testCtx());
    const finished = await waitForIdle(h, run.id);
    expect(finished.status).toBe('cancelled');
    expect(finished.cancel_requested).toBe(true);

    const list = h.ctx.services.reports.list({ kind: 'period', page_size: 20 });
    // 只创建了第一条（日报），后面的周期不再开始。
    expect(list.total).toBe(1);
    expect(list.items[0]?.period).toBe('day');
    expect(list.items[0]?.status).toBe('cancelled');
  });

  it('模型未配置时明确拒绝发起，不留下空批次', () => {
    const h = createHarness();
    harness = h;
    expect(() => h.ctx.services.reports.startPeriodUpdate(testCtx())).toThrowError(
      /LLM_NOT_CONFIGURED/,
    );
    expect(h.ctx.services.reports.status().runs).toHaveLength(0);
  });

  it('进程重启后把遗留 running 收尸为失败', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const now = h.clock.now();
    h.ctx.repos.reports.createRun({
      id: 'rn_restart_fixture',
      kind: 'period',
      total: 6,
      targetReportId: null,
      instruction: null,
      now,
    });
    h.ctx.repos.reports.beginPeriod({
      id: 'rp_restart_fixture',
      period: 'day',
      periodKey: '2026-10-24',
      title: '日报 · 2026-10-24',
      runId: 'rn_restart_fixture',
      now,
    });

    expect(h.ctx.services.reports.recover()).toBe(1);
    expect(h.ctx.services.reports.status().running).toBeNull();
    const report = h.ctx.services.reports.get('rp_restart_fixture');
    expect(report.status).toBe('failed');
    expect(report.error_message).toBe('server_restart');
  });
});

describe('专题汇报', () => {
  it('不指定目标时新建一条专题汇报，并保留用户要求', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const run = h.ctx.services.reports.startTopic(
      { topic: '季度故障复盘', instruction: '按影响、根因、修复、预防四部分写。' },
      testCtx(),
    );
    const finished = await waitForIdle(h, run.id);
    expect(finished.status).toBe('done');
    expect(finished.kind).toBe('topic');

    const list = h.ctx.services.reports.list({ kind: 'topic', page_size: 20 });
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      kind: 'topic',
      title: '专题 · 季度故障复盘',
      status: 'ready',
      instruction_md: '按影响、根因、修复、预防四部分写。',
    });
    expect(fake.requests[0]?.user).toContain('按影响、根因、修复、预防四部分写。');
  });

  it('指定目标时更新原汇报而不新建，窗口取那一期的自然周期', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const periodRun = h.ctx.services.reports.startPeriodUpdate(testCtx());
    await waitForIdle(h, periodRun.id);
    const month = h.ctx.services.reports.list({ period: 'month', page_size: 5 }).items[0]!;
    const before = h.ctx.services.reports.get(month.id);

    const topicRun = h.ctx.services.reports.startTopic(
      {
        topic: '风险重写',
        instruction: '只保留风险与阻塞，按严重程度排序。',
        targetReportIds: [month.id],
      },
      testCtx(),
    );
    const finished = await waitForIdle(h, topicRun.id);
    expect(finished.kind).toBe('topic');

    const after = h.ctx.services.reports.get(month.id);
    // 同一个 ID：更新覆盖，不是又插入一条月报。
    expect(after.id).toBe(before.id);
    expect(after.instruction_md).toBe('只保留风险与阻塞，按严重程度排序。');
    // 标题不随专题改名：它仍然是月报身份，否则左侧按周期筛选会找不到它。
    expect(after.title).toBe(before.title);
    expect(after.status).toBe('ready');
    expect(h.ctx.services.reports.list({ kind: 'topic', page_size: 20 }).total).toBe(0);
    // 月报窗口不是“最近 30 天”，而是那个月的自然月。
    expect(fake.requests.at(-1)?.user).toContain(month.period_key);

    // 之后再点“更新汇报”会用标准周期提示词重写；旧专题要求必须清掉，
    // 否则详情页一直显示“本次要求：只保留风险”，与实际内容不符。
    const nextRun = h.ctx.services.reports.startPeriodUpdate(testCtx());
    await waitForIdle(h, nextRun.id);
    expect(h.ctx.services.reports.get(month.id).instruction_md).toBeNull();
  });

  it('多目标批次中前一条失败时，后面的汇报不会被卡在生成中', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const periodRun = h.ctx.services.reports.startPeriodUpdate(testCtx());
    await waitForIdle(h, periodRun.id);

    const pick = (period: 'month' | 'quarter' | 'half'): string =>
      h.ctx.services.reports.list({ period, page_size: 5 }).items[0]!.id;
    const month = pick('month');
    const quarter = pick('quarter');
    const half = pick('half');

    // 前 6 次是周期批次；第 8 次即本次专题的第二条目标。
    fake.failFrom = 8;
    const run = h.ctx.services.reports.startTopic(
      { instruction: '按风险重写', targetReportIds: [month, quarter, half] },
      testCtx(),
    );
    const finished = await waitForIdle(h, run.id);
    expect(finished.status).toBe('failed');
    expect(finished.completed).toBe(1);

    expect(h.ctx.services.reports.get(month).status).toBe('ready');
    expect(h.ctx.services.reports.get(quarter).status).toBe('failed');
    // 第三条从未开始，必须保持原状态，而不是被预标成“生成中/已取消”。
    expect(h.ctx.services.reports.get(half).status).toBe('ready');

    // 失败不能把闸门关死：未开始的目标仍能单独再提交。
    fake.failFrom = 0;
    const retry = h.ctx.services.reports.startTopic(
      { instruction: '只重写这一条', targetReportIds: [half] },
      testCtx(),
    );
    await waitForIdle(h, retry.id);
    expect(h.ctx.services.reports.get(half).status).toBe('ready');
  });

  it('取消多目标批次只影响当前一条，未开始的目标保持原状态', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const periodRun = h.ctx.services.reports.startPeriodUpdate(testCtx());
    await waitForIdle(h, periodRun.id);

    const pick = (period: 'month' | 'quarter' | 'half'): string =>
      h.ctx.services.reports.list({ period, page_size: 5 }).items[0]!.id;
    const month = pick('month');
    const quarter = pick('quarter');
    const half = pick('half');

    fake.delayMs = 2_000;
    const run = h.ctx.services.reports.startTopic(
      { instruction: '按风险重写', targetReportIds: [month, quarter, half] },
      testCtx(),
    );
    const started = Date.now();
    while (fake.requests.length < 7 && Date.now() - started < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fake.requests).toHaveLength(7);

    h.ctx.services.reports.cancel(run.id, testCtx());
    const finished = await waitForIdle(h, run.id);
    expect(finished.status).toBe('cancelled');

    expect(h.ctx.services.reports.get(month).status).toBe('cancelled');
    expect(h.ctx.services.reports.get(quarter).status).toBe('ready');
    expect(h.ctx.services.reports.get(half).status).toBe('ready');
  });

  it('重写历史周期时不把当前未结束任务混进素材', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);
    seedTask(h, '现在的未完成任务');

    // 测试时钟默认停在 2026-01-01；用 2025-05 才是真正的“过去周期”。
    const now = h.clock.now();
    h.ctx.repos.reports.beginPeriod({
      id: 'rp_history',
      period: 'month',
      periodKey: '2025-05',
      title: '月报 · 2025-05',
      runId: 'rn_history',
      now,
    });
    h.ctx.repos.reports.markReady('rp_history', {
      content: '旧内容',
      sourceCount: 1,
      model: 'fake',
      mode: 'max',
      now,
    });

    const run = h.ctx.services.reports.startTopic(
      { instruction: '重写这份月报', targetReportIds: ['rp_history'] },
      testCtx(),
    );
    await waitForIdle(h, run.id);

    const prompt = fake.requests.at(-1)?.user ?? '';
    expect(prompt).toContain('2025-05');
    expect(prompt).not.toContain('生成时未结束任务');
    expect(prompt).toContain('历史周期');
  });
});

describe('批次状态守卫', () => {
  it('已完成的批次不会被兜底收尾改判为失败', () => {
    const h = createHarness();
    harness = h;
    const now = h.clock.now();
    h.ctx.repos.reports.createRun({
      id: 'rn_guard',
      kind: 'period',
      total: 6,
      targetReportId: null,
      instruction: null,
      now,
    });
    h.ctx.repos.reports.finishRun('rn_guard', 'done', null, now);
    // kick 的 catch 可能在 done 之后才跑；没有状态守卫会把成功批次改判失败。
    h.ctx.repos.reports.finishRun('rn_guard', 'failed', 'boom', now);
    expect(h.ctx.repos.reports.getRun('rn_guard')).toMatchObject({
      status: 'done',
      error_message: null,
    });
  });
});

describe('汇报 REST', () => {
  it('状态、列表、详情、发起与取消都按预期响应', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);
    app = await startApp(h);

    const initial = await api<{ running: unknown; runs: unknown[] }>(
      app,
      'GET',
      '/api/reports/status',
    );
    expect(initial.status).toBe(200);
    expect(initial.body.data).toMatchObject({ running: null, runs: [] });

    const started = await api<ReportRunView>(app, 'POST', '/api/reports/update', {});
    expect(started.status).toBe(202);
    expect(started.body.data?.total).toBe(6);

    const finished = await waitForIdle(h, started.body.data!.id);
    expect(finished.status).toBe('done');

    const list = await api<{ items: Array<{ id: string }>; total: number }>(
      app,
      'GET',
      '/api/reports?page_size=20',
    );
    expect(list.status).toBe(200);
    expect(list.body.data?.total).toBe(6);

    const id = list.body.data!.items[0]!.id;
    const detail = await api<{ id: string; status: string }>(
      app,
      'GET',
      `/api/reports/${encodeURIComponent(id)}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ id, status: 'ready' });

    // 路由顺序回归：status 不能被当成汇报 ID。
    const statusAgain = await api(app, 'GET', '/api/reports/status');
    expect(statusAgain.status).toBe(200);

    const topic = await api<ReportRunView>(app, 'POST', '/api/reports/topic', {
      topic: '复盘',
      instruction: '按时间线整理',
      target_report_ids: [id],
    });
    expect(topic.status).toBe(202);
    await waitForIdle(h, topic.body.data!.id);

    const cancelUnknown = await api(app, 'POST', '/api/reports/runs/rn_missing/cancel');
    expect(cancelUnknown.status).toBe(404);
  });

  it('列表按修改时间倒序；删除后详情 404，生成中的汇报不允许删除', async () => {
    const h = createHarness();
    harness = h;
    app = await startApp(h);

    const now = h.clock.now();
    h.ctx.repos.reports.createTopic({
      id: 'rp_old',
      periodKey: '2026-10-23',
      title: '较早的专题',
      instruction: '旧要求',
      runId: 'rn_old',
      now,
    });
    h.ctx.repos.reports.markReady('rp_old', {
      content: '# 旧内容',
      sourceCount: 1,
      model: 'deepseek-flash',
      mode: 'max',
      now,
    });

    h.clock.advance(1_000);
    h.ctx.repos.reports.createTopic({
      id: 'rp_new',
      periodKey: '2026-10-24',
      title: '较新的专题',
      instruction: '新要求',
      runId: 'rn_new',
      now: h.clock.now(),
    });
    h.ctx.repos.reports.markReady('rp_new', {
      content: '# 新内容',
      sourceCount: 1,
      model: 'deepseek-flash',
      mode: 'max',
      now: h.clock.now(),
    });

    const list = await api<{ items: Array<{ id: string }> }>(app, 'GET', '/api/reports');
    expect(list.status).toBe(200);
    // 默认按 updated_at 倒序：刚更新的专题排在旧专题之前，不依赖 id 字典序。
    expect(list.body.data?.items.map((item) => item.id)).toEqual(['rp_new', 'rp_old']);

    const removed = await api<{ deleted: boolean }>(app, 'DELETE', '/api/reports/rp_old');
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ deleted: true });

    const after = await api<{ total: number; items: Array<{ id: string }> }>(
      app,
      'GET',
      '/api/reports',
    );
    expect(after.body.data).toMatchObject({ total: 1 });
    expect(after.body.data?.items.map((item) => item.id)).toEqual(['rp_new']);

    const detail = await api(app, 'GET', '/api/reports/rp_old');
    expect(detail.status).toBe(404);

    const again = await api(app, 'DELETE', '/api/reports/rp_old');
    expect(again.status).toBe(404);

    // 生成中的汇报正在被后台批次写入；允许删除会让收尾更新落到已消失的行上。
    h.ctx.repos.reports.createTopic({
      id: 'rp_generating',
      periodKey: '2026-10-25',
      title: '正在生成',
      instruction: '生成中',
      runId: 'rn_generating',
      now: h.clock.now(),
    });
    const blocked = await api(app, 'DELETE', '/api/reports/rp_generating');
    expect(blocked.status).toBe(409);
  });

  it('列表按周期筛选，未配置模型时发起返回 400', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    app = await startApp(h);

    const notReady = await api(app, 'POST', '/api/reports/update', {});
    expect(notReady.status).toBe(400);
    expect(notReady.body.error?.message).toBe('LLM_NOT_CONFIGURED');

    configure(h, fake.base);
    const run = h.ctx.services.reports.startPeriodUpdate(testCtx());
    await waitForIdle(h, run.id);

    const day = await api<{ total: number; items: Array<{ period: string }> }>(
      app,
      'GET',
      '/api/reports?period=day',
    );
    expect(day.status).toBe(200);
    expect(day.body.data?.total).toBe(1);
    expect(day.body.data?.items[0]?.period).toBe('day');

    const invalid = await api(app, 'GET', '/api/reports?period=century');
    expect(invalid.status).toBe(400);
  });
});
