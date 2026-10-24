import { describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { cardPostSchema, taskCreateSchema, taskUpdateSchema } from '../src/shared/schemas.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import {
  api,
  createHarness,
  mcp,
  mcpToolData,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

const CHANNEL = 'devhost/risk/topic';
const HARNESS_ID = 'h-risk';
let rpcId = 0;

/**
 * 隐患标记回归。
 *
 * 这组用例守的是三条设计约定：
 * 1. 隐患是覆盖层，不是新状态——任务可能已经 done，标记不能改 status；
 * 2. 标记必须写清“留了什么坑”，解除可以不写，但解除不删除原文；
 * 3. 已解除的隐患仍能被 has_risk 筛出来，供复盘统计“当时带病交付了几次”。
 */
function boot(): TestHarness {
  return createHarness();
}

function registerHarness(h: TestHarness): void {
  h.ctx.repos.harnesses.upsert({
    harness_id: HARNESS_ID,
    name: HARNESS_ID,
    host: null,
    capabilities_json: null,
    now: h.clock.now(),
  });
}

function createTask(h: TestHarness, submit = true) {
  return h.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: CHANNEL, title: '隐患测试任务' }),
    testCtx(),
    { submit },
  ).task;
}

function update(h: TestHarness, body: Record<string, unknown>) {
  return h.ctx.services.tasks.update(taskUpdateSchema.parse(body), testCtx());
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected AppError ${code}, but nothing was thrown`);
}

async function callTool(
  app: RunningApp,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const payload = await mcp(app, {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return mcpToolData(payload);
}

function riskEvents(h: TestHarness, taskId: string) {
  return h.db
    .prepare(
      `SELECT event, detail_json
         FROM task_event
        WHERE task_id = ? AND event IN ('risk_flagged', 'risk_unflagged')
        ORDER BY id`,
    )
    .all(taskId) as Array<{ event: string; detail_json: string | null }>;
}

describe('任务隐患标记', () => {
  it('待认领任务无需令牌即可标记，写原因与时间且不改状态', () => {
    const h = boot();
    try {
      const task = createTask(h);
      const flagged = update(h, {
        task_id: task.id,
        event: 'flag_risk',
        reason: '先跳过跨机验证，等有测试机再补',
      });

      expect(flagged.status).toBe('pending');
      expect(flagged.risk_note).toBe('先跳过跨机验证，等有测试机再补');
      expect(flagged.risk_flagged_at).not.toBeNull();
      expect(flagged.risk_resolved_at).toBeNull();
      expect(flagged.risk_resolution).toBeNull();

      const events = riskEvents(h, task.id);
      expect(events.map((event) => event.event)).toEqual(['risk_flagged']);
      expect(JSON.parse(events[0].detail_json ?? '{}')).toEqual({
        reason: '先跳过跨机验证，等有测试机再补',
      });
    } finally {
      h.close();
    }
  });

  it('标记必须写原因，空白原因被拒绝', () => {
    const h = boot();
    try {
      const task = createTask(h);
      expectCode(
        () => update(h, { task_id: task.id, event: 'flag_risk', reason: '   ' }),
        'INVALID_ARGUMENT',
      );
    } finally {
      h.close();
    }
  });

  it('已完成任务仍可补记隐患，且不需要 claim_token', () => {
    const h = boot();
    try {
      registerHarness(h);
      const task = createTask(h);
      const claim = h.ctx.services.tasks.claim(
        { task_id: task.id, harness_id: HARNESS_ID },
        testCtx(),
      );
      update(h, { task_id: task.id, event: 'start', claim_token: claim.claim_token });
      h.ctx.services.cards.post(
        cardPostSchema.parse({
          channel_key: CHANNEL,
          type: 'status',
          task_id: task.id,
          summary: '带病交付：日志轮转未验证',
          result: 'success',
        }) as CardPostInput,
        testCtx(),
      );
      const done = update(h, {
        task_id: task.id,
        event: 'complete',
        claim_token: claim.claim_token,
      });
      expect(done.status).toBe('done');

      // 关键：完成之后才发现的坑，也必须在终态上留得下来。
      const flagged = update(h, {
        task_id: task.id,
        event: 'flag_risk',
        reason: '日志轮转在 Windows 下未验证',
      });
      expect(flagged.status).toBe('done');
      expect(flagged.risk_note).toBe('日志轮转在 Windows 下未验证');
      expect(flagged.risk_resolved_at).toBeNull();
    } finally {
      h.close();
    }
  });

  it('解除隐患保留原文与原始标记时间，解除说明落事件；重复解除报冲突', () => {
    const h = boot();
    try {
      const task = createTask(h);
      const flagged = update(h, {
        task_id: task.id,
        event: 'flag_risk',
        reason: '并发压测没跑',
      });
      h.clock.advance(60_000);

      const resolved = update(h, {
        task_id: task.id,
        event: 'unflag_risk',
        reason: '压测已补跑，未发现连接泄漏',
      });

      // note 与 flagged_at 都要保留：复盘看的是“当时怎么判断的”，不是只剩一个已解除。
      expect(resolved.risk_note).toBe('并发压测没跑');
      expect(resolved.risk_flagged_at).toBe(flagged.risk_flagged_at);
      expect(resolved.risk_resolved_at).not.toBeNull();
      // 复盘结论落在任务行：Web 详情不查事件表也能直接展示。
      expect(resolved.risk_resolution).toBe('压测已补跑，未发现连接泄漏');

      const events = riskEvents(h, task.id);
      expect(events.map((event) => event.event)).toEqual(['risk_flagged', 'risk_unflagged']);
      expect(JSON.parse(events[1].detail_json ?? '{}')).toEqual({
        note: '并发压测没跑',
        resolution: '压测已补跑，未发现连接泄漏',
      });

      expectCode(
        () => update(h, { task_id: task.id, event: 'unflag_risk' }),
        'CONFLICT',
      );
    } finally {
      h.close();
    }
  });

  it('未标记就解除不会留下半成品状态', () => {
    const h = boot();
    try {
      const task = createTask(h);
      expectCode(
        () => update(h, { task_id: task.id, event: 'unflag_risk' }),
        'CONFLICT',
      );
      // 失败后任务仍是待认领，没被事件分流留下半成品。
      expect(h.ctx.services.tasks.get(task.id).status).toBe('pending');
    } finally {
      h.close();
    }
  });

  it('重新标记会重开隐患并清空解除时间', () => {
    const h = boot();
    try {
      const task = createTask(h);
      update(h, { task_id: task.id, event: 'flag_risk', reason: '旧隐患' });
      update(h, { task_id: task.id, event: 'unflag_risk' });
      h.clock.advance(1_000);

      const reopened = update(h, {
        task_id: task.id,
        event: 'flag_risk',
        reason: '同类问题再次出现',
      });
      expect(reopened.risk_note).toBe('同类问题再次出现');
      expect(reopened.risk_resolved_at).toBeNull();
      // 旧结论随旧风险一起清空，避免新隐患显示上一次的复盘。
      expect(reopened.risk_resolution).toBeNull();
    } finally {
      h.close();
    }
  });

  it('列表筛选：has_risk 含已解除，risk_open 只看未解除', () => {
    const h = boot();
    try {
      const open = createTask(h);
      const resolved = createTask(h);
      const clean = createTask(h);

      update(h, { task_id: open.id, event: 'flag_risk', reason: '未解除的隐患' });
      update(h, { task_id: resolved.id, event: 'flag_risk', reason: '已解除的隐患' });
      update(h, { task_id: resolved.id, event: 'unflag_risk' });

      const hasRisk = h.ctx.services.tasks.list({ channel_key: CHANNEL, has_risk: true });
      expect(new Set(hasRisk.items.map((item) => item.id))).toEqual(
        new Set([open.id, resolved.id]),
      );

      const riskOpen = h.ctx.services.tasks.list({ channel_key: CHANNEL, risk_open: true });
      expect(riskOpen.items.map((item) => item.id)).toEqual([open.id]);

      // 不做筛选时三条都在，说明筛选没有误伤普通任务。
      const all = h.ctx.services.tasks.list({ channel_key: CHANNEL });
      expect(new Set(all.items.map((item) => item.id))).toEqual(
        new Set([open.id, resolved.id, clean.id]),
      );
    } finally {
      h.close();
    }
  });

  it('任务取消不会清空隐患，带病完成的记录必须留到复盘', () => {
    const h = boot();
    try {
      const task = createTask(h);
      update(h, { task_id: task.id, event: 'flag_risk', reason: '取消前留下的风险' });

      const cancelled = update(h, {
        task_id: task.id,
        event: 'cancel',
        reason: '需求取消',
      });

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.defer_reason).toBeNull();
      // 与 defer 不同：终态清理不会抹掉隐患，否则历史复盘断档。
      expect(cancelled.risk_note).toBe('取消前留下的风险');
      expect(cancelled.risk_resolved_at).toBeNull();
    } finally {
      h.close();
    }
  });

  it('REST 列表缺省不筛隐患，risk_open 只返回未解除', async () => {
    const h = boot();
    const app = await startApp(h);
    try {
      const open = createTask(h);
      const resolved = createTask(h);
      const clean = createTask(h);
      update(h, { task_id: open.id, event: 'flag_risk', reason: '未解除' });
      update(h, { task_id: resolved.id, event: 'flag_risk', reason: '已解除' });
      update(h, { task_id: resolved.id, event: 'unflag_risk' });

      const base = `/api/tasks?channel_key=${encodeURIComponent(CHANNEL)}`;
      const all = await api(app, 'GET', base);
      expect(
        new Set(
          (all.body.data as { items: Array<{ id: string }> }).items.map((item) => item.id),
        ),
      ).toEqual(new Set([open.id, resolved.id, clean.id]));

      const riskOpen = await api(app, 'GET', `${base}&risk_open=true`);
      expect(
        (riskOpen.body.data as { items: Array<{ id: string }> }).items.map((item) => item.id),
      ).toEqual([open.id]);

      const hasRisk = await api(app, 'GET', `${base}&has_risk=true`);
      expect(
        new Set(
          (hasRisk.body.data as { items: Array<{ id: string }> }).items.map((item) => item.id),
        ),
      ).toEqual(new Set([open.id, resolved.id]));

      // 显式 false 才是“排除带隐患任务”，不能被缺省值误用。
      const cleanOnly = await api(app, 'GET', `${base}&has_risk=false`);
      expect(
        (cleanOnly.body.data as { items: Array<{ id: string }> }).items.map((item) => item.id),
      ).toEqual([clean.id]);
    } finally {
      await app.close();
      h.close();
    }
  });

  it('MCP 隐患复盘筛选在未指定 status 时包含终态任务', async () => {
    const h = boot();
    const app = await startApp(h);
    try {
      const task = createTask(h);
      update(h, { task_id: task.id, event: 'flag_risk', reason: '完成后才发现的问题' });
      update(h, { task_id: task.id, event: 'cancel', reason: '需求取消' });

      const data = (await callTool(app, 'task.list', {
        channel_key: CHANNEL,
        risk_open: true,
      })) as { items: Array<{ id: string }> };
      // 带隐患完成/取消的任务正是复盘的主要对象，默认终态过滤不能把它们藏掉。
      expect(data.items.map((item) => item.id)).toContain(task.id);
    } finally {
      await app.close();
      h.close();
    }
  });

  it('标记隐患与 patch 同次提交时两者都生效', () => {
    const h = boot();
    try {
      const task = createTask(h);
      const updated = update(h, {
        task_id: task.id,
        event: 'flag_risk',
        reason: '临时方案',
        patch: { title: '改过的标题', priority: 'P0' },
      });
      expect(updated.title).toBe('改过的标题');
      expect(updated.priority).toBe('P0');
      expect(updated.risk_note).toBe('临时方案');
    } finally {
      h.close();
    }
  });

  it('复制任务不会继承源任务的隐患历史', () => {
    const h = boot();
    try {
      const source = createTask(h);
      update(h, { task_id: source.id, event: 'flag_risk', reason: '源任务的隐患' });
      update(h, { task_id: source.id, event: 'unflag_risk', reason: '已补' });

      const copied = h.ctx.services.tasks.copy(source.id, null, testCtx());
      expect(copied.task.status).toBe('draft');
      expect(copied.task.risk_note).toBeNull();
      expect(copied.task.risk_flagged_at).toBeNull();
      expect(copied.task.risk_resolved_at).toBeNull();
      expect(copied.task.risk_resolution).toBeNull();
    } finally {
      h.close();
    }
  });
});
