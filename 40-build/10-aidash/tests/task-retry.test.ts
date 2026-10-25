import { describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { cardPostSchema, taskCreateSchema, taskUpdateSchema } from '../src/shared/schemas.js';
import type { TaskView } from '../src/shared/types.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import { createHarness, testCtx, type TestHarness } from './helpers.js';

const CHANNEL = 'devhost/retry/topic';
const HARNESS_ID = 'h-retry';

/**
 * 失败任务重新排队（retry）。
 *
 * 背景：用户误把 7 个任务标成 failed 后，产品没有 failed → pending 的出口。
 * 这组用例守四条约定：
 * 1. 只允许 failed → pending，done/cancelled 仍不可逆；
 * 2. 必须写理由，且不需要 claim_token（失败时令牌已清空）；
 * 3. 清掉失败原因与上一轮租约，但保留 started_at/claimed_at 作为“上次开工”历史；
 * 4. 事件与审计都留痕，事后能回答“谁在什么时候把哪个任务重新排了队”。
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

function createPending(h: TestHarness, title = '重新排队测试任务'): TaskView {
  return h.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: CHANNEL, title }),
    testCtx(),
    { submit: true },
  ).task;
}

function update(h: TestHarness, body: Record<string, unknown>): TaskView {
  return h.ctx.services.tasks.update(taskUpdateSchema.parse(body), testCtx());
}

function expectCode(fn: () => unknown, code: string): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected AppError ${code}, but nothing was thrown`);
}

/**
 * 走真实链路造一个 failed 任务：claim → start → fail。
 * 不直接改库：retry 的前置条件正是“任务真的经历过失败”，造数据也必须经过状态机。
 */
function createFailed(h: TestHarness): TaskView {
  registerHarness(h);
  const task = createPending(h);
  const claim = h.ctx.services.tasks.claim(
    { task_id: task.id, harness_id: HARNESS_ID },
    testCtx(),
  );
  update(h, { task_id: task.id, event: 'start', claim_token: claim.claim_token });
  return update(h, {
    task_id: task.id,
    event: 'fail',
    claim_token: claim.claim_token,
    reason: 'runner 误把任务标成失败',
  });
}

describe('失败任务重新排队（retry）', () => {
  it('failed 任务 retry 后回到 pending，清空失败/租约字段并保留开工时间', () => {
    const h = boot();
    try {
      h.clock.advance(1_000);
      const failed = createFailed(h);
      expect(failed.status).toBe('failed');
      // fail 是终态事件：令牌与租约时间已清空，但 claimed_by 仍记录上一轮执行者——
      // 这正是 retry 需要显式清掉的字段，否则回到 pending 的任务会看起来“已被人认领”。
      expect(failed.claimed_by).toBe(HARNESS_ID);
      expect(failed.claim_expires_at).toBeNull();
      expect(h.ctx.repos.tasks.get(failed.id)?.claim_token).toBeNull();
      const startedAt = failed.started_at;
      const claimedAt = failed.claimed_at;
      expect(startedAt).not.toBeNull();
      expect(claimedAt).not.toBeNull();

      h.clock.advance(60_000);
      // 不传 claim_token：failed 任务没有令牌，retry 也不应该要求它。
      const retried = update(h, {
        task_id: failed.id,
        event: 'retry',
        reason: '误标失败，重新排队',
      });

      expect(retried.status).toBe('pending');
      expect(retried.fail_reason).toBeNull();
      expect(retried.failed_at).toBeNull();
      expect(retried.claimed_by).toBeNull();
      expect(retried.claim_expires_at).toBeNull();
      expect(h.ctx.repos.tasks.get(failed.id)?.claim_token).toBeNull();
      // 时间线保留：用户要能看出这是“重做”，而不是一条全新任务。
      expect(retried.started_at).toBe(startedAt);
      expect(retried.claimed_at).toBe(claimedAt);
      expect(retried.updated_at).toBe(new Date(h.clock.now()).toISOString());
      // end_notice_pending 是派生字段：状态回到 pending 后自然不再提醒“任务已结束”。
      expect(retried.end_notice_pending).toBe(false);

      // 回到 pending 必须是可再次认领的“真队列”，而不是只改了一个状态词。
      const reclaim = h.ctx.services.tasks.claim(
        { task_id: failed.id, harness_id: HARNESS_ID },
        testCtx(),
      );
      expect(reclaim.task.status).toBe('claimed');
    } finally {
      h.close();
    }
  });

  it('retry 必须写理由：缺省与空白都报 REASON_REQUIRED，任务留在 failed', () => {
    const h = boot();
    try {
      const failed = createFailed(h);

      const missing = expectCode(
        () => update(h, { task_id: failed.id, event: 'retry' }),
        'INVALID_ARGUMENT',
      );
      expect(missing.message).toBe('REASON_REQUIRED');
      expect(missing.details).toEqual({ event: 'retry' });

      expectCode(
        () => update(h, { task_id: failed.id, event: 'retry', reason: '   ' }),
        'INVALID_ARGUMENT',
      );
      // 校验失败不能留下半成品：任务必须仍是 failed，等待下一次带理由的重排。
      expect(h.ctx.services.tasks.get(failed.id).status).toBe('failed');
    } finally {
      h.close();
    }
  });

  it('retry 写 task_event 与审计 task.retry，detail 带理由和 from/to', () => {
    const h = boot();
    try {
      const failed = createFailed(h);
      const retried = update(h, {
        task_id: failed.id,
        event: 'retry',
        reason: '重新做一遍',
      });
      expect(retried.status).toBe('pending');

      const events = h.db
        .prepare(
          `SELECT event, actor, detail_json
             FROM task_event
            WHERE task_id = ? AND event = 'retry'
            ORDER BY id`,
        )
        .all(failed.id) as Array<{
        event: string;
        actor: string | null;
        detail_json: string | null;
      }>;
      expect(events).toHaveLength(1);
      expect(events[0].actor).toBe('tester');
      expect(JSON.parse(events[0].detail_json ?? '{}')).toEqual({ reason: '重新做一遍' });

      const audits = h.db
        .prepare(
          `SELECT action, object_type, object_id, detail_json
             FROM audit_log
            WHERE action = 'task.retry' AND object_id = ?
            ORDER BY id`,
        )
        .all(failed.id) as Array<{
        action: string;
        object_type: string | null;
        object_id: string | null;
        detail_json: string | null;
      }>;
      expect(audits).toHaveLength(1);
      expect(audits[0].object_type).toBe('task');
      expect(JSON.parse(audits[0].detail_json ?? '{}')).toEqual({
        from: 'failed',
        to: 'pending',
      });
    } finally {
      h.close();
    }
  });

  it('done 任务不能 retry：只允许 failed → pending', () => {
    const h = boot();
    try {
      registerHarness(h);
      const task = createPending(h);
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
          summary: '完成证据',
          result: 'success',
        }) as CardPostInput,
        testCtx(),
      );
      update(h, { task_id: task.id, event: 'complete', claim_token: claim.claim_token });

      expectCode(
        () => update(h, { task_id: task.id, event: 'retry', reason: '想重做' }),
        'CONFLICT',
      );
      // 被拒绝后状态不变，done 仍是不可逆的。
      expect(h.ctx.services.tasks.get(task.id).status).toBe('done');
    } finally {
      h.close();
    }
  });
});
