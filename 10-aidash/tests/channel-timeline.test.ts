import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { cardPostSchema, taskCreateSchema } from '../src/shared/schemas.js';
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

const CHANNEL = 'devhost/myproj/timeline';

let harness: TestHarness | null = null;
let app: RunningApp | null = null;

async function boot(): Promise<{ h: TestHarness; a: RunningApp }> {
  harness = createHarness();
  app = await startApp(harness);
  return { h: harness, a: app };
}

afterEach(async () => {
  if (app) await app.close();
  harness?.close();
  app = null;
  harness = null;
});

function registerHarness(h: TestHarness, id = 'h-timeline'): void {
  h.ctx.repos.harnesses.upsert({
    harness_id: id,
    name: id,
    host: null,
    capabilities_json: null,
    now: h.clock.now(),
  });
}

async function callMcp(
  a: RunningApp,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await mcp(a, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return mcpToolData(result);
}

describe('通道工作路径与任务计数', () => {
  it('channel.upsert 写入/更正 workdir，列表返回 workdir 与任务计数', async () => {
    const { a } = await boot();
    const channelKey = 'devhost/proj-x/topic-one';

    const created = (await callMcp(a, 'channel.upsert', {
      channel_key: channelKey,
      title: '项目 X',
      workdir: 'F:/repos/proj-x',
    })) as { created: boolean };
    expect(created.created).toBe(true);

    // 再次 upsert 只带新 workdir：已有通道应被更正，而不是被忽略或清空。
    await callMcp(a, 'channel.upsert', {
      channel_key: channelKey,
      workdir: 'F:/repos/proj-x-v2',
    });

    // 一个待认领任务（算 open） + 一个草稿（不算 open），用来验证两种计数口径。
    await api(a, 'POST', '/api/tasks', { channel_key: channelKey, title: '待办', submit: true });
    await api(a, 'POST', '/api/tasks', { channel_key: channelKey, title: '草稿' });

    const list = await api<{
      items: Array<{
        channel_key: string;
        workdir: string | null;
        task_count: number;
        open_task_count: number;
      }>;
    }>(a, 'GET', '/api/channels?q=proj-x');
    const row = list.body.data?.items.find((item) => item.channel_key === channelKey);
    expect(row?.workdir).toBe('F:/repos/proj-x-v2');
    expect(row?.task_count).toBe(2);
    expect(row?.open_task_count).toBe(1);

    // 建任务/发卡走的 ensure 不能把已登记的工作路径清空。
    await api(a, 'POST', '/api/cards', {
      channel_key: channelKey,
      type: 'info',
      title: '不带头',
      body_md: '正文',
      severity: 'info',
    });
    const again = await api<{ items: Array<{ workdir: string | null }> }>(
      a,
      'GET',
      '/api/channels?q=proj-x',
    );
    expect(again.body.data?.items[0]?.workdir).toBe('F:/repos/proj-x-v2');
  });

  it('REST 建通道同样接受 workdir', async () => {
    const { a } = await boot();
    const created = await api<{ channel: { workdir: string | null } }>(a, 'POST', '/api/channels', {
      channel_key: 'devhost/proj-r/topic',
      workdir: '/srv/repos/proj-r',
    });
    expect(created.status).toBe(201);
    expect(created.body.data?.channel.workdir).toBe('/srv/repos/proj-r');
  });
});

describe('任务状态时间线', () => {
  it('claim → start → block → unblock → complete 每步都留下时间', () => {
    const h = createHarness();
    harness = h;
    registerHarness(h);

    const task = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '修白名单' }),
      testCtx(),
      { submit: true },
    ).task;

    const claim = h.ctx.services.tasks.claim(
      { task_id: task.id, harness_id: 'h-timeline' },
      testCtx(),
    );
    expect(claim.task.claimed_at).not.toBeNull();

    h.clock.advance(1_000);
    const started = h.ctx.services.tasks.update(
      { task_id: task.id, event: 'start', claim_token: claim.claim_token },
      testCtx(),
    );
    expect(started.started_at).not.toBeNull();

    h.clock.advance(1_000);
    const blocked = h.ctx.services.tasks.update(
      {
        task_id: task.id,
        event: 'block',
        claim_token: claim.claim_token,
        reason: '等运维确认',
      },
      testCtx(),
    );
    expect(blocked.blocked_at).not.toBeNull();
    expect(blocked.blocked_reason).toBe('等运维确认');

    const unblocked = h.ctx.services.tasks.update(
      { task_id: task.id, event: 'unblock', claim_token: claim.claim_token },
      testCtx(),
    );
    expect(unblocked.status).toBe('in_progress');
    // 解除阻塞不清空历史时间，页面才能算“第一次阻塞发生在何时”。
    expect(unblocked.blocked_at).toBe(blocked.blocked_at);

    h.ctx.services.cards.post(
      cardPostSchema.parse({
        channel_key: CHANNEL,
        type: 'status',
        task_id: task.id,
        summary: '白名单已放行',
        result: 'success',
      }) as CardPostInput,
      testCtx(),
    );
    const done = h.ctx.services.tasks.update(
      { task_id: task.id, event: 'complete', claim_token: claim.claim_token },
      testCtx(),
    );
    expect(done.completed_at).not.toBeNull();

    // 视图之外再确认落库：列表接口直接读这些列，不能只有返回值好看。
    const row = h.ctx.repos.tasks.get(task.id)!;
    expect(row.claimed_at).not.toBeNull();
    expect(row.started_at).not.toBeNull();
    expect(row.blocked_at).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
  });

  it('release 与租约过期只退回 pending，不抹掉 started_at', () => {
    const h = createHarness();
    harness = h;
    registerHarness(h);

    const released = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '主动释放' }),
      testCtx(),
      { submit: true },
    ).task;
    const firstClaim = h.ctx.services.tasks.claim(
      { task_id: released.id, harness_id: 'h-timeline' },
      testCtx(),
    );
    const startedAt = h.ctx.services.tasks.update(
      { task_id: released.id, event: 'start', claim_token: firstClaim.claim_token },
      testCtx(),
    ).started_at;
    expect(startedAt).not.toBeNull();

    const afterRelease = h.ctx.services.tasks.release(
      { task_id: released.id, claim_token: firstClaim.claim_token },
      testCtx(),
    );
    expect(afterRelease.status).toBe('pending');
    // 释放只表示“现在没人干”，历史开工时间要留着，否则 Web 时间线会缺一段。
    expect(afterRelease.started_at).toBe(startedAt);

    const expired = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '租约到期' }),
      testCtx(),
      { submit: true },
    ).task;
    const secondClaim = h.ctx.services.tasks.claim(
      { task_id: expired.id, harness_id: 'h-timeline', lease_seconds: 1 },
      testCtx(),
    );
    const expiredStartedAt = h.ctx.services.tasks.update(
      { task_id: expired.id, event: 'start', claim_token: secondClaim.claim_token },
      testCtx(),
    ).started_at;

    h.clock.advance(5_000);
    const reclaimed = h.ctx.repos.tasks.expireLeases(h.clock.now());
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    // 同一道理：被回收不等于从未开工，否则用户会误以为这个任务一直没人碰。
    expect(h.ctx.repos.tasks.get(expired.id)?.started_at).not.toBeNull();
    expect(h.ctx.repos.tasks.get(expired.id)?.started_at).toBe(
      Date.parse(expiredStartedAt as string),
    );
  });

  it('cancel 不经过 claim 也写 cancelled_at', () => {
    const h = createHarness();
    harness = h;
    const task = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '还没人认领就要撤' }),
      testCtx(),
      { submit: true },
    ).task;

    // pending 取消不需要令牌；这条路径没有 claim，绝不能依赖 claim 时写入时间。
    // 从 003 起取消也必须写原因：终态不能只剩一个状态词。
    const cancelled = h.ctx.services.tasks.update(
      { task_id: task.id, event: 'cancel', reason: '需求取消，不再做' },
      testCtx(),
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelled_at).not.toBeNull();
    expect(cancelled.cancel_reason).toBe('需求取消，不再做');
    expect(h.ctx.repos.tasks.get(task.id)?.cancelled_at).not.toBeNull();
    expect(h.ctx.repos.tasks.get(task.id)?.cancel_reason).toBe('需求取消，不再做');
  });

  it('cancel 缺少原因会被拒绝，补上原因后才落库', () => {
    const h = createHarness();
    harness = h;
    const task = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '重复任务' }),
      testCtx(),
      { submit: true },
    ).task;

    // 不写原因时必须停在 cancelled 之前：否则看板上会出现一个无法解释的终态。
    let code = '';
    try {
      h.ctx.services.tasks.update({ task_id: task.id, event: 'cancel' }, testCtx());
    } catch (error) {
      if (error instanceof AppError) code = error.code;
    }
    expect(code).toBe('INVALID_ARGUMENT');
    expect(h.ctx.repos.tasks.get(task.id)?.status).toBe('pending');

    const cancelled = h.ctx.services.tasks.update(
      { task_id: task.id, event: 'cancel', reason: '重复任务，已并入父任务' },
      testCtx(),
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancel_reason).toBe('重复任务，已并入父任务');
  });
});
