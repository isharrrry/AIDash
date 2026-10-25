import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { taskCreateSchema } from '../src/shared/schemas.js';
import type { ReportRow, ReportRunRow } from '../src/server/repos/report-repo.js';
import type { ReportRepo } from '../src/server/repos/report-repo.js';
import type { AuditService } from '../src/server/services/audit-service.js';
import type { LlmService } from '../src/server/services/llm-service.js';
import { periodLabel, periodRange, periodRangeFromKey } from '../src/server/services/report-period.js';
import {
  ReportService,
  type ReportServiceDeps,
} from '../src/server/services/report-service.js';
import type { SettingsService } from '../src/server/services/settings-service.js';
import { createHarness, testCtx, type TestHarness } from './helpers.js';
import {
  CHANNEL,
  REPORT_CONTENT,
  configure,
  createRun,
  expectAppError,
  internals,
  makeService,
  seedCardRow,
  seedTaskRow,
  startFakeLlm,
  waitFor,
  waitForIdle,
  waitForRun,
  wrapReports,
  type FakeLlm,
  type ReportServiceInternals,
} from './fakes/report-fixtures.js';

let harness: TestHarness | null = null;
let fake: FakeLlm | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
  harness?.close();
  harness = null;
});

/**
 * 汇报运行期错误分支。
 *
 * 由 report-branches 按主题拆出：周期 key、启动校验、批次守卫、启动失败收尾、
 * 生成期取消/失败、标题与提示词、列表分页。断言保持原样，仅搬移分组。
 */

describe('周期工具：标签与 key 反推', () => {
  const now = new Date(2026, 9, 24, 12, 0, 0).getTime(); // 2026-10-24 周六

  it('periodLabel：六种周期与专题都有中文标签', () => {
    expect(periodLabel('day')).toBe('日报');
    expect(periodLabel('week')).toBe('周报');
    expect(periodLabel('month')).toBe('月报');
    expect(periodLabel('quarter')).toBe('季度报');
    expect(periodLabel('half')).toBe('半年报');
    expect(periodLabel('year')).toBe('年报');
    // topic 不在 REPORT_PERIODS 里，但 ReportPeriod 包含它，标签表也必须覆盖。
    expect(periodLabel('topic')).toBe('专题报');
  });

  it('periodRangeFromKey：日/年 key 反推窗口，非法 key 回退当前周期', () => {
    expect(periodRangeFromKey('day', '2026-06-03', now)).toEqual({
      period: 'day',
      key: '2026-06-03',
      label: '日报',
      start: new Date(2026, 5, 3).getTime(),
      end: new Date(2026, 5, 4).getTime(),
    });
    // 必须严格 `YYYY-MM-DD`；少补零的 key 回退到 fallbackNow 的当天。
    expect(periodRangeFromKey('day', '2026-6-3', now).key).toBe('2026-10-24');

    expect(periodRangeFromKey('year', '2024', now)).toEqual({
      period: 'year',
      key: '2024',
      label: '年报',
      start: new Date(2024, 0, 1).getTime(),
      end: new Date(2025, 0, 1).getTime(),
    });
    expect(periodRangeFromKey('year', '24', now).key).toBe('2026');
  });

  it('周 key：跨年按周四定年份，W53 合法，W00/W54 回退', () => {
    // 2025-12-29 是周一，它所在 ISO 周的周四是 2026-01-01，因此归属 2026-W01。
    const crossYear = new Date(2025, 11, 29, 12).getTime();
    const range = periodRange('week', crossYear);
    expect(range.key).toBe('2026-W01');
    expect(range.start).toBe(new Date(2025, 11, 29).getTime());
    expect(range.end).toBe(new Date(2026, 0, 5).getTime());
    expect(periodRangeFromKey('week', '2026-W01', now).start).toBe(
      new Date(2025, 11, 29).getTime(),
    );

    // 2026 年的周四落在 12-31，全年 53 周；第 53 周从 12-28（周一）开始。
    expect(periodRangeFromKey('week', '2026-W53', now).start).toBe(
      new Date(2026, 11, 28).getTime(),
    );
    // 越界周号不应抛错，也不应造出非法日期，而是回退当前周（2026-W43）。
    expect(periodRangeFromKey('week', '2026-W00', now).key).toBe('2026-W43');
    expect(periodRangeFromKey('week', '2026-W54', now).key).toBe('2026-W43');
    // 格式不对（少补零 / 不是 key）同样走回退，而不是静默解析成 NaN 日期。
    expect(periodRangeFromKey('week', '2026-W4', now).key).toBe('2026-W43');
    expect(periodRangeFromKey('week', '第43周', now).key).toBe('2026-W43');
  });

  it('月/季/半年：合法 key 边界正确，越界或格式不符时回退', () => {
    expect(periodRangeFromKey('month', '2026-06', now)).toMatchObject({
      start: new Date(2026, 5, 1).getTime(),
      end: new Date(2026, 6, 1).getTime(),
    });
    expect(periodRangeFromKey('month', '2026-6', now).key).toBe('2026-10');

    expect(periodRangeFromKey('quarter', '2026-Q2', now)).toMatchObject({
      start: new Date(2026, 3, 1).getTime(),
      end: new Date(2026, 6, 1).getTime(),
    });
    expect(periodRangeFromKey('quarter', '2026-Q5', now).key).toBe('2026-Q4');

    expect(periodRangeFromKey('half', '2026-H2', now)).toMatchObject({
      start: new Date(2026, 6, 1).getTime(),
      end: new Date(2027, 0, 1).getTime(),
    });
    expect(periodRangeFromKey('half', '2026-H3', now).key).toBe('2026-H2');
  });
});

/* ================================================================== *
 * 入参校验
 * ================================================================== */

describe('startTopic：入参校验', () => {
  it('空要求 → PARAM_REQUIRED，且不留下批次', () => {
    const h = createHarness();
    harness = h;
    // 校验发生在 assertReady 之前：模型没配置也应当先报“要求不能为空”。
    const error = expectAppError(
      () => h.ctx.services.reports.startTopic({ instruction: '   ' }, testCtx()),
      'INVALID_ARGUMENT',
      'PARAM_REQUIRED',
    );
    expect(error.details).toEqual({ key: 'instruction' });
    expect(h.ctx.services.reports.status().runs).toHaveLength(0);
  });

  it('超长要求 → PARAM_TOO_LONG，并带上上限', () => {
    const h = createHarness();
    harness = h;
    const error = expectAppError(
      () =>
        h.ctx.services.reports.startTopic({ instruction: 'x'.repeat(4_001) }, testCtx()),
      'INVALID_ARGUMENT',
      'PARAM_TOO_LONG',
    );
    expect(error.details).toEqual({ key: 'instruction', max: 4_000 });
  });

  it('目标超过 10 条 → PARAM_OUT_OF_RANGE，在查库之前就拒绝', () => {
    const h = createHarness();
    harness = h;
    configure(h);
    const ids = Array.from({ length: 11 }, (_, index) => `rp_${index}`);
    const error = expectAppError(
      () => h.ctx.services.reports.startTopic({ instruction: '写一份复盘', targetReportIds: ids }, testCtx()),
      'INVALID_ARGUMENT',
      'PARAM_OUT_OF_RANGE',
    );
    expect(error.details).toEqual({ key: 'target_report_ids', max: 10 });
  });

  it('目标不存在 → NOT_FOUND；目标正在生成 → CONFLICT', () => {
    const h = createHarness();
    harness = h;
    configure(h);

    const missing = expectAppError(
      () =>
        h.ctx.services.reports.startTopic(
          { instruction: '重写', targetReportIds: ['rp_missing'] },
          testCtx(),
        ),
      'NOT_FOUND',
      'REPORT_NOT_FOUND',
    );
    expect(missing.details).toEqual({ report_id: 'rp_missing' });

    const now = h.clock.now();
    h.ctx.repos.reports.beginPeriod({
      id: 'rp_generating_target',
      period: 'month',
      periodKey: '2026-01',
      title: '月报 · 2026-01',
      runId: 'rn_seed',
      now,
    });
    const conflict = expectAppError(
      () =>
        h.ctx.services.reports.startTopic(
          { instruction: '重写', targetReportIds: ['rp_generating_target'] },
          testCtx(),
        ),
      'CONFLICT',
      'REPORT_GENERATING',
    );
    expect(conflict.details).toEqual({ report_id: 'rp_generating_target' });
  });
});

/* ================================================================== *
 * 取消与重启收尸
 * ================================================================== */

describe('批次状态守卫', () => {
  it('cancel：未知批次 NOT_FOUND，已结束批次 CONFLICT', () => {
    const h = createHarness();
    harness = h;
    const service = h.ctx.services.reports;

    expectAppError(() => service.cancel('rn_missing', testCtx()), 'NOT_FOUND', 'REPORT_RUN_NOT_FOUND');

    createRun(h, 'rn_already_done');
    h.ctx.repos.reports.finishRun('rn_already_done', 'done', null, h.clock.now());
    const error = expectAppError(
      () => service.cancel('rn_already_done', testCtx()),
      'CONFLICT',
      'REPORT_RUN_FINISHED',
    );
    expect(error.details).toMatchObject({ run_id: 'rn_already_done', status: 'done' });
  });

  it('cancel：当前进程没有控制器时直接收尾，不会永远停在“取消中”', () => {
    const h = createHarness();
    harness = h;
    createRun(h, 'rn_orphan');

    // 这个批次不是本进程启动的（比如测试/异常残留），controllers 里没有它。
    const view = h.ctx.services.reports.cancel('rn_orphan', testCtx());
    expect(view.cancel_requested).toBe(true);
    expect(h.ctx.repos.reports.getRun('rn_orphan')).toMatchObject({
      status: 'cancelled',
      error_message: null,
    });
  });

  it('recover：没有遗留 running 批次时返回 0', () => {
    const h = createHarness();
    harness = h;
    expect(h.ctx.services.reports.recover()).toBe(0);
    expect(h.ctx.services.reports.status()).toMatchObject({ running: null, runs: [] });
  });
});

/* ================================================================== *
 * 启动阶段失败收尾
 * ================================================================== */

describe('启动阶段失败收尾', () => {
  it('startTopic：专题落库失败时批次回落 failed，不留 running 闸门', () => {
    const h = createHarness();
    harness = h;
    configure(h);
    const reports = wrapReports(h.ctx.repos.reports, {
      createTopic: () => {
        throw new AppError('INTERNAL', 'TOPIC_INSERT_FAILED');
      },
    });
    const service = makeService(h, { reports });

    const error = expectAppError(
      () => service.startTopic({ instruction: '写一份专题' }, testCtx()),
      'INTERNAL',
      'TOPIC_INSERT_FAILED',
    );
    expect(error).toBeInstanceOf(AppError);
    // 原始错误必须原样抛给调用方；批次则收尾为 failed，闸门释放。
    expect(h.ctx.repos.reports.findRunning()).toBeUndefined();
    const runs = h.ctx.repos.reports.listRuns(10);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', error_message: 'report_start_failed' });
  });

  it('startPeriodUpdate：启动审计抛错时批次回落 failed，并抛回原错误', () => {
    const h = createHarness();
    harness = h;
    configure(h);
    const audit = {
      record: () => {
        throw new AppError('INTERNAL', 'AUDIT_DOWN');
      },
    } as unknown as AuditService;
    const service = makeService(h, { audit });

    const error = expectAppError(
      () => service.startPeriodUpdate(testCtx()),
      'INTERNAL',
      'AUDIT_DOWN',
    );
    expect(error).toBeInstanceOf(AppError);
    expect(h.ctx.repos.reports.findRunning()).toBeUndefined();
    expect(h.ctx.repos.reports.listRuns(10)[0]).toMatchObject({
      status: 'failed',
      error_message: 'report_start_failed',
    });
  });

  it('后台任务异常时 kick 兜底把批次标 failed，不永远停在 running', async () => {
    const h = createHarness();
    harness = h;
    configure(h);
    const reports = wrapReports(h.ctx.repos.reports, {
      // 模拟“批次刚启动，仓储查询就坏了”：异常在 try 之外，只能由 kick 兜底。
      isCancelRequested: () => {
        throw new Error('db gone');
      },
    });
    const service = makeService(h, { reports });
    const run = service.startPeriodUpdate(testCtx());

    const finished = await waitForRun(h, run.id, ['failed']);
    expect(finished.error_message).toBe('report_internal_error');
    expect(service.status().running).toBeNull();
    // 第一轮就崩了，不应该留下任何 generating 汇报。
    expect(h.ctx.repos.reports.list({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it('finishSafely：failed 带默认原因，cancelled 与 failed 分开落库', () => {
    const h = createHarness();
    harness = h;
    const now = h.clock.now();
    createRun(h, 'rn_safe_failed');
    createRun(h, 'rn_safe_cancelled');
    // 两个批次各挂一条 generating 汇报：这是 “report 行” 分支的观测点。
    h.ctx.repos.reports.beginPeriod({
      id: 'rp_safe_failed',
      period: 'day',
      periodKey: '2026-01-01',
      title: '日报 · 2026-01-01',
      runId: 'rn_safe_failed',
      now,
    });
    // 周期汇报有 (kind, period, period_key) 唯一索引，换一个 key 才不会复用上一行。
    h.ctx.repos.reports.beginPeriod({
      id: 'rp_safe_cancelled',
      period: 'day',
      periodKey: '2026-01-02',
      title: '日报 · 2026-01-02',
      runId: 'rn_safe_cancelled',
      now,
    });

    const internal = internals(h.ctx.services.reports);
    internal.finishSafely('rn_safe_failed', 'failed', null);
    internal.finishSafely('rn_safe_cancelled', 'cancelled', null);

    // message 为空时，汇报行必须留下默认原因，不能把故障伪装成“无原因失败”。
    expect(h.ctx.repos.reports.get('rp_safe_failed')).toMatchObject({
      status: 'failed',
      error_message: 'report_internal_error',
    });
    expect(h.ctx.repos.reports.getRun('rn_safe_failed')?.status).toBe('failed');
    // cancelled 走另一条 UPDATE：汇报标已取消且清空错误信息，不能被记成故障。
    expect(h.ctx.repos.reports.get('rp_safe_cancelled')).toMatchObject({
      status: 'cancelled',
      error_message: null,
    });
    expect(h.ctx.repos.reports.getRun('rn_safe_cancelled')).toMatchObject({
      status: 'cancelled',
      error_message: null,
    });
  });

  it('批次开始时已带取消标记：周期批次直接收尾，不创建汇报', async () => {
    const h = createHarness();
    harness = h;
    createRun(h, 'rn_pre_cancelled');
    h.ctx.repos.reports.requestCancel('rn_pre_cancelled');

    const run = h.ctx.repos.reports.getRun('rn_pre_cancelled')!;
    await internals(h.ctx.services.reports).executePeriod(run, new AbortController().signal);

    expect(h.ctx.repos.reports.getRun('rn_pre_cancelled')).toMatchObject({
      status: 'cancelled',
    });
    expect(h.ctx.repos.reports.list({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it('批次开始时已带取消标记：专题批次不误标“尚未开始”的汇报', async () => {
    const h = createHarness();
    harness = h;
    const now = h.clock.now();
    h.ctx.repos.reports.createTopic({
      id: 'rp_topic_untouched',
      periodKey: '2026-01-01',
      title: '专题 · 未开始',
      instruction: '旧要求',
      runId: 'rn_old',
      now,
    });
    h.ctx.repos.reports.markReady('rp_topic_untouched', {
      content: '# 旧内容',
      sourceCount: 1,
      model: 'fake',
      mode: 'max',
      now,
    });
    createRun(h, 'rn_topic_pre_cancelled', { kind: 'topic', total: 1 });
    h.ctx.repos.reports.requestCancel('rn_topic_pre_cancelled');

    const run = h.ctx.repos.reports.getRun('rn_topic_pre_cancelled')!;
    const row = h.ctx.repos.reports.get('rp_topic_untouched')!;
    await internals(h.ctx.services.reports).executeTopic(
      run,
      [{ row, instruction: '重写' }],
      '重写',
      new AbortController().signal,
    );

    expect(h.ctx.repos.reports.getRun('rn_topic_pre_cancelled')).toMatchObject({
      status: 'cancelled',
    });
    // 关键行为：还没轮到的那条保持 ready，而不是被 run 级取消扫成 cancelled。
    expect(h.ctx.repos.reports.get('rp_topic_untouched')?.status).toBe('ready');
  });
});

/* ================================================================== *
 * 生成过程中的取消与失败
 * ================================================================== */

describe('生成期取消与失败', () => {
  it('周期：模型返回后才发现取消标记，不写半成品', async () => {
    fake = await startFakeLlm(1_000);
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const run = h.ctx.services.reports.startPeriodUpdate(testCtx());
    await waitFor(() => fake!.requests.length >= 1);
    // 只置 DB 标记、不 abort：模拟“取消按钮与模型返回擦肩而过”的时序。
    h.ctx.repos.reports.requestCancel(run.id);

    const finished = await waitForIdle(h, run.id);
    expect(finished.status).toBe('cancelled');
    const list = h.ctx.services.reports.list({ kind: 'period', page_size: 20 });
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      period: 'day',
      status: 'cancelled',
      content_md: null,
    });
  });

  it('专题：模型返回后发现取消标记，当前汇报标 cancelled 且不写内容', async () => {
    fake = await startFakeLlm(1_000);
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const now = h.clock.now();
    h.ctx.repos.reports.beginPeriod({
      id: 'rp_month_empty',
      period: 'month',
      periodKey: '2026-01',
      title: '月报 · 2026-01',
      runId: 'rn_seed',
      now,
    });
    h.ctx.repos.reports.markFailed('rp_month_empty', 'seed_failed', now);

    const run = h.ctx.services.reports.startTopic(
      { instruction: '重写这份月报', targetReportIds: ['rp_month_empty'] },
      testCtx(),
    );
    await waitFor(() => fake!.requests.length >= 1);
    h.ctx.repos.reports.requestCancel(run.id);

    const finished = await waitForIdle(h, run.id);
    expect(finished.status).toBe('cancelled');
    // 提示词取的是那一期的自然窗口，且说明“尚未生成”，避免模型拿旧稿当底稿。
    const prompt = fake.requests.at(-1)?.user ?? '';
    expect(prompt).toContain('要更新的已有汇报：月报 · 2026-01（2026-01）');
    expect(prompt).toContain('当前内容：（尚未生成）');
    expect(prompt).toContain('2026-01');
    expect(h.ctx.services.reports.get('rp_month_empty')).toMatchObject({
      status: 'cancelled',
      content_md: null,
    });
  });

  it('周期：模型失败时当前汇报 failed，后续周期不再生成', async () => {
    fake = await startFakeLlm();
    fake.failFrom = 1;
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const run = h.ctx.services.reports.startPeriodUpdate(testCtx());
    const finished = await waitForIdle(h, run.id);

    expect(finished).toMatchObject({
      status: 'failed',
      error_message: 'LLM_HTTP_ERROR',
      completed: 0,
    });
    const list = h.ctx.services.reports.list({ kind: 'period', page_size: 20 });
    // 第一个周期失败即终止，不应继续创建周报/月报。
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      period: 'day',
      status: 'failed',
      error_message: 'LLM_HTTP_ERROR',
    });
    expect(h.ctx.services.reports.status().running).toBeNull();
  });

  it('非 AppError 的模型异常收敛为 report_generation_failed', async () => {
    const h = createHarness();
    harness = h;
    const llm = {
      isConfigured: () => true,
      prompt: () => '系统提示',
      chat: async () => {
        throw new Error('boom');
      },
    } as unknown as LlmService;
    const service = makeService(h, { llm });

    const run = service.startPeriodUpdate(testCtx());
    const finished = await waitForRun(h, run.id, ['failed']);
    expect(finished.error_message).toBe('report_generation_failed');

    const day = periodRange('day', h.clock.now());
    expect(h.ctx.repos.reports.findPeriod('day', day.key)).toMatchObject({
      status: 'failed',
      error_message: 'report_generation_failed',
    });
  });

  it('专题：设置里模型名为空时 model 同样回落 unknown', async () => {
    const h = createHarness();
    harness = h;
    const llm = {
      isConfigured: () => true,
      prompt: () => '系统提示',
      chat: async () => '# 专题内容',
    } as unknown as LlmService;
    const settings = {
      current: () => ({
        llmEndpoint: 'http://127.0.0.1:9/v1',
        llmModel: null,
        llmApiKey: 'sk-test',
        llmMode: 'standard',
        prompts: { report: '系统提示' },
        enrichmentTimeoutMs: 5_000,
      }),
    } as unknown as SettingsService;
    const service = makeService(h, { llm, settings });

    const run = service.startTopic({ instruction: '写一份专题' }, testCtx());
    await waitForRun(h, run.id, ['done']);

    // 档位仍按设置落库，模型名缺失才回落 unknown。
    expect(service.list({ kind: 'topic', page_size: 5 }).items[0]).toMatchObject({
      status: 'ready',
      model: 'unknown',
      mode: 'standard',
    });
  });

  it('设置里模型名为空时 model 回落 unknown', async () => {
    const h = createHarness();
    harness = h;
    const llm = {
      isConfigured: () => true,
      prompt: () => '系统提示',
      chat: async () => '# 生成内容',
    } as unknown as LlmService;
    const settings = {
      current: () => ({
        llmEndpoint: 'http://127.0.0.1:9/v1',
        llmModel: null,
        llmApiKey: 'sk-test',
        llmMode: 'max',
        prompts: { report: '系统提示' },
        enrichmentTimeoutMs: 5_000,
      }),
    } as unknown as SettingsService;
    const service = makeService(h, { llm, settings });

    const run = service.startPeriodUpdate(testCtx());
    await waitForRun(h, run.id, ['done']);

    const list = service.list({ kind: 'period', page_size: 20 });
    expect(list.total).toBe(6);
    for (const item of list.items) {
      expect(item.status).toBe('ready');
      expect(item.model).toBe('unknown');
    }
  });
});

/* ================================================================== *
 * 专题标题与目标提示词
 * ================================================================== */

describe('专题标题与目标提示词', () => {
  it('缺省标题取要求首行；超长标题截断到 200 字', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const first = h.ctx.services.reports.startTopic(
      { instruction: '第一行标题\n第二行正文' },
      testCtx(),
    );
    await waitForIdle(h, first.id);
    expect(
      h.ctx.services.reports.list({ kind: 'topic', page_size: 20 }).items.map((item) => item.title),
    ).toContain('专题 · 第一行标题');

    const longTopic = 'x'.repeat(250);
    const second = h.ctx.services.reports.startTopic(
      { topic: longTopic, instruction: '按这个主题写' },
      testCtx(),
    );
    await waitForIdle(h, second.id);
    const longReport = h.ctx.services.reports
      .list({ kind: 'topic', page_size: 20 })
      .items.find((item) => item.title.startsWith('专题 · x'));
    expect(longReport?.title).toBe(`专题 · ${'x'.repeat(200)}…`);
  });

  it('批次进行中目标汇报被删掉时，批次明确失败而不是静默成功', async () => {
    fake = await startFakeLlm(500);
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const now = h.clock.now();
    for (const id of ['rp_kept', 'rp_deleted']) {
      h.ctx.repos.reports.createTopic({
        id,
        periodKey: '2026-01-01',
        title: `专题 · ${id}`,
        instruction: '旧要求',
        runId: 'rn_seed',
        now,
      });
      h.ctx.repos.reports.markReady(id, {
        content: '# 旧内容',
        sourceCount: 1,
        model: 'fake',
        mode: 'max',
        now,
      });
    }

    const run = h.ctx.services.reports.startTopic(
      { instruction: '并行重写两条', targetReportIds: ['rp_kept', 'rp_deleted'] },
      testCtx(),
    );
    // 第一条还在模型里时删掉第二条：等轮到它时 get() 已是 undefined。
    // 必须明确失败：若退回启动快照，beginExisting/markReady 会更新 0 行，
    // 批次却按 completed 递增收尾为 done，用户会看到一次“静默成功”。
    await waitFor(() => fake!.requests.length >= 1);
    expect(h.ctx.repos.reports.delete('rp_deleted')).toBe(1);

    const finished = await waitForIdle(h, run.id);
    expect(finished).toMatchObject({
      status: 'failed',
      completed: 1,
      error_message: 'report_not_found:rp_deleted',
    });
    expect(h.ctx.repos.reports.get('rp_kept')?.status).toBe('ready');
    expect(h.ctx.repos.reports.get('rp_deleted')).toBeUndefined();
  });

  it('更新已有专题汇报时，把旧内容带进提示词', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const now = h.clock.now();
    h.ctx.repos.reports.createTopic({
      id: 'rp_topic_old',
      periodKey: '2026-01-01',
      title: '专题 · 旧专题',
      instruction: '旧要求',
      runId: 'rn_seed',
      now,
    });
    h.ctx.repos.reports.markReady('rp_topic_old', {
      content: '# 旧专题内容\n- 旧要点',
      sourceCount: 2,
      model: 'fake',
      mode: 'max',
      now,
    });

    const run = h.ctx.services.reports.startTopic(
      { instruction: '按新结构重写', targetReportIds: ['rp_topic_old'] },
      testCtx(),
    );
    const finished = await waitForIdle(h, run.id);
    expect(finished.status).toBe('done');

    const prompt = fake.requests.at(-1)?.user ?? '';
    expect(prompt).toContain('已有专题汇报（在此基础上改写）');
    expect(prompt).toContain('标题：专题 · 旧专题');
    expect(prompt).toContain('当前内容：');
    expect(prompt).toContain('# 旧专题内容');
    expect(prompt).toContain('按新结构重写');

    // 覆盖式更新：ID/标题不变，要求落库，正文换成新生成的内容。
    expect(h.ctx.services.reports.get('rp_topic_old')).toMatchObject({
      status: 'ready',
      title: '专题 · 旧专题',
      instruction_md: '按新结构重写',
      content_md: REPORT_CONTENT,
    });
  });
});

/* ================================================================== *
 * 列表分页
 * ================================================================== */

describe('列表分页边界', () => {
  it('页码/页大小夹紧且 has_more 正确', () => {
    const h = createHarness();
    harness = h;
    const now = h.clock.now();
    h.ctx.repos.reports.createTopic({
      id: 'rp_page_a',
      periodKey: '2026-01-01',
      title: '较早',
      instruction: 'a',
      runId: 'rn_a',
      now,
    });
    h.clock.advance(1_000);
    h.ctx.repos.reports.createTopic({
      id: 'rp_page_b',
      periodKey: '2026-01-02',
      title: '较新',
      instruction: 'b',
      runId: 'rn_b',
      now: h.clock.now(),
    });
    const service = h.ctx.services.reports;

    // 不传 page/page_size：默认 1/20。
    expect(service.list({})).toMatchObject({
      page: 1,
      page_size: 20,
      total: 2,
      has_more: false,
    });

    // 0 会被夹到 1；page_size 0 会被夹到 1。
    const tiny = service.list({ page: 0, page_size: 0 });
    expect(tiny).toMatchObject({ page: 1, page_size: 1, total: 2, has_more: true });
    expect(tiny.items.map((item) => item.id)).toEqual(['rp_page_b']);

    // 上限 50。
    expect(service.list({ page_size: 999 }).page_size).toBe(50);

    // 越界页：空数组且 has_more=false（不应因为 total>0 就误报还有下一页）。
    const beyond = service.list({ page: 5, page_size: 1 });
    expect(beyond.items).toHaveLength(0);
    expect(beyond.has_more).toBe(false);

    // 过滤条件是 AND：kind=topic 时按 month 过滤必然为空。
    expect(service.list({ kind: 'topic' }).total).toBe(2);
    expect(service.list({ period: 'month' }).total).toBe(0);
  });
});

/* ================================================================== *
 * 素材收集
 * ================================================================== */

