import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardPostSchema, taskCreateSchema } from '../src/shared/schemas.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import { createHarness, questionPayload, testCtx, type TestHarness } from './helpers.js';

let harness: TestHarness | null = null;
afterEach(() => {
  harness?.close();
  harness = null;
});

/**
 * 列表/摘要的查询形态回归。
 *
 * 这里不断言 SQL 文本（容易被无关重排打碎），而是断言“有没有逐条查”：
 * - 一页任务来自多个通道时，不能再对每条任务调用 getOrThrow；
 * - 移动前的深度校验只取 path，不能再读整棵子树；
 * - 决策摘要跨通道时，不能再逐卡查 channel。
 */
describe('列表与摘要的批量查询', () => {
  it('跨通道任务列表一次取回 channel_key，不逐条查询通道', () => {
    const h = createHarness();
    harness = h;
    for (const [channelKey, title] of [
      ['devhost/alpha/task-list', 'A'],
      ['devhost/beta/task-list', 'B'],
    ]) {
      h.ctx.services.tasks.create(
        taskCreateSchema.parse({ channel_key: channelKey, title }),
        testCtx(),
      );
    }

    const spy = vi.spyOn(h.ctx.services.channels, 'getOrThrow');
    const page = h.ctx.services.tasks.list({ page_size: 50 });

    expect(page.items.map((task) => task.channel_key).sort()).toEqual([
      'devhost/alpha/task-list',
      'devhost/beta/task-list',
    ]);
    // 旧实现会对每个任务调用一次 getOrThrow；批量取 key 后应为 0 次。
    expect(spy).not.toHaveBeenCalled();
  });

  it('移动任务做深度校验时只取路径，不读整棵子树', () => {
    const h = createHarness();
    harness = h;
    const root = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: 'devhost/alpha/move', title: 'root' }),
      testCtx(),
    );
    h.ctx.services.tasks.create(
      taskCreateSchema.parse({
        channel_key: 'devhost/alpha/move',
        title: 'child',
        parent_id: root.task.id,
      }),
      testCtx(),
    );

    const spy = vi.spyOn(h.ctx.repos.tasks, 'findSubtree');
    h.ctx.services.tasks.move(root.task.id, null, testCtx());

    // findSubtree 会 SELECT 全部任务字段（含可能内嵌截图的 description_md）；
    // 深度校验只需要 path，调用它就说明轻量投影失效了。
    expect(spy).not.toHaveBeenCalled();
  });

  it('决策摘要跨通道时批量取 channel_key，不逐卡查询通道', () => {
    const h = createHarness();
    harness = h;
    for (const channelKey of ['devhost/alpha/digest', 'devhost/beta/digest']) {
      h.ctx.services.cards.post(
        cardPostSchema.parse(
          questionPayload({ channel_key: channelKey, type: 'question', title: '选一个', priority: 'P0' }),
        ) as CardPostInput,
        testCtx(),
      );
    }

    const spy = vi.spyOn(h.ctx.services.channels, 'getOrThrow');
    const digest = h.ctx.services.cards.digest();

    expect(digest.p0_cards.map((card) => card.channel_key).sort()).toEqual([
      'devhost/alpha/digest',
      'devhost/beta/digest',
    ]);
    expect(spy).not.toHaveBeenCalled();
  });
});
