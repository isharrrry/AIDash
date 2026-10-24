import { afterEach, describe, expect, it } from 'vitest';
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
import { memoryAppendSchema } from '../src/shared/schemas.js';

// 只由 vitest 收集：验证“通道别名”这个展示层标签，
// 以及记忆 Tab 需要的“主对话列表”接口。全部用内存库，不碰真实 8787。
const CHANNEL = 'devhost/alias-proj/alias-topic';
const PROJECT = 'alias-proj';

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

function appendInput(lines: string[], overrides: Record<string, unknown> = {}) {
  return memoryAppendSchema.parse({ project: PROJECT, lines, ...overrides });
}

describe('通道别名：服务层', () => {
  it('新建通道时写入别名，列表视图直接可见', () => {
    const h = createHarness();
    try {
      const created = h.ctx.services.channels.ensure(
        { channel_key: CHANNEL, alias: '修复登录接口 500' },
        testCtx(),
      );
      expect(created.created).toBe(true);
      expect(created.channel.alias).toBe('修复登录接口 500');

      const listed = h.ctx.services.channels.list({ q: CHANNEL });
      expect(listed.items[0]?.alias).toBe('修复登录接口 500');
    } finally {
      h.close();
    }
  });

  it('自动 ensure 不带 alias 时不清空已有别名；显式传新值才覆盖', () => {
    const h = createHarness();
    try {
      h.ctx.services.channels.ensure({ channel_key: CHANNEL, alias: '第一版描述' }, testCtx());

      // 发卡/建任务也会走 ensure，它们通常不带 alias——不能因此把别名抹掉。
      h.ctx.services.channels.ensure({ channel_key: CHANNEL, title: '顺手补个标题' }, testCtx());
      expect(h.ctx.services.channels.getByKey(CHANNEL)?.alias).toBe('第一版描述');

      h.ctx.services.channels.ensure({ channel_key: CHANNEL, alias: '第二版描述' }, testCtx());
      expect(h.ctx.services.channels.getByKey(CHANNEL)?.alias).toBe('第二版描述');
    } finally {
      h.close();
    }
  });

  it('setAlias 允许清空，传相同值不刷 updated_at、不重复审计', () => {
    const h = createHarness();
    try {
      h.ctx.services.channels.ensure({ channel_key: CHANNEL, alias: '待清空' }, testCtx());
      const before = h.ctx.services.channels.getByKey(CHANNEL)!.updated_at;
      h.clock.advance(1_000);

      const same = h.ctx.services.channels.setAlias(CHANNEL, '待清空', testCtx());
      expect(same.alias).toBe('待清空');
      expect(h.ctx.services.channels.getByKey(CHANNEL)!.updated_at).toBe(before);

      // 空串与 null 都表示“没有别名”，展示层自行回退。
      expect(h.ctx.services.channels.setAlias(CHANNEL, '   ', testCtx()).alias).toBeNull();

      const rows = h.db
        .prepare(
          "SELECT action FROM audit_log WHERE object_type = 'channel' AND action = 'channel.alias'",
        )
        .all() as Array<{ action: string }>;
      expect(rows.length).toBe(1);
    } finally {
      h.close();
    }
  });

  it('别名命中敏感模式时拒绝写入', () => {
    const h = createHarness();
    try {
      h.ctx.services.channels.ensure({ channel_key: CHANNEL, title: '正常通道' }, testCtx());
      expect(() =>
        h.ctx.services.channels.setAlias(CHANNEL, 'token: abcdefghijklmnopqrstuvwxyz', testCtx()),
      ).toThrow(/SENSITIVE_PATTERN|INVALID_ARGUMENT/);
      expect(h.ctx.services.channels.getByKey(CHANNEL)?.alias).toBeNull();
    } finally {
      h.close();
    }
  });
});

describe('通道别名：REST', () => {
  it('PATCH alias 保存与清空都返回最新视图', async () => {
    const { a } = await boot();
    await api(a, 'POST', '/api/channels', { channel_key: CHANNEL, title: '联调通道' });

    const saved = await api<{ alias: string | null; channel_key: string }>(
      a,
      'PATCH',
      `/api/channels/${encodeURIComponent(CHANNEL)}`,
      { alias: '任务树界面改造' },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ alias: '任务树界面改造', channel_key: CHANNEL });

    const cleared = await api<{ alias: string | null }>(
      a,
      'PATCH',
      `/api/channels/${encodeURIComponent(CHANNEL)}`,
      { alias: null },
    );
    expect(cleared.body.data?.alias).toBeNull();
  });

  it('PATCH 空对象被 400 拒绝，而不是“200 但什么都没发生”', async () => {
    const { a } = await boot();
    await api(a, 'POST', '/api/channels', { channel_key: CHANNEL });
    const empty = await api(a, 'PATCH', `/api/channels/${encodeURIComponent(CHANNEL)}`, {});
    expect(empty.status).toBe(400);
  });

  it('列表 q 能按别名命中通道', async () => {
    const { a } = await boot();
    await api(a, 'POST', '/api/channels', {
      channel_key: CHANNEL,
      alias: '登录白名单排查',
    });
    const hit = await api<{ total: number; items: Array<{ channel_key: string }> }>(
      a,
      'GET',
      '/api/channels?q=白名单',
    );
    expect(hit.body.data?.total).toBe(1);
    expect(hit.body.data?.items[0]?.channel_key).toBe(CHANNEL);
  });
});

describe('通道别名：MCP', () => {
  it('channel.upsert 接受 alias 并在回执返回；不带 alias 不清空', async () => {
    const { a } = await boot();
    const first = await mcp(a, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'channel.upsert',
        arguments: { channel_key: CHANNEL, alias: '给用户看的一句话' },
      },
    });
    expect(mcpToolData(first)).toMatchObject({
      channel_key: CHANNEL,
      alias: '给用户看的一句话',
      created: true,
    });

    const second = await mcp(a, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'channel.upsert', arguments: { channel_key: CHANNEL, title: '补标题' } },
    });
    expect(mcpToolData(second)).toMatchObject({ alias: '给用户看的一句话', created: false });
  });
});

describe('记忆项目列表：服务层', () => {
  it('只有通道、还没写记忆的项目也会列出', () => {
    const h = createHarness();
    try {
      h.ctx.services.channels.ensure({ channel_key: CHANNEL }, testCtx());
      const projects = h.ctx.services.memory.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({
        project: PROJECT,
        has_memory: false,
        version: 0,
        line_count: 0,
        channel_count: 1,
        active_channel_count: 1,
        updated_at: null,
      });
    } finally {
      h.close();
    }
  });

  it('主对话列表带别名：取活跃优先、最近更新的通道别名', () => {
    const h = createHarness();
    try {
      h.ctx.services.channels.ensure(
        { channel_key: CHANNEL, alias: '旧别名' },
        testCtx(),
      );
      h.clock.advance(1_000);
      // 同一 project 下再建一条更新的话题通道：列表应展示更新的别名。
      h.ctx.services.channels.ensure(
        { channel_key: 'devhost/alias-proj/newer-topic', alias: '新别名' },
        testCtx(),
      );

      const projects = h.ctx.services.memory.listProjects();
      expect(projects[0]).toMatchObject({ project: PROJECT, alias: '新别名' });
    } finally {
      h.close();
    }
  });

  it('写入记忆后带版本/行数/更新时间，并按最近更新倒序', () => {
    const h = createHarness();
    try {
      h.ctx.services.channels.ensure({ channel_key: CHANNEL }, testCtx());
      h.ctx.services.channels.ensure({ channel_key: 'devhost/other-proj/topic' }, testCtx());

      h.clock.advance(1_000);
      h.ctx.services.memory.append(appendInput(['- [deploy] 发布前先备份']), testCtx());

      // 第二条项目写得更晚：排序应把它放前面，而不是按项目名字母序。
      h.clock.advance(1_000);
      h.ctx.services.memory.append(
        memoryAppendSchema.parse({
          project: 'other-proj',
          lines: ['- [auth] 白名单未放行会 500'],
        }),
        testCtx(),
      );

      const projects = h.ctx.services.memory.listProjects();
      expect(projects.map((project) => project.project)).toEqual(['other-proj', PROJECT]);
      expect(projects[1]).toMatchObject({
        has_memory: true,
        version: 1,
        line_count: 1,
      });
      expect(projects[1]?.updated_at).toBe(new Date(h.clock.now() - 1_000).toISOString());
    } finally {
      h.close();
    }
  });
});

describe('记忆项目列表：REST', () => {
  it('GET /api/memory/projects 返回主对话与共用通道数', async () => {
    const { a } = await boot();
    await api(a, 'POST', '/api/channels', { channel_key: CHANNEL });
    await api(a, 'PUT', '/api/memory', {
      project: PROJECT,
      content_md: '- [deploy] 先备份',
      expected_version: 0,
    });

    const result = await api<
      Array<{ project: string; has_memory: boolean; line_count: number; channel_count: number }>
    >(a, 'GET', '/api/memory/projects');
    expect(result.status).toBe(200);
    expect(result.body.data).toHaveLength(1);
    expect(result.body.data?.[0]).toMatchObject({
      project: PROJECT,
      has_memory: true,
      line_count: 1,
      channel_count: 1,
    });
  });
});
