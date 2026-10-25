import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { cardPostSchema, taskCreateSchema, taskUpdateSchema } from '../src/shared/schemas.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import { TaskService } from '../src/server/services/task-service.js';
import { latestMigrationVersion, migrate, schemaVersion } from '../src/server/db/migrate.js';
import { openDb } from '../src/server/db/connection.js';
import {
  CHANNEL,
  HARNESS_ALT,
  HARNESS_ID,
  OTHER_CHANNEL,
  claimTask,
  createTask,
  expectAppError,
  postCard,
  registerHarness,
  seedCardTask,
  shallowDepthService,
  startTask,
  updateTask,
} from './fakes/core-fixtures.js';
import {
  createHarness,
  questionPayload,
  testCtx,
  type TestHarness,
} from './helpers.js';

/**
 * 任务树、列表与幂等分支。
 *
 * 由 core-error-branches 按主题拆出：跨通道、环、深度、树/列表投影、
 * 字段 patch、结束通知与幂等键。断言保持原样，仅搬移分组。
 */

describe('TaskService 错误分支', () => {
  it('跨通道：父任务、移动、复制、发卡全部被 TASK_CHANNEL_MISMATCH 拒绝', () => {
    const h = createHarness();
    try {
      const local = createTask(h, { title: '本通道任务' });
      const foreign = createTask(h, { channel: OTHER_CHANNEL, title: '外通道任务' });

      const parentErr = expectAppError(
        () =>
          h.ctx.services.tasks.create(
            taskCreateSchema.parse({
              channel_key: CHANNEL,
              title: '挂错父任务',
              parent_id: foreign.id,
            }),
            testCtx(),
          ),
        'INVALID_ARGUMENT',
        'TASK_CHANNEL_MISMATCH',
      );
      expect(parentErr.details?.task_id).toBe(foreign.id);

      expectAppError(
        () => h.ctx.services.tasks.move(local.id, foreign.id, testCtx()),
        'INVALID_ARGUMENT',
        'TASK_CHANNEL_MISMATCH',
      );
      expectAppError(
        () => h.ctx.services.tasks.copy(local.id, foreign.id, testCtx()),
        'INVALID_ARGUMENT',
        'TASK_CHANNEL_MISMATCH',
      );
      expectAppError(
        () =>
          postCard(h, {
            channel_key: CHANNEL,
            type: 'info',
            title: '挂错任务的卡',
            body_md: '正文',
            severity: 'info',
            task_id: foreign.id,
          }),
        'INVALID_ARGUMENT',
        'TASK_CHANNEL_MISMATCH',
      );

      // 失败不应产生新任务，也不应改动原路径。
      expect(h.ctx.services.tasks.list({ channel_key: CHANNEL }).items.map((item) => item.id)).toEqual([
        local.id,
      ]);
      expect(h.ctx.repos.tasks.get(local.id)?.path).toBe(local.path);
    } finally {
      h.close();
    }
  });

  it('环检测：移动到自身/子树、复制到子树都被 TASK_CYCLE 拒绝且树结构不变', () => {
    const h = createHarness();
    try {
      const root = createTask(h, { title: 'root' });
      const child = createTask(h, { title: 'child', parent_id: root.id });
      const grandchild = createTask(h, { title: 'grandchild', parent_id: child.id });

      for (const target of [root.id, child.id]) {
        const error = expectAppError(
          () => h.ctx.services.tasks.move(root.id, target, testCtx()),
          'INVALID_ARGUMENT',
          'TASK_CYCLE',
        );
        expect(error.details?.task_id).toBe(root.id);
      }
      expectAppError(
        () => h.ctx.services.tasks.copy(root.id, grandchild.id, testCtx()),
        'INVALID_ARGUMENT',
        'TASK_CYCLE',
      );

      expect(h.ctx.services.tasks.get(root.id).path).toBe(root.path);
      const tree = h.ctx.services.tasks.tree(CHANNEL);
      expect(tree).toHaveLength(1);
      expect(tree[0]!.children[0]!.id).toBe(child.id);
      expect(tree[0]!.children[0]!.children[0]!.id).toBe(grandchild.id);
    } finally {
      h.close();
    }
  });

  it('深度上限：超深创建与移动被 TASK_DEPTH_EXCEEDED 拒绝，且不落库', () => {
    const h = createHarness();
    try {
      const service = shallowDepthService(h, 2);
      const root = service.create(
        taskCreateSchema.parse({ channel_key: CHANNEL, title: 'root' }),
        testCtx(),
        { submit: true },
      ).task;
      const child = service.create(
        taskCreateSchema.parse({ channel_key: CHANNEL, title: 'child', parent_id: root.id }),
        testCtx(),
      ).task;

      const createErr = expectAppError(
        () =>
          service.create(
            taskCreateSchema.parse({
              channel_key: CHANNEL,
              title: 'too-deep',
              parent_id: child.id,
            }),
            testCtx(),
          ),
        'INVALID_ARGUMENT',
        'TASK_DEPTH_EXCEEDED',
      );
      expect(createErr.details?.max_depth).toBe(2);
      expect(h.ctx.services.tasks.list({ channel_key: CHANNEL }).total).toBe(2);

      const other = service.create(
        taskCreateSchema.parse({ channel_key: CHANNEL, title: 'other' }),
        testCtx(),
      ).task;
      expectAppError(
        () => service.move(other.id, child.id, testCtx()),
        'INVALID_ARGUMENT',
        'TASK_DEPTH_EXCEEDED',
      );
      expect(h.ctx.services.tasks.get(other.id).parent_id).toBeNull();
    } finally {
      h.close();
    }
  });

  it('树与列表：maxDepth 截断、description 投影、移动重写子树、复制为全新草稿', () => {
    const h = createHarness();
    try {
      const rootA = createTask(h, { title: 'A', description_md: 'A 描述' });
      const childA = createTask(h, {
        title: 'A-child',
        parent_id: rootA.id,
        description_md: 'child 描述',
      });
      const rootB = createTask(h, { title: 'B' });

      const shallow = h.ctx.services.tasks.tree(CHANNEL, 1, false);
      expect(shallow).toHaveLength(2);
      expect(shallow.every((node) => node.children.length === 0)).toBe(true);
      expect(shallow.every((node) => node.description_md === null)).toBe(true);

      const full = h.ctx.services.tasks.tree(CHANNEL, 10, true);
      const nodeA = full.find((node) => node.id === rootA.id)!;
      expect(nodeA.description_md).toBe('A 描述');
      expect(nodeA.children[0]!.id).toBe(childA.id);
      expect(nodeA.children[0]!.description_md).toBe('child 描述');

      // 移动整棵子树：子节点路径也必须跟着前缀重写。
      const moved = h.ctx.services.tasks.move(rootA.id, rootB.id, testCtx());
      expect(moved.path).toBe(`/${rootB.id}/${rootA.id}/`);
      expect(h.ctx.repos.tasks.get(childA.id)?.path).toBe(
        `/${rootB.id}/${rootA.id}/${childA.id}/`,
      );

      const copied = h.ctx.services.tasks.copy(rootB.id, null, testCtx());
      expect(copied.copied).toBe(3);
      expect(copied.task.status).toBe('draft');
      expect(copied.task.parent_id).toBeNull();
      expect(h.ctx.services.tasks.tree(CHANNEL)).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it('任务列表筛选：状态/负责人/关键词转义/隐患/分页与未读数', () => {
    const h = createHarness();
    try {
      const alpha = createTask(h, { title: '100% 完成', assignee: 'alice' });
      const beta = createTask(h, { title: '100x 完成', assignee: 'bob' });
      const underscore = createTask(h, { title: 'a_b 计划' });
      const noUnderscore = createTask(h, { title: 'axb 计划' });
      createTask(h, { channel: OTHER_CHANNEL, title: '外通道任务' });
      const cancelled = createTask(h, { title: '待取消', assignee: 'alice' });
      updateTask(h, { task_id: cancelled.id, event: 'cancel', reason: '重复任务' });
      const child = createTask(h, { title: '子任务', parent_id: alpha.id });
      updateTask(h, { task_id: alpha.id, event: 'flag_risk', reason: '遗留隐患' });

      const channel = h.ctx.services.channels.getByKeyOrThrow(CHANNEL);
      const repo = h.ctx.repos.tasks;

      expect(
        repo
          .list({ channelId: channel.id, statuses: ['pending'], assignee: 'alice' })
          .items.map((item) => item.id),
      ).toEqual([alpha.id]);

      // LIKE 通配符必须被转义：% 和 _ 都按字面匹配。
      expect(repo.list({ channelId: channel.id, q: '100%' }).items.map((item) => item.id)).toEqual([
        alpha.id,
      ]);
      expect(repo.list({ channelId: channel.id, q: 'a_b' }).items.map((item) => item.id)).toEqual([
        underscore.id,
      ]);

      expect(repo.list({ channelId: channel.id, hasRisk: true }).items.map((item) => item.id)).toEqual([
        alpha.id,
      ]);
      const clean = repo.list({ channelId: channel.id, hasRisk: false }).items.map((item) => item.id);
      expect(clean).not.toContain(alpha.id);
      expect(clean).toEqual(expect.arrayContaining([beta.id, underscore.id, noUnderscore.id]));
      expect(repo.list({ channelId: channel.id, riskOpen: true }).items.map((item) => item.id)).toEqual([
        alpha.id,
      ]);

      // path 按 ULID 排序，同一毫秒创建的任务顺序不确定；这里只比较集合。
      expect(
        new Set(
          repo.list({ channelId: channel.id, parentId: null }).items.map((item) => item.id),
        ),
      ).toEqual(new Set([alpha.id, beta.id, underscore.id, noUnderscore.id, cancelled.id]));
      expect(repo.list({ channelId: channel.id, parentId: alpha.id }).items.map((item) => item.id)).toEqual([
        child.id,
      ]);

      const firstPage = repo.list({ channelId: channel.id, page: 1, page_size: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.total).toBe(6);
      expect(firstPage.has_more).toBe(true);
      const lastPage = repo.list({ channelId: channel.id, page: 3, page_size: 2 });
      expect(lastPage.items).toHaveLength(2);
      expect(lastPage.has_more).toBe(false);

      // 服务层按通道过滤，并顺带填未读数。
      const card = postCard(h, {
        channel_key: CHANNEL,
        type: 'info',
        title: '一条未读信息',
        body_md: '正文',
        severity: 'info',
        task_id: alpha.id,
      });
      const withUnread = h.ctx.services.tasks.list({ channel_key: CHANNEL });
      expect(withUnread.total).toBe(6);
      expect(withUnread.items.find((item) => item.id === alpha.id)?.unread_count).toBe(1);
      h.ctx.services.cards.markRead(card.id, testCtx());
      const afterRead = h.ctx.services.tasks.list({ channel_key: CHANNEL });
      expect(afterRead.items.find((item) => item.id === alpha.id)?.unread_count).toBe(0);

      expectAppError(
        () => h.ctx.services.tasks.list({ channel_key: 'no/such/channel' }),
        'NOT_FOUND',
        'CHANNEL_NOT_FOUND',
      );
      expectAppError(
        () => h.ctx.services.tasks.tree('no/such/channel'),
        'NOT_FOUND',
        'CHANNEL_NOT_FOUND',
      );
      expectAppError(() => h.ctx.services.tasks.get('tk_missing'), 'NOT_FOUND', 'TASK_NOT_FOUND');
    } finally {
      h.close();
    }
  });

  it('仅 patch 更新：空更新被拒，字段可写可清空，事件里描述只留长度摘要', () => {
    const h = createHarness();
    try {
      const task = createTask(h, { submit: false });

      expectAppError(
        () => updateTask(h, { task_id: task.id }),
        'INVALID_ARGUMENT',
        'NOTHING_TO_UPDATE',
      );

      const updated = updateTask(h, {
        task_id: task.id,
        patch: {
          title: '新标题',
          description_md: '描述',
          category: '  功能  ',
          priority: 'P0',
          assignee: 'alice',
          tags: ['a', 'b'],
          due_at: new Date(h.clock.now() + 86_400_000).toISOString(),
        },
      });
      expect(updated).toMatchObject({
        title: '新标题',
        description_md: '描述',
        category: '功能',
        priority: 'P0',
        assignee: 'alice',
      });
      expect(updated.tags).toEqual(['a', 'b']);
      expect(updated.due_at).not.toBeNull();

      const cleared = updateTask(h, {
        task_id: task.id,
        patch: { category: null, assignee: null, tags: [], due_at: null },
      });
      expect(cleared.category).toBeNull();
      expect(cleared.assignee).toBeNull();
      expect(cleared.tags).toEqual([]);
      expect(cleared.due_at).toBeNull();

      const events = h.ctx.repos.events.listTask(task.id) as Array<{
        event: string;
        detail_json: string | null;
      }>;
      // 第二次 patch 只清空字段，不带描述；要找的是第一次写描述的事件。
      const updatedEvent = events.find((event) =>
        (event.detail_json ?? '').includes('[omitted 2 chars]'),
      )!;
      // 描述可能内嵌 base64 截图，事件表不能复制全文。
      expect(updatedEvent.detail_json).toContain('[omitted 2 chars]');
      expect(updatedEvent.detail_json).not.toContain('"描述"');

      const submitted = updateTask(h, { task_id: task.id, event: 'submit' });
      expect(submitted.status).toBe('pending');
    } finally {
      h.close();
    }
  });

  it('结束通知：未结束不可确认；终态确认幂等且不刷新首次已读时间', () => {
    const h = createHarness();
    try {
      const draft = createTask(h, { submit: false });
      expectAppError(
        () => h.ctx.services.tasks.ackEndNotice(draft.id, testCtx()),
        'CONFLICT',
        'TASK_NOT_ENDED',
      );
      expectAppError(
        () => h.ctx.services.tasks.ackEndNotice('tk_missing', testCtx()),
        'NOT_FOUND',
        'TASK_NOT_FOUND',
      );

      const cancelled = updateTask(h, {
        task_id: draft.id,
        event: 'cancel',
        reason: '不做了',
      });
      expect(cancelled.end_notice_pending).toBe(true);

      const acked = h.ctx.services.tasks.ackEndNotice(cancelled.id, testCtx());
      expect(acked.end_notice_pending).toBe(false);
      expect(acked.end_notice_read_at).not.toBeNull();

      h.clock.advance(60_000);
      const again = h.ctx.services.tasks.ackEndNotice(cancelled.id, testCtx());
      expect(again.end_notice_read_at).toBe(acked.end_notice_read_at);

      const events = h.ctx.repos.events.listTask(cancelled.id) as Array<{ event: string }>;
      expect(events.filter((event) => event.event === 'end_notice_acked')).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('认领竞态：任务在读与写之间消失时回退为 TASK_NOT_FOUND', () => {
    const h = createHarness();
    try {
      registerHarness(h);
      const task = createTask(h);
      const spy = vi.spyOn(h.ctx.repos.tasks, 'claim').mockReturnValue({
        ok: false,
        reason: 'NOT_FOUND',
      });
      try {
        expectAppError(
          () => claimTask(h, task.id),
          'NOT_FOUND',
          'TASK_NOT_FOUND',
        );
      } finally {
        spy.mockRestore();
      }
      // 失败不改变任务状态，恢复后仍可正常认领。
      expect(h.ctx.services.tasks.get(task.id).status).toBe('pending');
    } finally {
      h.close();
    }
  });

  it('任务视图容错：损坏的 tags_json 降级为空数组', () => {
    const h = createHarness();
    try {
      const task = createTask(h);
      h.ctx.repos.tasks.updateFields(task.id, { tags_json: '{bad' });
      const view = h.ctx.services.tasks.get(task.id);
      expect(view.tags).toEqual([]);
      expect(view.title).toBe('错误分支测试任务');
    } finally {
      h.close();
    }
  });

  it('任务创建幂等键：同通道重复创建复用原任务，不新增行', () => {
    const h = createHarness();
    try {
      const input = taskCreateSchema.parse({
        channel_key: CHANNEL,
        title: '幂等任务',
        idempotency_key: 'idem-core-1',
      });
      const first = h.ctx.services.tasks.create(input, testCtx(), { submit: true });
      const second = h.ctx.services.tasks.create(input, testCtx(), { submit: true });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.task.id).toBe(first.task.id);
      expect(h.ctx.services.tasks.list({ channel_key: CHANNEL }).total).toBe(1);
    } finally {
      h.close();
    }
  });

  it('幂等键按通道隔离：跨通道复用同键会新建任务，且不留下空通道', () => {
    const h = createHarness();
    try {
      const otherChannel = `${CHANNEL}-other`;
      const inputA = taskCreateSchema.parse({
        channel_key: CHANNEL,
        title: '通道 A 的任务',
        idempotency_key: 'idem-cross-1',
      });
      const inputB = taskCreateSchema.parse({
        channel_key: otherChannel,
        title: '通道 B 的任务',
        idempotency_key: 'idem-cross-1',
      });

      const first = h.ctx.services.tasks.create(inputA, testCtx(), { submit: true });
      const second = h.ctx.services.tasks.create(inputB, testCtx(), { submit: true });

      // 回归守卫（原 D-1）：全局幂等曾让 B 复用 A 的任务，并把 B 建成空通道。
      expect(second.created).toBe(true);
      expect(second.task.id).not.toBe(first.task.id);
      expect(second.task.channel_key).toBe(otherChannel);

      // 同通道重放仍必须幂等，否则修复会把「重试不重复建」一起弄丢。
      const replay = h.ctx.services.tasks.create(inputB, testCtx(), { submit: true });
      expect(replay.created).toBe(false);
      expect(replay.task.id).toBe(second.task.id);

      // 两个通道各有一条任务：B 不是「有通道没任务」的空记录。
      expect(h.ctx.services.tasks.list({ channel_key: CHANNEL }).total).toBe(1);
      expect(h.ctx.services.tasks.list({ channel_key: otherChannel }).total).toBe(1);
    } finally {
      h.close();
    }
  });
});
