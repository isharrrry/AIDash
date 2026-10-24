import { describe, expect, it } from 'vitest';
import { taskCreateSchema, taskUpdateSchema } from '../src/shared/schemas.js';
import type { TreeNode } from '../src/shared/types.js';
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

const CHANNEL = 'devhost/category/topic';
let rpcId = 0;

/**
 * 任务分类回归。
 *
 * 这组用例守的是四条约定：
 * 1. 分类是单值列，不是 tags 的别名；空白输入等价于“未分类”；
 * 2. 创建、编辑、列表、任务树四条路径返回同一个值；
 * 3. 分类是任务模板属性，复制子树时应保留（与隐患等一次性历史相反）；
 * 4. REST 与 MCP 两条入口行为一致，长度上限由 schema 统一兜住。
 */
function boot(): TestHarness {
  return createHarness();
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
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

describe('任务分类', () => {
  it('迁移 014 给 task 表增加 category 列', () => {
    const h = boot();
    try {
      const columns = h.db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('category');
    } finally {
      h.close();
    }
  });

  it('创建时去除首尾空白，列表与任务树返回同一分类', () => {
    const h = boot();
    try {
      const created = h.ctx.services.tasks.create(
        taskCreateSchema.parse({ channel_key: CHANNEL, title: '分类任务', category: '  功能  ' }),
        testCtx(),
        { submit: true },
      ).task;
      expect(created.category).toBe('功能');

      const listed = h.ctx.services.tasks.list({ channel_key: CHANNEL }, false);
      expect(listed.items.find((item) => item.id === created.id)?.category).toBe('功能');

      const tree = flatten(h.ctx.services.tasks.tree(CHANNEL, 20, false));
      expect(tree.find((node) => node.id === created.id)?.category).toBe('功能');
    } finally {
      h.close();
    }
  });

  it('空白分类按未分类保存，PATCH 可以改值或清空', () => {
    const h = boot();
    try {
      const created = h.ctx.services.tasks.create(
        taskCreateSchema.parse({ channel_key: CHANNEL, title: '空白分类', category: '   ' }),
        testCtx(),
      ).task;
      expect(created.category).toBeNull();

      const updated = h.ctx.services.tasks.update(
        taskUpdateSchema.parse({
          task_id: created.id,
          patch: { category: ' 缺陷 ' },
        }),
        testCtx(),
      );
      expect(updated.category).toBe('缺陷');

      const cleared = h.ctx.services.tasks.update(
        taskUpdateSchema.parse({ task_id: created.id, patch: { category: null } }),
        testCtx(),
      );
      expect(cleared.category).toBeNull();

      const clearedByEmpty = h.ctx.services.tasks.update(
        taskUpdateSchema.parse({ task_id: created.id, patch: { category: '   ' } }),
        testCtx(),
      );
      expect(clearedByEmpty.category).toBeNull();
    } finally {
      h.close();
    }
  });

  it('复制子树保留分类：它是任务模板属性，不是一次性历史', () => {
    const h = boot();
    try {
      const source = h.ctx.services.tasks.create(
        taskCreateSchema.parse({ channel_key: CHANNEL, title: '源任务', category: '调研' }),
        testCtx(),
        { submit: true },
      ).task;
      const child = h.ctx.services.tasks.create(
        taskCreateSchema.parse({
          channel_key: CHANNEL,
          title: '子任务',
          category: '调研',
          parent_id: source.id,
        }),
        testCtx(),
      ).task;

      const copied = h.ctx.services.tasks.copy(source.id, null, testCtx());
      expect(copied.copied).toBe(2);
      expect(copied.task.category).toBe('调研');

      const subtree = flatten(h.ctx.services.tasks.tree(CHANNEL, 20, false)).filter(
        (node) => node.id === copied.task.id || node.parent_id === copied.task.id,
      );
      // 根 + 子节点都应保留分类，且子节点的父 ID 已映射到新根。
      expect(subtree.map((node) => node.category)).toEqual(['调研', '调研']);
      expect(subtree.some((node) => node.id === child.id)).toBe(false);
    } finally {
      h.close();
    }
  });

  it('REST 创建与编辑分类，超过 40 字符被拒绝', async () => {
    const h = boot();
    const app = await startApp(h);
    try {
      const created = await api<{ task: { id: string; category: string | null } }>(
        app,
        'POST',
        '/api/tasks',
        { channel_key: CHANNEL, title: 'REST 分类', category: '功能', submit: true },
      );
      expect(created.status).toBe(201);
      expect(created.body.data?.task.category).toBe('功能');
      const taskId = created.body.data!.task.id;

      const patched = await api<{ category: string | null }>(app, 'PATCH', `/api/tasks/${taskId}`, {
        patch: { category: '维护' },
      });
      expect(patched.status).toBe(200);
      expect(patched.body.data?.category).toBe('维护');

      const tooLong = await api(app, 'POST', '/api/tasks', {
        channel_key: CHANNEL,
        title: '超长分类',
        category: 'x'.repeat(41),
      });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      await app.close();
      h.close();
    }
  });

  it('MCP task.create/task.update 支持分类，task.tree 返回分类', async () => {
    const h = boot();
    const app = await startApp(h);
    try {
      const created = (await callTool(app, 'task.create', {
        channel_key: CHANNEL,
        title: 'MCP 分类',
        category: '缺陷',
        submit: true,
      })) as { task: { id: string; category: string | null } };
      expect(created.task.category).toBe('缺陷');

      const updated = (await callTool(app, 'task.update', {
        task_id: created.task.id,
        patch: { category: '维护' },
      })) as { category: string | null };
      expect(updated.category).toBe('维护');

      const tree = (await callTool(app, 'task.tree', { channel_key: CHANNEL })) as TreeNode[];
      expect(flatten(tree).find((node) => node.id === created.task.id)?.category).toBe('维护');
    } finally {
      await app.close();
      h.close();
    }
  });
});
