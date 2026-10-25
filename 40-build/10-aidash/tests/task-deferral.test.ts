import { describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { taskCreateSchema, taskUpdateSchema } from '../src/shared/schemas.js';
import { createHarness, testCtx, type TestHarness } from './helpers.js';

const CHANNEL = 'devhost/deferral/topic';

function boot(): TestHarness {
  return createHarness();
}

function registerHarness(h: TestHarness): void {
  h.ctx.repos.harnesses.upsert({
    harness_id: 'h-deferral',
    name: 'h-deferral',
    host: null,
    capabilities_json: null,
    now: h.clock.now(),
  });
}

function createPending(h: TestHarness, title = '排期任务') {
  return h.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: CHANNEL, title }),
    testCtx(),
    { submit: true },
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

describe('任务暂缓 / 排期', () => {
  it('pending 任务无需令牌即可暂缓，状态保持不变且写入原因与计划时间', () => {
    const h = boot();
    try {
      const task = createPending(h);
      const until = new Date(h.clock.now() + 86_400_000).toISOString();

      const deferred = update(h, {
        task_id: task.id,
        event: 'defer',
        reason: '上一轮会话结束，尚未开始',
        deferred_until: until,
      });

      // 核心语义：暂缓不是状态转移，任务仍然没人认领。
      expect(deferred.status).toBe('pending');
      expect(deferred.defer_reason).toBe('上一轮会话结束，尚未开始');
      expect(deferred.deferred_at).not.toBeNull();
      expect(deferred.deferred_until).toBe(until);
    } finally {
      h.close();
    }
  });

  it('认领会清空暂缓标记，表示重新开始处理', () => {
    const h = boot();
    try {
      registerHarness(h);
      const task = createPending(h);
      update(h, { task_id: task.id, event: 'defer', reason: '先放一放' });

      const claim = h.ctx.services.tasks.claim(
        { task_id: task.id, harness_id: 'h-deferral' },
        testCtx(),
      );

      expect(claim.task.status).toBe('claimed');
      expect(claim.task.defer_reason).toBeNull();
      expect(claim.task.deferred_at).toBeNull();
      expect(claim.task.deferred_until).toBeNull();
    } finally {
      h.close();
    }
  });

  it('取消暂缓清空三列；重复取消返回 TASK_NOT_DEFERRED', () => {
    const h = boot();
    try {
      const task = createPending(h);
      update(h, { task_id: task.id, event: 'defer', reason: '排期到以后' });

      const restored = update(h, { task_id: task.id, event: 'undefer' });
      expect(restored.status).toBe('pending');
      expect(restored.defer_reason).toBeNull();
      expect(restored.deferred_until).toBeNull();

      expectCode(
        () => update(h, { task_id: task.id, event: 'undefer' }),
        'CONFLICT',
      );
    } finally {
      h.close();
    }
  });

  it('暂缓必须有原因；执行中的任务不能暂缓', () => {
    const h = boot();
    try {
      registerHarness(h);
      const task = createPending(h);

      expectCode(
        () => update(h, { task_id: task.id, event: 'defer', reason: '   ' }),
        'INVALID_ARGUMENT',
      );

      const claim = h.ctx.services.tasks.claim(
        { task_id: task.id, harness_id: 'h-deferral' },
        testCtx(),
      );
      h.ctx.services.tasks.update(
        { task_id: task.id, event: 'start', claim_token: claim.claim_token },
        testCtx(),
      );

      expectCode(
        () =>
          update(h, {
            task_id: task.id,
            event: 'defer',
            reason: '想先停一下',
          }),
        'CONFLICT',
      );
    } finally {
      h.close();
    }
  });

  it('取消任务会清空暂缓标记，避免终态仍显示已暂缓', () => {
    const h = boot();
    try {
      const task = createPending(h);
      update(h, { task_id: task.id, event: 'defer', reason: '暂缓后又决定不做' });

      const cancelled = update(h, {
        task_id: task.id,
        event: 'cancel',
        reason: '需求已取消',
      });

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancel_reason).toBe('需求已取消');
      expect(cancelled.defer_reason).toBeNull();
      expect(cancelled.deferred_at).toBeNull();
      expect(cancelled.deferred_until).toBeNull();
    } finally {
      h.close();
    }
  });
});
