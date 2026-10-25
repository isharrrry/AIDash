import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  createHarness,
  questionPayload,
  seedTask,
  startApp,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

const CHANNEL = 'devhost/myproj/routes';

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

function registerHarness(h: TestHarness, id = 'h-routes'): void {
  h.ctx.repos.harnesses.upsert({
    harness_id: id,
    name: id,
    host: null,
    capabilities_json: null,
    now: h.clock.now(),
  });
}

const info = {
  channel_key: CHANNEL,
  type: 'info',
  title: '例行通知',
  body_md: '正文',
  severity: 'info',
};

describe('通道路由', () => {
  it('创建、列表、按 id 归档、按 key 恢复', async () => {
    const { a } = await boot();
    const created = await api<{ channel: { id: string; channel_key: string }; created: boolean }>(
      a,
      'POST',
      '/api/channels',
      { channel_key: CHANNEL, title: '联调通道' },
    );
    expect(created.status).toBe(201);
    expect(created.body.data?.created).toBe(true);

    const again = await api<{ created: boolean }>(a, 'POST', '/api/channels', {
      channel_key: CHANNEL,
      title: '改名后的通道',
    });
    // 已存在时不重复建，但仍然返回同一条通道。
    expect(again.status).toBe(200);
    expect(again.body.data?.created).toBe(false);

    const id = created.body.data!.channel.id;
    const archived = await api<{ status: string }>(a, 'PATCH', `/api/channels/${id}`, {
      status: 'archived',
    });
    expect(archived.body.data?.status).toBe('archived');

    const visible = await api<{ total: number }>(a, 'GET', '/api/channels');
    expect(visible.body.data?.total).toBe(0);
    const all = await api<{ total: number }>(a, 'GET', '/api/channels?include_archived=true');
    expect(all.body.data?.total).toBe(1);

    // 前端拿不到 id 时也可能直接拿 key。
    const restored = await api<{ status: string }>(
      a,
      'PATCH',
      `/api/channels/${encodeURIComponent(CHANNEL)}`,
      { status: 'active' },
    );
    expect(restored.body.data?.status).toBe('active');

    const searched = await api<{ total: number }>(a, 'GET', '/api/channels?q=改名');
    expect(searched.body.data?.total).toBe(1);
  });
});

describe('任务路由', () => {
  it('创建草稿、提交、列表、树、补丁、认领、释放', async () => {
    const { a, h } = await boot();
    registerHarness(h);

    const draft = await api<{ task: { id: string; status: string } }>(a, 'POST', '/api/tasks', {
      channel_key: CHANNEL,
      title: '草稿任务',
    });
    expect(draft.status).toBe(201);
    expect(draft.body.data?.task.status).toBe('draft');

    const submitted = await api<{ task: { id: string; status: string } }>(a, 'POST', '/api/tasks', {
      channel_key: CHANNEL,
      title: '待认领任务',
      submit: true,
      priority: 'P1',
      tags: ['联调'],
    });
    const taskId = submitted.body.data!.task.id;
    expect(submitted.body.data?.task.status).toBe('pending');

    const list = await api<{ total: number }>(a, 'GET', '/api/tasks?status=pending');
    expect(list.body.data?.total).toBe(1);

    const badStatus = await api(a, 'GET', '/api/tasks?status=nope');
    expect(badStatus.status).toBe(400);

    const tree = await api<unknown[]>(
      a,
      'GET',
      `/api/tasks/tree?channel_key=${encodeURIComponent(CHANNEL)}&depth=3`,
    );
    expect(tree.body.data).toHaveLength(2);

    const patched = await api<{ title: string; priority: string }>(a, 'PATCH', `/api/tasks/${taskId}`, {
      patch: { title: '改过名的任务', priority: 'P0' },
    });
    expect(patched.body.data?.title).toBe('改过名的任务');
    expect(patched.body.data?.priority).toBe('P0');

    const claimed = await api<{ task: { status: string }; claim_token: string }>(
      a,
      'POST',
      `/api/tasks/${taskId}/claim`,
      { harness_id: 'h-routes', lease_seconds: 120 },
    );
    expect(claimed.body.data?.task.status).toBe('claimed');
    const token = claimed.body.data!.claim_token;

    const wrongToken = await api(a, 'POST', `/api/tasks/${taskId}/release`, {
      claim_token: 'cl_wrong',
    });
    expect(wrongToken.status).toBe(403);

    const released = await api<{ status: string }>(a, 'POST', `/api/tasks/${taskId}/release`, {
      claim_token: token,
      reason: '换人',
    });
    expect(released.body.data?.status).toBe('pending');
  });

  it('10 个 harness 并发认领同一任务，恰好 1 个成功', async () => {
    const { a, h } = await boot();
    for (let index = 0; index < 10; index += 1) registerHarness(h, `h-race-${index}`);
    const created = await api<{ task: { id: string } }>(a, 'POST', '/api/tasks', {
      channel_key: CHANNEL,
      title: '并发认领',
      submit: true,
    });
    const taskId = created.body.data!.task.id;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api(a, 'POST', `/api/tasks/${taskId}/claim`, {
          harness_id: `h-race-${index}`,
          lease_seconds: 60,
        }),
      ),
    );
    const succeeded = results.filter((result) => result.status === 200);
    const conflicts = results.filter((result) => result.status === 409);
    expect(succeeded).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    // 只有一个 claim_token 真正落库，其余调用不能留下半认领状态。
    const row = h.ctx.repos.tasks.get(taskId)!;
    expect(row.status).toBe('claimed');
    // 响应只回任务视图与 token，不回 claimed_by；从库里确认赢家是 10 个之一。
    expect(row.claimed_by).toMatch(/^h-race-\d$/);
    expect(
      (succeeded[0]!.body.data as { claim_token: string }).claim_token,
    ).toMatch(/^cl_/);
  });

  it('移动与复制保持父子关系', async () => {
    const { a } = await boot();
    const root = await api<{ task: { id: string } }>(a, 'POST', '/api/tasks', {
      channel_key: CHANNEL,
      title: 'root',
      submit: true,
    });
    const child = await api<{ task: { id: string } }>(a, 'POST', '/api/tasks', {
      channel_key: CHANNEL,
      title: 'child',
      parent_id: root.body.data!.task.id,
      submit: true,
    });

    const moved = await api<{ parent_id: string | null }>(
      a,
      'POST',
      `/api/tasks/${child.body.data!.task.id}/move`,
      { new_parent_id: null },
    );
    expect(moved.body.data?.parent_id).toBeNull();

    const copied = await api<{ copied: number; task: { status: string } }>(
      a,
      'POST',
      `/api/tasks/${child.body.data!.task.id}/copy`,
      { new_parent_id: root.body.data!.task.id },
    );
    expect(copied.body.data?.copied).toBe(1);
    expect(copied.body.data?.task.status).toBe('draft');

    const found = await api<{ id: string }>(a, 'GET', `/api/tasks/${child.body.data!.task.id}`);
    expect(found.body.data?.id).toBe(child.body.data!.task.id);
    const missing = await api(a, 'GET', '/api/tasks/tk_not_exists');
    expect(missing.status).toBe(404);
  });
});

describe('卡片路由', () => {
  it('改标题/优先级、按 id 读取、检索与非法过滤', async () => {
    const { h, a } = await boot();
    const created = await api<{ card: { id: string } }>(a, 'POST', '/api/cards', {
      ...info,
      task_id: seedTask(h, CHANNEL),
    });
    const cardId = created.body.data!.card.id;

    const patched = await api<{ title: string; priority: string }>(
      a,
      'PATCH',
      `/api/cards/${cardId}`,
      { title: '改过的标题', priority: 'P0' },
    );
    expect(patched.body.data?.title).toBe('改过的标题');
    expect(patched.body.data?.priority).toBe('P0');

    const fetched = await api<{ id: string }>(a, 'GET', `/api/cards/${cardId}`);
    expect(fetched.body.data?.id).toBe(cardId);

    const searched = await api<{ total: number }>(a, 'GET', '/api/cards?q=改过的标题');
    expect(searched.body.data?.total).toBe(1);

    expect((await api(a, 'GET', '/api/cards?type=bogus')).status).toBe(400);
    expect((await api(a, 'GET', '/api/cards?sort=bogus')).status).toBe(400);
    expect((await api(a, 'GET', '/api/cards?page_size=500')).status).toBe(400);
    expect((await api(a, 'GET', '/api/cards/cd_missing')).status).toBe(404);
  });

  it('自由文本回答、批量回答、忽略与归档、交接状态推进', async () => {
    const { h, a } = await boot();
    // 统一用工厂保证四段背景与选项角色合法；这个用例只关心回答/批量/忽略/归档语义。
    const question = (title: string, allowFreeText = false) =>
      api<{ card: { id: string } }>(
        a,
        'POST',
        '/api/cards',
        questionPayload({
          channel_key: CHANNEL,
          type: 'question',
          title,
          allow_free_text: allowFreeText,
        }),
      );

    const free = await question('自由文本', true);
    const answered = await api<{ status: string; answer: { free_text: string } }>(
      a,
      'POST',
      `/api/cards/${free.body.data!.card.id}/answer`,
      { free_text: '补充说明' },
    );
    expect(answered.body.data?.status).toBe('answered');
    expect(answered.body.data?.answer.free_text).toBe('补充说明');

    const first = await question('批量一');
    const second = await question('批量二');
    const batch = await api<{ success_count: number; failure_count: number }>(
      a,
      'POST',
      '/api/cards/batch-answer',
      {
        items: [
          { card_id: first.body.data!.card.id, answer: { option_id: 'yes' } },
          { card_id: second.body.data!.card.id, answer: { option_id: 'no' } },
        ],
      },
    );
    expect(batch.body.data?.success_count).toBe(2);
    expect(batch.body.data?.failure_count).toBe(0);

    // 已回答的卡不能再忽略；另发一张保持 open 的卡验证忽略语义。
    const dismissable = await question('待忽略');
    const dismissed = await api<{ status: string }>(
      a,
      'POST',
      `/api/cards/${dismissable.body.data!.card.id}/dismiss`,
    );
    expect(dismissed.body.data?.status).toBe('dismissed');

    const archived = await api<{ status: string }>(
      a,
      'POST',
      `/api/cards/${second.body.data!.card.id}/archive`,
    );
    expect(archived.body.data?.status).toBe('archived');

    const handoff = await api<{ card: { id: string } }>(a, 'POST', '/api/cards', {
      channel_key: CHANNEL,
      type: 'handoff',
      recipient: '运维同学',
      channel_kind: 'wechat',
      reason: '确认白名单',
      message_md: '运维同学您好，请确认 192.0.2.15 是否放行。',
      task_id: seedTask(h, CHANNEL, '交接白名单确认'),
    });
    const sent = await api<{ handoff_state: string }>(
      a,
      'POST',
      `/api/cards/${handoff.body.data!.card.id}/handoff`,
      { state: 'sent' },
    );
    expect(sent.body.data?.handoff_state).toBe('sent');
  });
});

describe('知识库路由', () => {
  it('配置根目录后重建索引、检索、读取、统计', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-kb-http-'));
    fs.mkdirSync(path.join(root, 'wiki'));
    fs.writeFileSync(
      path.join(root, 'wiki', 'login.md'),
      '---\ntype: runbook\ntags: [auth]\n---\n# 登录排查\n\n登录失败先查网关白名单。\n',
      'utf8',
    );
    const { a, h } = await boot({ kbRoot: root });

    const reindex = await api<{ indexed: number }>(a, 'POST', '/api/kb/reindex');
    expect(reindex.body.data?.indexed).toBe(1);

    const search = await api<{ items: Array<{ path: string }> }>(a, 'GET', '/api/kb/search?q=登录');
    expect(search.body.data?.items[0]?.path).toBe('wiki/login.md');

    const tagged = await api<{ items: unknown[] }>(a, 'GET', '/api/kb/search?q=登录&tags=auth');
    expect(tagged.body.data?.items).toHaveLength(1);

    const doc = await api<{ title: string }>(
      a,
      'GET',
      `/api/kb/doc?path=${encodeURIComponent('wiki/login.md')}`,
    );
    expect(doc.body.data?.title).toBe('登录排查');

    const docs = await api<{ total: number }>(a, 'GET', '/api/kb/docs');
    expect(docs.body.data?.total).toBe(1);

    const stats = await api<{ docs: number; configured: boolean }>(a, 'GET', '/api/kb/stats');
    expect(stats.body.data?.docs).toBe(1);
    expect(stats.body.data?.configured).toBe(true);

    expect((await api(a, 'GET', '/api/kb/search')).status).toBe(400);
    expect((await api(a, 'GET', '/api/kb/doc')).status).toBe(400);
    expect(h.ctx.services.kb.isConfigured()).toBe(true);
  });
});

describe('静态页面与鉴权边界', () => {
  it('页面与静态资源无需令牌，API 与 MCP 仍要求认证', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-static-'));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>面板</title>', 'utf8');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)', 'utf8');
    const { a } = await boot({ staticDir: root });

    // 浏览器导航不会带 Authorization；页面必须能先打开，再由页面内输入令牌。
    const index = await api(a, 'GET', '/', undefined, { token: null });
    expect(index.status).toBe(200);
    expect(index.text).toContain('面板');

    const asset = await api(a, 'GET', '/assets/app.js', undefined, { token: null });
    expect(asset.status).toBe(200);
    expect(asset.text).toContain('console.log(1)');

    // hash 路由在浏览器里不会请求深链；这里验证万一请求了也会回退到页面。
    const deep = await api(a, 'GET', '/tasks', undefined, { token: null });
    expect(deep.status).toBe(200);
    expect(deep.text).toContain('面板');

    // 数据边界没有放松：API 与 MCP 仍然要正确令牌。
    expect((await api(a, 'GET', '/api/health', undefined, { token: null })).status).toBe(401);
    expect((await api(a, 'GET', '/api/health', undefined, { token: 'wrong' })).status).toBe(401);
    const mcpNoToken = await fetch(`${a.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(mcpNoToken.status).toBe(401);
  });
});

describe('管理路由', () => {
  it('设置可改，但密钥与越界值被拒', async () => {
    const { a } = await boot();
    const patched = await api<{
      enrichment: { enabled: boolean };
      retention: { card_days: number };
    }>(a, 'PATCH', '/api/settings', {
      enrichment_enabled: true,
      llm_endpoint: 'https://example.com/v1',
      llm_model: 'model-x',
      card_retention_days: 90,
      kb_root: null,
    });
    expect(patched.body.data?.enrichment.enabled).toBe(true);
    expect(patched.body.data?.retention.card_days).toBe(90);

    const view = await api<{ token: { label: string; configured: boolean } }>(
      a,
      'GET',
      '/api/settings',
    );
    // 06 SAFE-002：只回 configured；掩码尾号同样算泄露。
    expect(view.body.data?.token).toEqual({ label: 'tester', configured: true });
    expect(view.text).not.toContain('test-token-for-aidash');
    // 设置页只暴露密钥文件路径，不暴露内容；路径里的产品名是预期，不是泄露。
    expect(view.text).toContain('secrets.json');

    expect(
      (await api(a, 'PATCH', '/api/settings', { llm_endpoint: 'ftp://example.com' })).body.error
        ?.message,
    ).toBe('UNSAFE_URL_SCHEME');
    expect(
      (await api(a, 'PATCH', '/api/settings', { card_retention_days: 1 })).body.error?.message,
    ).toBe('SETTING_OUT_OF_RANGE');
  });

  it('harness 列表与状态修改，未知 harness 返回 404', async () => {
    const { a, h } = await boot();
    registerHarness(h, 'h-admin');
    const list = await api<Array<{ harness_id: string; capabilities: string[] }>>(
      a,
      'GET',
      '/api/harnesses',
    );
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data![0]!.capabilities).toEqual([]);

    const patched = await api<{ status: string }>(a, 'PATCH', '/api/harnesses/h-admin', {
      status: 'disabled',
    });
    expect(patched.body.data?.status).toBe('disabled');

    const missing = await api(a, 'PATCH', '/api/harnesses/h-missing', { status: 'offline' });
    expect(missing.status).toBe(404);
  });

  it('审计支持时间与动作过滤，非法枚举返回 400', async () => {
    const { h, a } = await boot();
    await api(a, 'POST', '/api/cards', { ...info, task_id: seedTask(h, CHANNEL) });
    const since = new Date(Date.parse('2025-01-01T00:00:00Z')).toISOString();
    const filtered = await api<{ total: number }>(
      a,
      'GET',
      `/api/audit?since=${encodeURIComponent(since)}&action=card.post&object_type=card`,
    );
    expect(filtered.body.data?.total).toBeGreaterThan(0);
    expect((await api(a, 'GET', '/api/audit?result=bogus')).status).toBe(400);
    expect((await api(a, 'GET', '/api/audit?since=not-a-time')).status).toBe(400);
  });

  it('request-id 透传，便于把页面操作与审计对上', async () => {
    const { a } = await boot();
    const result = await api(a, 'GET', '/api/health', undefined, {
      headers: { 'x-request-id': 'trace-123' },
    });
    expect(result.headers.get('x-request-id')).toBe('trace-123');
  });

  it('限流按分钟窗口返回 RATE_LIMITED 与 retry-after', async () => {
    const { a } = await boot({ rateLimitPerMinute: 1 });
    // /healthz 是探活端点，刻意不占限流额度。
    expect((await api(a, 'GET', '/healthz')).status).toBe(200);
    expect((await api(a, 'GET', '/api/health')).status).toBe(200);
    const limited = await api(a, 'GET', '/api/health');
    expect(limited.status).toBe(429);
    expect(limited.body.error?.message).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
