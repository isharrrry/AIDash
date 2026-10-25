import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { taskCreateSchema } from '../src/shared/schemas.js';
import { ManualClock } from '../src/shared/time.js';
import type { Ctx } from '../src/shared/types.js';
import { loadConfig, type AppConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import { openDb, type Db } from '../src/server/db/connection.js';
import { migrate } from '../src/server/db/migrate.js';
import { createApp } from '../src/server/http/app.js';
import type { Logger } from '../src/server/log.js';
import { buildContext } from '../src/server/main.js';

export const TEST_TOKEN = 'test-token-for-aidash';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface TestHarness {
  ctx: AppContext;
  db: Db;
  clock: ManualClock;
  config: AppConfig;
  log: Logger;
  close(): void;
}

/**
 * 每个测试一套独立的内存库。
 * 为什么用 :memory: 而不是临时文件：迁移与 WAL 都不留残留，
 * 测试之间不会因为上一个用例的审计链/租约互相影响。
 */
export function createHarness(overrides: Partial<AppConfig> = {}): TestHarness {
  const db = openDb(':memory:');
  migrate(db);
  const base = loadConfig(
    { AIDASH_TOKEN: TEST_TOKEN, AIDASH_TOKEN_LABEL: 'tester' },
    { configFile: path.join(os.tmpdir(), `aidash-no-config-${process.pid}.json`) },
  );
  // 密钥文件必须落在临时目录：默认 secretDir 是用户的 ~/.aidash，
  // 让测试写真实主密钥既污染环境，也会让用例之间互相看到对方的 key。
  const ownsSecretDir = overrides.secretDir === undefined;
  const secretDir = overrides.secretDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-secret-'));
  const config: AppConfig = {
    ...base,
    dbPath: ':memory:',
    staticDir: path.join(os.tmpdir(), `aidash-no-web-${process.pid}`),
    backupDir: path.join(os.tmpdir(), `aidash-backups-${process.pid}`),
    secretDir,
    enrichmentEnabled: false,
    logLevel: 'error',
    ...overrides,
  };
  const clock = new ManualClock();
  const ctx = buildContext(config, db, silentLogger, clock);
  return {
    ctx,
    db,
    clock,
    config,
    log: silentLogger,
    close: () => {
      // 先停掉后台服务再关库：卡片服务里的 setTimeout(0) 增强调度
      // 可能在用例结束之后才触发，直接关库会变成“database is not open”的未处理拒绝。
      ctx.services.decisions.cancelAll();
      ctx.services.enrichment.stop();
      ctx.services.memoryDigest.stop();
      db.close();
      if (ownsSecretDir) fs.rmSync(secretDir, { recursive: true, force: true });
    },
  };
}

export function testCtx(requestId = `req_test_${Math.random().toString(36).slice(2)}`): Ctx {
  return { actorLabel: 'tester', requestId, isOwner: true };
}

/**
 * 建一条“承载卡片”的草稿任务并返回 id。
 *
 * 为什么测试需要它：本版起 info/handoff/suggestion/status/artifact 必须挂任务
 * （用户要求信息流归到任务下，决策台只留拍板队列）。用例只关心卡片本身时，
 * 先 seed 一条同通道任务，再把 id 填进 card.post，避免每处重复写建任务的样板。
 *
 * 停在 draft 是有意的：发卡不要求任务已提交，只要求同通道且存在。
 */
export function seedTask(
  harness: TestHarness,
  channelKey: string,
  title = '承载卡片的测试任务',
): string {
  return harness.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: channelKey, title }),
    testCtx(),
  ).task.id;
}

export interface RunningApp {
  base: string;
  server: Server;
  app: Express;
  close(): Promise<void>;
}

export async function startApp(harness: TestHarness): Promise<RunningApp> {
  const app = createApp(harness.ctx, harness.log);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    server,
    app,
    close: async () => {
      // 先让阻塞中的 card.ask 释放等待者，否则 close 会等到超时。
      harness.ctx.services.decisions.cancelAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } };
  text: string;
  headers: Headers;
}

export async function api<T = unknown>(
  app: RunningApp,
  method: string,
  pathName: string,
  body?: unknown,
  options: { token?: string | null; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const token = options.token === undefined ? TEST_TOKEN : options.token;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };
  const res = await fetch(`${app.base}${pathName}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: ApiResponse<T>['body'];
  try {
    parsed = JSON.parse(text) as ApiResponse<T>['body'];
  } catch {
    parsed = { ok: false };
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

/** MCP 在 JSON 模式下返回单条 JSON；兼容 SSE 模式的解析，避免 SDK 行为变化时测试假红。 */
export async function mcp(
  app: RunningApp,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${app.base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());
    const last = dataLines[dataLines.length - 1];
    if (!last) throw new Error(`empty SSE response: ${text.slice(0, 200)}`);
    return JSON.parse(last) as Record<string, unknown>;
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`invalid MCP response (${res.status}): ${text.slice(0, 500)}`);
  }
}

export function mcpToolData(result: Record<string, unknown>): unknown {
  const content = (result.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  const text = content?.[0]?.text;
  if (!text) throw new Error(`missing MCP content: ${JSON.stringify(result)}`);
  const parsed = JSON.parse(text) as { ok: boolean; data?: unknown; error?: unknown };
  if (!parsed.ok) throw new Error(`MCP tool failed: ${JSON.stringify(parsed.error)}`);
  return parsed.data;
}

/**
 * 决策项工厂：默认把前两项分别设为主推荐/备选推荐，其余为普通项。
 * 为什么要工厂：四段背景 + 每项优缺点 + 角色校验是“新卡必填”，
 * 每个用例手写一遍既啰嗦又容易漏掉某个字段，导致测试失败点漂移。
 */
export function questionOption(
  id: string,
  role: 'primary' | 'backup' | null = null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    label: `选项-${id}`,
    pros_md: `优点：${id} 能立刻执行`,
    cons_md: `缺点：${id} 需要额外确认`,
    recommendation_role: role,
    ...overrides,
  };
}

export function questionOptions(ids: string[] = ['yes', 'no']): Array<Record<string, unknown>> {
  return ids.map((id, index) =>
    questionOption(id, index === 0 ? 'primary' : index === 1 ? 'backup' : null),
  );
}

/** 一张合法的 question 卡最小载荷；overrides 会整体覆盖同名字段。 */
export function questionPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    channel_key: 'devhost/myproj/question-fixture',
    title: '选一个',
    background_md: '背景：登录 500 持续 10 分钟',
    goal_md: '目标：10 分钟内恢复登录',
    research_md: '调查参考：回滚约 10 分钟；修白名单约 30 分钟',
    decision_md: '决策项：先回滚还是先修白名单',
    options: questionOptions(),
    ...overrides,
  };
}
