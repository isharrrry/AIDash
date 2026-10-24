import { describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { taskCreateSchema, taskUpdateSchema } from '../src/shared/schemas.js';
import type { TaskView } from '../src/shared/types.js';
import { api, createHarness, startApp, testCtx, type TestHarness } from './helpers.js';

const CHANNEL = 'devhost/end-notice/topic';

function createDraft(h: TestHarness, title = '结束通知测试任务'): TaskView {
  return h.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: CHANNEL, title }),
    testCtx(),
  ).task;
}

function cancel(h: TestHarness, taskId: string): TaskView {
  return h.ctx.services.tasks.update(
    taskUpdateSchema.parse({ task_id: taskId, event: 'cancel', reason: '测试不再做' }),
    testCtx(),
  );
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

describe('任务结束通知', () => {
  it('迁移 015 给 task 增加 end_notice_read_at 列', () => {
    const h = createHarness();
    try {
      const columns = h.db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('end_notice_read_at');
      const version = h.db
        .prepare('SELECT MAX(version) AS version FROM schema_migration')
        .get() as { version: number };
      expect(version.version).toBeGreaterThanOrEqual(15);
    } finally {
      h.close();
    }
  });

  it('任务取消后出现结束通知，确认后消失且重复确认幂等', () => {
    const h = createHarness();
    try {
      const draft = createDraft(h);
      // 草稿没结束，不应有通知。
      expect(draft.end_notice_pending).toBe(false);

      const cancelled = cancel(h, draft.id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.end_notice_read_at).toBeNull();
      expect(cancelled.end_notice_pending).toBe(true);

      const acked = h.ctx.services.tasks.ackEndNotice(cancelled.id, testCtx());
      expect(acked.end_notice_pending).toBe(false);
      expect(acked.end_notice_read_at).not.toBeNull();

      // 第二次确认不刷新第一次的已读时间：它回答的是“我什么时候第一次看到它结束”。
      const again = h.ctx.services.tasks.ackEndNotice(cancelled.id, testCtx());
      expect(again.end_notice_read_at).toBe(acked.end_notice_read_at);
    } finally {
      h.close();
    }
  });

  it('未结束任务不能确认结束通知', () => {
    const h = createHarness();
    try {
      const draft = createDraft(h);
      expectCode(
        () => h.ctx.services.tasks.ackEndNotice(draft.id, testCtx()),
        'CONFLICT',
      );
    } finally {
      h.close();
    }
  });

  it('REST 确认端点：未结束 409，结束后可确认并返回 pending=false', async () => {
    const h = createHarness();
    const a = await startApp(h);
    try {
      const created = await api<{ task: TaskView }>(a, 'POST', '/api/tasks', {
        channel_key: CHANNEL,
        title: 'REST 结束通知',
      });
      const id = created.body.data!.task.id;

      const notEnded = await api(a, 'POST', `/api/tasks/${id}/ack-end-notice`);
      expect(notEnded.status).toBe(409);
      expect(notEnded.body.error?.code).toBe('CONFLICT');

      const cancelled = await api<TaskView>(a, 'PATCH', `/api/tasks/${id}`, {
        event: 'cancel',
        reason: 'REST 测试',
      });
      expect(cancelled.body.data?.end_notice_pending).toBe(true);

      const acked = await api<TaskView>(a, 'POST', `/api/tasks/${id}/ack-end-notice`);
      expect(acked.status).toBe(200);
      expect(acked.body.data?.end_notice_pending).toBe(false);
      expect(acked.body.data?.end_notice_read_at).not.toBeNull();
    } finally {
      await a.close();
      h.close();
    }
  });

  it('复制已结束任务得到的是全新草稿，不继承结束通知', () => {
    const h = createHarness();
    try {
      const draft = createDraft(h);
      const cancelled = cancel(h, draft.id);
      h.ctx.services.tasks.ackEndNotice(cancelled.id, testCtx());

      const copy = h.ctx.services.tasks.copy(cancelled.id, null, testCtx());
      expect(copy.task.status).toBe('draft');
      expect(copy.task.end_notice_read_at).toBeNull();
      expect(copy.task.end_notice_pending).toBe(false);
    } finally {
      h.close();
    }
  });
});
