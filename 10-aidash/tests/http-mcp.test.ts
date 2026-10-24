import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  createHarness,
  mcp,
  mcpToolData,
  questionOption,
  questionOptions,
  questionPayload,
  seedTask,
  startApp,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

const CHANNEL = 'devhost/myproj/http-test';

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

const infoCard = {
  channel_key: CHANNEL,
  type: 'info',
  title: '部署完成',
  body_md: '版本 v2.0.0 已上线',
  severity: 'info',
};

describe('REST 接入', () => {
  it('缺少令牌返回 401，healthz 无需令牌', async () => {
    const { a } = await boot();
    const unauthorized = await api(a, 'GET', '/api/digest', undefined, { token: null });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error?.code).toBe('UNAUTHORIZED');

    const health = await api(a, 'GET', '/healthz', undefined, { token: null });
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    // 探活必须能回答“连的是哪个库”，否则路径漂移时空库也会显示健康。
    expect(health.body.db_path).toBe(':memory:');
  });

  it('发卡、列表、摘要、审计串成一条链', async () => {
    const { h, a } = await boot();
    // 非 question 卡必须挂任务：先建承载任务，再发卡。
    const created = await api<{ card: { id: string } }>(a, 'POST', '/api/cards', {
      ...infoCard,
      task_id: seedTask(h, CHANNEL),
    });
    expect(created.status).toBe(201);
    expect(created.body.data?.card.id).toMatch(/^cd_/);

    const list = await api<{ total: number; items: Array<{ title: string }> }>(
      a,
      'GET',
      `/api/cards?channel_key=${encodeURIComponent(CHANNEL)}`,
    );
    expect(list.body.data?.total).toBe(1);
    expect(list.body.data?.items[0]?.title).toBe('部署完成');

    const digest = await api<{ pending_decisions: number }>(a, 'GET', '/api/digest');
    expect(digest.body.data?.pending_decisions).toBe(0);

    const audit = await api<{ total: number }>(a, 'GET', '/api/audit?page_size=10');
    expect(audit.body.data?.total).toBeGreaterThan(0);
  });

  it('参数不合法返回 VALIDATION_FAILED，未知 API 返回 JSON 404', async () => {
    const { a } = await boot();
    // 四段背景齐全、选项字段也齐全，只留“只有一个选项”这一处非法，
    // 保证这个用例仍然只验证“缺选项被拒”，不会因为别的新规则提前失败。
    const invalid = await api(a, 'POST', '/api/cards', {
      ...questionPayload({
        channel_key: CHANNEL,
        title: '缺选项',
        options: [questionOption('only', 'primary')],
      }),
      type: 'question',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error?.code).toBe('INVALID_ARGUMENT');
    expect(invalid.body.error?.message).toBe('VALIDATION_FAILED');

    const missing = await api(a, 'GET', '/api/not-exists');
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe('NOT_FOUND');
  });

  it('ask 阻塞等待，网页回答后同一个请求返回 answered', async () => {
    const { a } = await boot();
    const asking = api<{ status: string; answer?: { option_id: string } }>(
      a,
      'POST',
      '/api/ask',
      questionPayload({
        channel_key: CHANNEL,
        title: '先回滚还是先修？',
        options: questionOptions(['rollback', 'fix']),
        wait_seconds: 5,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const open = await api<{ items: Array<{ id: string }> }>(
      a,
      'GET',
      `/api/cards?channel_key=${encodeURIComponent(CHANNEL)}&type=question&status=open`,
    );
    const cardId = open.body.data?.items[0]?.id;
    expect(cardId).toBeTruthy();

    const answered = await api(a, 'POST', `/api/cards/${cardId}/answer`, { option_id: 'fix' });
    expect(answered.status).toBe(200);

    const result = await asking;
    expect(result.body.data?.status).toBe('answered');
    expect(result.body.data?.answer?.option_id).toBe('fix');
  });

  it('设置页可写密钥但不回显，健康与指标可读', async () => {
    const { a } = await boot();
    const saved = await api(a, 'PATCH', '/api/settings', {
      llm_api_key: 'sk-should-not-be-stored',
    });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain('sk-should-not-be-stored');

    const health = await api<{ status: string; audit_chain: { ok: boolean } }>(
      a,
      'GET',
      '/api/health',
    );
    expect(health.body.data?.status).toBe('ok');
    expect(health.body.data?.audit_chain.ok).toBe(true);

    const metrics = await api<{ cards_by_status: Record<string, number> }>(a, 'GET', '/api/metrics');
    expect(metrics.body.data?.cards_by_status).toEqual({});
  });

  it('备份产出可读文件', async () => {
    const { a, h } = await boot();
    const result = await api<{ file: string; size_bytes: number }>(a, 'POST', '/api/backup');
    expect(result.status).toBe(200);
    expect(result.body.data?.size_bytes).toBeGreaterThan(0);
    expect(fs.existsSync(result.body.data!.file)).toBe(true);
    expect(result.body.data!.file.startsWith(h.config.backupDir)).toBe(true);
  });
});

describe('MCP 接入', () => {
  it('initialize 与 tools/list 返回 23 个工具', async () => {
    const { a } = await boot();
    const init = await mcp(a, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1.0.0' },
      },
    });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('aidash');

    const list = await mcp(a, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(23);
    expect(tools.map((tool) => tool.name)).toContain('card.ask');
    expect(tools.map((tool) => tool.name)).toContain('digest.get');
    expect(tools.map((tool) => tool.name)).toContain('memory.append');
  });

  it('tools/call 走通发卡、摘要与 harness 注册', async () => {
    const { h, a } = await boot();
    const posted = await mcp(a, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'card.post',
        arguments: { ...infoCard, task_id: seedTask(h, CHANNEL) },
      },
    });
    const card = mcpToolData(posted) as { card: { id: string } };
    expect(card.card.id).toMatch(/^cd_/);

    const digest = await mcp(a, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'digest.get', arguments: {} },
    });
    const data = mcpToolData(digest) as { channels_active: number };
    expect(data.channels_active).toBe(1);

    const registered = await mcp(a, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'harness.register',
        arguments: { harness_id: 'h1', name: '测试 harness', capabilities: ['code'] },
      },
    });
    expect((mcpToolData(registered) as { harness_id: string }).harness_id).toBe('h1');
  });

  it('工具级错误以 isError 返回，不破坏协议层', async () => {
    const { h, a } = await boot();
    const result = await mcp(a, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'card.post',
        arguments: {
          channel_key: CHANNEL,
          type: 'info',
          title: '配置',
          body_md: 'password: supersecret123',
          severity: 'warn',
          // 补上归属，确保失败点确实是敏感模式，而不是“缺 task_id”抢跑。
          task_id: seedTask(h, CHANNEL),
        },
      },
    });
    expect(result.result).toMatchObject({ isError: true });
    const text = (result.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('SENSITIVE_PATTERN_DETECTED');
  });

  it('MCP 同样要求 Bearer 令牌，GET 返回 405', async () => {
    const { a } = await boot();
    const res = await fetch(`${a.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);

    const get = await api(a, 'GET', '/mcp');
    expect(get.status).toBe(405);
  });

  it('MCP 注册的 harness 可以被 REST 任务认领复用', async () => {
    const { a } = await boot();
    await mcp(a, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'harness.register',
        arguments: { harness_id: 'h-rest', name: 'h-rest' },
      },
    });
    const created = await api<{ task: { id: string } }>(a, 'POST', '/api/tasks', {
      channel_key: CHANNEL,
      title: '联调任务',
      submit: true,
    });
    const taskId = created.body.data?.task.id;
    expect(taskId).toBeTruthy();

    const claimed = await api<{ task: { status: string } }>(
      a,
      'POST',
      `/api/tasks/${taskId}/claim`,
      { harness_id: 'h-rest' },
    );
    expect(claimed.body.data?.task.status).toBe('claimed');
  });
});
