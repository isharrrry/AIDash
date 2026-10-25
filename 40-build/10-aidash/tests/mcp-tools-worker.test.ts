import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  createHarness,
  mcp,
  mcpToolData,
  questionOptions,
  questionPayload,
  seedTask,
  startApp,
  type RunningApp,
  type TestHarness,
} from './helpers.js';
import { cardPostSchema, taskCreateSchema } from '../src/shared/schemas.js';
import { createBackgroundWorker } from '../src/server/workers/background.js';

const CHANNEL = 'devhost/myproj/mcp-tools';

let harness: TestHarness | null = null;
let app: RunningApp | null = null;

async function boot(overrides: Parameters<typeof createHarness>[0] = {}): Promise<{
  h: TestHarness;
  a: RunningApp;
}> {
  harness = createHarness(overrides);
  app = await startApp(harness);
  return { h: harness, a: app };
}

afterEach(async () => {
  if (app) await app.close();
  harness?.close();
  app = null;
  harness = null;
});

let rpcId = 0;

async function call(a: RunningApp, name: string, args: Record<string, unknown> = {}) {
  const payload = await mcp(a, {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return { payload, data: mcpToolData(payload) };
}

describe('MCP 工具全集', () => {
  it('harness 注册、心跳与未知 harness 错误', async () => {
    const { a } = await boot();
    const registered = await call(a, 'harness.register', {
      harness_id: 'h-mcp',
      name: 'MCP harness',
      host: 'devhost',
      capabilities: ['code', 'review'],
    });
    expect((registered.data as { capabilities: string[] }).capabilities).toEqual(['code', 'review']);

    const beat = await call(a, 'harness.heartbeat', {
      harness_id: 'h-mcp',
      status_hint: 'busy',
    });
    expect((beat.data as { harness_id: string }).harness_id).toBe('h-mcp');

    const missing = await mcp(a, {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'harness.heartbeat', arguments: { harness_id: 'h-unknown' } },
    });
    expect(missing.result).toMatchObject({ isError: true });
  });

  it('channel.upsert 与卡片五工具串起来', async () => {
    const { h, a } = await boot();
    const channel = await call(a, 'channel.upsert', { channel_key: CHANNEL, title: 'MCP 通道' });
    expect((channel.data as { created: boolean }).created).toBe(true);

    const posted = await call(a, 'card.post', {
      channel_key: CHANNEL,
      type: 'info',
      title: '工具巡检',
      body_md: '正文',
      severity: 'info',
      // 非 question 卡必须挂任务，先 seed 一条草稿任务。
      task_id: seedTask(h, CHANNEL, '工具巡检任务'),
    });
    const cardId = (posted.data as { card: { id: string } }).card.id;

    const fetched = await call(a, 'card.get', { card_id: cardId });
    expect((fetched.data as { id: string }).id).toBe(cardId);

    const listed = await call(a, 'card.list', {
      channel_key: CHANNEL,
      type: 'info',
      status: 'open',
      q: '巡检',
      page: 1,
      page_size: 10,
    });
    expect((listed.data as { total: number }).total).toBe(1);

    const asked = await call(
      a,
      'card.ask',
      questionPayload({
        channel_key: CHANNEL,
        title: '继续吗？',
        options: questionOptions(['go', 'stop']),
        wait_seconds: 0,
      }),
    );
    const question = asked.data as { status: string; card_id?: string; card?: { id: string } };
    expect(question.status).toBe('pending');
    const questionId = question.card?.id ?? question.card_id;
    expect(questionId).toBeTruthy();

    const waiting = await call(a, 'card.wait', { card_id: questionId, wait_seconds: 0 });
    expect((waiting.data as { status: string }).status).toBe('pending');

    await api(a, 'POST', `/api/cards/${questionId}/answer`, { option_id: 'go' });
    const afterAnswer = await call(a, 'card.wait', { card_id: questionId, wait_seconds: 1 });
    expect((afterAnswer.data as { status: string }).status).toBe('answered');
  });

  it('任务八工具完整走一遍生命周期', async () => {
    const { a } = await boot();
    await call(a, 'harness.register', { harness_id: 'h-task', name: 'h-task' });

    const created = await call(a, 'task.create', {
      channel_key: CHANNEL,
      title: 'MCP 任务',
      priority: 'P1',
      tags: ['mcp'],
      submit: true,
    });
    const taskId = (created.data as { task: { id: string } }).task.id;

    const listed = await call(a, 'task.list', { channel_key: CHANNEL, status: 'pending' });
    expect((listed.data as { total: number }).total).toBe(1);

    const tree = await call(a, 'task.tree', { channel_key: CHANNEL, depth: 2 });
    expect(tree.data).toHaveLength(1);

    const claimed = await call(a, 'task.claim', { task_id: taskId, harness_id: 'h-task' });
    const token = (claimed.data as { claim_token: string }).claim_token;
    expect(token).toMatch(/^cl_/);

    await call(a, 'task.update', { task_id: taskId, event: 'start', claim_token: token });

    await call(a, 'card.post', {
      channel_key: CHANNEL,
      type: 'status',
      task_id: taskId,
      summary: 'MCP 生命周期完成',
      result: 'success',
    });
    const completed = await call(a, 'task.update', {
      task_id: taskId,
      event: 'complete',
      claim_token: token,
    });
    expect((completed.data as { status: string }).status).toBe('done');

    const second = await call(a, 'task.create', {
      channel_key: CHANNEL,
      title: '待释放',
      submit: true,
    });
    const secondId = (second.data as { task: { id: string } }).task.id;
    const claimedSecond = await call(a, 'task.claim', {
      task_id: secondId,
      harness_id: 'h-task',
    });
    const released = await call(a, 'task.release', {
      task_id: secondId,
      claim_token: (claimedSecond.data as { claim_token: string }).claim_token,
    });
    expect((released.data as { status: string }).status).toBe('pending');

    const moved = await call(a, 'task.move', { task_id: secondId, new_parent_id: null });
    expect((moved.data as { parent_id: string | null }).parent_id).toBeNull();

    const copied = await call(a, 'task.copy', { task_id: secondId, new_parent_id: taskId });
    expect((copied.data as { copied: number }).copied).toBe(1);
  });

  it('task.list / task.tree 默认省略描述，include_description 才返回正文', async () => {
    const { a } = await boot();
    const body = 'MCP 描述 ' + 'y'.repeat(10_000);
    const created = await call(a, 'task.create', {
      channel_key: CHANNEL,
      title: '带长描述的任务',
      description_md: body,
    });
    const task = (created.data as { task: { id: string; description_md: string | null } }).task;
    // 写回执带正文，查询默认不带；两条路径的语义要分开验证。
    expect(task.description_md).toBe(body);

    const listed = await call(a, 'task.list', {
      channel_key: CHANNEL,
      status: 'draft',
    });
    const listItem = (listed.data as { items: Array<{ id: string; description_md: string | null }> })
      .items.find((item) => item.id === task.id);
    expect(listItem?.description_md).toBeNull();

    const listFull = await call(a, 'task.list', {
      channel_key: CHANNEL,
      status: 'draft',
      include_description: true,
    });
    const fullItem = (
      listFull.data as { items: Array<{ id: string; description_md: string | null }> }
    ).items.find((item) => item.id === task.id);
    expect(fullItem?.description_md).toBe(body);

    const tree = await call(a, 'task.tree', { channel_key: CHANNEL, depth: 2 });
    const treeNode = (
      tree.data as Array<{ id: string; description_md: string | null }>
    ).find((node) => node.id === task.id);
    expect(treeNode?.description_md).toBeNull();

    const treeFull = await call(a, 'task.tree', {
      channel_key: CHANNEL,
      depth: 2,
      include_description: true,
    });
    const fullNode = (
      treeFull.data as Array<{ id: string; description_md: string | null }>
    ).find((node) => node.id === task.id);
    expect(fullNode?.description_md).toBe(body);
  });

  it('建议任务默认挂起在 draft，批准后才进入待认领', async () => {
    const { a } = await boot();
    const created = await call(a, 'task.create', {
      channel_key: CHANNEL,
      title: '建议：给迁移加自动回滚',
      kind: 'suggestion',
    });
    const task = (created.data as { task: { id: string; kind: string; status: string } }).task;
    expect(task.kind).toBe('suggestion');
    // 建议默认不提交：用户批准前必须停在 draft，不能混进待认领队列。
    expect(task.status).toBe('draft');

    const tree = await call(a, 'task.tree', { channel_key: CHANNEL, depth: 2 });
    const node = (tree.data as Array<{ id: string; kind: string }>).find(
      (item) => item.id === task.id,
    );
    expect(node?.kind).toBe('suggestion');

    // 批准路径：用户点“提交待认领”后，任务才进入 pending，后续才能 claim → start。
    const submitted = await call(a, 'task.update', { task_id: task.id, event: 'submit' });
    expect((submitted.data as { status: string }).status).toBe('pending');
  });

  it('task.list / task.tree 默认忽略完成与取消，显式筛选仍可查', async () => {
    const { a } = await boot();
    await call(a, 'harness.register', { harness_id: 'h-filter', name: 'h-filter' });

    // 父任务完成、子任务仍在队列：过滤时不能把活着的子任务一起藏掉。
    const parent = await call(a, 'task.create', {
      channel_key: CHANNEL,
      title: '已完成的父任务',
      submit: true,
    });
    const parentId = (parent.data as { task: { id: string } }).task.id;
    const child = await call(a, 'task.create', {
      channel_key: CHANNEL,
      title: '父任务下仍在进行的子任务',
      parent_id: parentId,
      submit: true,
    });
    const childId = (child.data as { task: { id: string } }).task.id;

    const claimed = await call(a, 'task.claim', { task_id: parentId, harness_id: 'h-filter' });
    const token = (claimed.data as { claim_token: string }).claim_token;
    await call(a, 'task.update', { task_id: parentId, event: 'start', claim_token: token });
    await call(a, 'card.post', {
      channel_key: CHANNEL,
      type: 'status',
      task_id: parentId,
      summary: '父任务完成',
      result: 'success',
    });
    await call(a, 'task.update', {
      task_id: parentId,
      event: 'complete',
      claim_token: token,
    });

    const cancelled = await call(a, 'task.create', {
      channel_key: CHANNEL,
      title: '已取消的任务',
      submit: true,
    });
    const cancelledId = (cancelled.data as { task: { id: string } }).task.id;
    await call(a, 'task.update', {
      task_id: cancelledId,
      event: 'cancel',
      reason: '测试取消',
    });

    const listed = await call(a, 'task.list', { channel_key: CHANNEL });
    const listedIds = (listed.data as { items: Array<{ id: string }> }).items.map(
      (item) => item.id,
    );
    expect(listedIds).toContain(childId);
    expect(listedIds).not.toContain(parentId);
    expect(listedIds).not.toContain(cancelledId);

    // 显式 status 优先于默认过滤：查历史不需要额外 include_closed。
    const done = await call(a, 'task.list', { channel_key: CHANNEL, status: 'done' });
    expect((done.data as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([
      parentId,
    ]);
    const cancelledOnly = await call(a, 'task.list', {
      channel_key: CHANNEL,
      status: 'cancelled',
    });
    expect(
      (cancelledOnly.data as { items: Array<{ id: string }> }).items.map((item) => item.id),
    ).toEqual([cancelledId]);

    const all = await call(a, 'task.list', { channel_key: CHANNEL, include_closed: true });
    const allIds = (all.data as { items: Array<{ id: string }> }).items.map((item) => item.id);
    expect(allIds).toEqual(expect.arrayContaining([parentId, childId, cancelledId]));

    // 默认树：完成父节点消失，未结束子节点提升到根；显式 include_closed 恢复层级。
    const tree = await call(a, 'task.tree', { channel_key: CHANNEL, depth: 2 });
    const roots = tree.data as Array<{ id: string; children: Array<{ id: string }> }>;
    expect(roots.some((node) => node.id === parentId)).toBe(false);
    expect(roots.some((node) => node.id === childId)).toBe(true);
    expect(roots.some((node) => node.id === cancelledId)).toBe(false);

    const fullTree = await call(a, 'task.tree', {
      channel_key: CHANNEL,
      depth: 2,
      include_closed: true,
    });
    const parentNode = (
      fullTree.data as Array<{ id: string; children: Array<{ id: string }> }>
    ).find((node) => node.id === parentId);
    expect(parentNode?.children.map((node) => node.id)).toContain(childId);
  });

  it('kb.search / kb.get 与 digest.get 的截断参数', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-kb-mcp-'));
    fs.mkdirSync(path.join(root, 'wiki'));
    fs.writeFileSync(
      path.join(root, 'wiki', 'deploy.md'),
      '---\ntype: runbook\ntags: [deploy]\n---\n# 发布手册\n\n发布前先备份数据库。\n',
      'utf8',
    );
    const { h, a } = await boot({ kbRoot: root });
    await api(a, 'POST', '/api/kb/reindex');

    const search = await call(a, 'kb.search', { query: '发布', tags: ['deploy'], top_k: 5 });
    expect((search.data as { items: Array<{ path: string }> }).items[0]?.path).toBe(
      'wiki/deploy.md',
    );

    const doc = await call(a, 'kb.get', { path: 'wiki/deploy.md' });
    expect((doc.data as { title: string }).title).toBe('发布手册');

    await call(a, 'card.post', {
      channel_key: CHANNEL,
      type: 'suggestion',
      title: '建议',
      analysis_md: '分析',
      suggestions: [{ text: '先备份' }],
      task_id: seedTask(h, CHANNEL, '发布前备份建议'),
    });
    const digest = await call(a, 'digest.get', {
      channel_key: CHANNEL,
      since: '2020-01-01T00:00:00.000Z',
      limit: 1,
    });
    const data = digest.data as { recent_suggestions: unknown[]; channels_active: number };
    expect(data.channels_active).toBe(1);
    expect(data.recent_suggestions.length).toBeLessThanOrEqual(1);
  });
});

describe('后台维护 worker', () => {
  it('一拍内完成租约回收、harness 离线与保留期归档', async () => {
    const h = createHarness({ cardRetentionDays: 1, kbIndexIntervalMs: 1_000 });
    harness = h;
    const ctx = { actorLabel: 'tester', requestId: 'req_worker', isOwner: true };
    h.ctx.repos.harnesses.upsert({
      harness_id: 'h-worker',
      name: 'h-worker',
      host: null,
      capabilities_json: null,
      now: h.clock.now(),
    });
    // 直接调服务时要自己套 schema：默认值（priority 等）由 zod 补齐，服务不做二次兜底。
    const card = h.ctx.services.cards.post(
      cardPostSchema.parse({
        channel_key: CHANNEL,
        type: 'info',
        title: '旧卡',
        body_md: '正文',
        severity: 'info',
        // 保留期清理不关心归属，但新契约要求非 question 卡必须有任务。
        task_id: seedTask(h, CHANNEL, '保留期归档承载任务'),
      }) as Parameters<TestHarness['ctx']['services']['cards']['post']>[0],
      ctx,
    ).card;
    const task = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '带租约的任务' }),
      ctx,
      { submit: true },
    ).task;
    h.ctx.services.tasks.claim(
      { task_id: task.id, harness_id: 'h-worker', lease_seconds: 60 },
      ctx,
    );

    // 把时钟推到两天后：租约过期、harness 超过离线阈值、卡片超过 1 天保留期。
    h.clock.advance(2 * 24 * 60 * 60 * 1000);
    const worker = createBackgroundWorker(h.ctx, h.log);
    worker.start();
    worker.start(); // 重复 start 不应叠加定时器
    worker.stop();
    worker.stop();

    expect(h.ctx.repos.tasks.get(task.id)?.status).toBe('pending');
    expect(h.ctx.repos.harnesses.get('h-worker')?.status).toBe('offline');
    expect(h.ctx.repos.cards.get(card.id)?.status).toBe('archived');
  });

  it('卡片保留天数取运行时设置，而不是启动配置', () => {
    // 启动配置只保留 1 天，页面把保留期改成 90 天：
    // 卡片是否归档必须以运行设置为准，否则设置页改了等于没改。
    const h = createHarness({ cardRetentionDays: 1 });
    harness = h;
    const ctx = { actorLabel: 'tester', requestId: 'req_retention_settings', isOwner: true };
    const card = h.ctx.services.cards.post(
      cardPostSchema.parse({
        channel_key: CHANNEL,
        type: 'info',
        title: '两天前的卡',
        body_md: '正文',
        severity: 'info',
        task_id: seedTask(h, CHANNEL, '运行时保留期承载任务'),
      }) as Parameters<TestHarness['ctx']['services']['cards']['post']>[0],
      ctx,
    ).card;

    h.ctx.services.settings.update({ card_retention_days: 90 }, ctx);
    h.clock.advance(2 * 24 * 60 * 60 * 1000);

    const worker = createBackgroundWorker(h.ctx, h.log);
    worker.start();
    worker.stop();

    // 2 天 < 90 天：读运行时设置时不归档；读启动配置（1 天）时这里会变成 archived。
    expect(h.ctx.repos.cards.get(card.id)?.status).toBe('open');
  });
});
