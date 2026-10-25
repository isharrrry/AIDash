import fs from 'node:fs';
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, vi } from 'vitest';

import { defaultStatusConfig, type WatchConfig } from '../../src/cli/config.js';
import { CliError, isCliError } from '../../src/cli/errors.js';
import type { ExecResult } from '../../src/cli/exec.js';
import type { Logger } from '../../src/cli/log.js';
import { AidashMcpClient } from '../../src/cli/mcp-client.js';
import type { TaskItem } from '../../src/cli/mcp-parse.js';

/**
 * cli-branches 拆分后的共享夹具：
 * - 假 MCP 服务（真实回环 HTTP/JSON-RPC）；
 * - runner/report 的纯内存替身与日志、任务、配置工厂。
 *
 * 这些桩只替代外部系统或被测进程边界，不改变被测代码的调用方式。
 */

export const TEST_TOKEN = 'cli-branch-fake-token'; // 仅测试用，不是真实凭据

// ---------------------------------------------------------------------------
// 假 MCP 服务：一个最小的 Streamable HTTP JSON-RPC 端点
// ---------------------------------------------------------------------------

export interface FakeMcpCall {
  method: string;
  params: Record<string, unknown>;
}

export interface FakeReply {
  /** 正常 JSON-RPC result。 */
  result?: unknown;
  /** JSON-RPC 协议级错误（SDK 会转成 McpError）。 */
  rpcError?: { code: number; message: string; data?: unknown };
  /** 直接控制 HTTP 状态与正文（用于 401/500、非 JSON 响应）。 */
  http?: { status: number; body?: string; contentType?: string };
  /** 延迟返回：用于请求超时、进行中关闭连接。 */
  delayMs?: number;
}

export type FakeHandler = (
  method: string,
  params: Record<string, unknown>,
) => FakeReply | undefined | Promise<FakeReply | undefined>;

export interface FakeMcpServer {
  endpoint: string;
  calls: FakeMcpCall[];
  close: () => Promise<void>;
}

const DEFAULT_INITIALIZE_RESULT = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  serverInfo: { name: 'fake-aidash-mcp', version: '0.0.0' },
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把 handler 的返回值写成 HTTP 响应；已关闭的响应直接跳过，避免测试收尾时抛错。 */
function writeReply(res: ServerResponse, id: unknown, reply: FakeReply): void {
  if (res.destroyed || res.writableEnded) return;
  if (reply.http) {
    res.statusCode = reply.http.status;
    res.setHeader('content-type', reply.http.contentType ?? 'application/json');
    res.end(reply.http.body ?? '');
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  const payload = reply.rpcError
    ? { jsonrpc: '2.0', id, error: reply.rpcError }
    : { jsonrpc: '2.0', id, result: reply.result ?? {} };
  res.end(JSON.stringify(payload));
}

export async function startFakeMcp(handler: FakeHandler): Promise<FakeMcpServer> {
  const calls: FakeMcpCall[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const server = http.createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    // 客户端连接后会尝试用 GET 打开 SSE 流；405 是规范的“不支持”，SDK 会忽略。
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        const method = typeof message.method === 'string' ? message.method : '';
        const id = message.id ?? null;
        const params = isRecord(message.params) ? message.params : {};
        // 通知不需要响应体；202 让 SDK 按“已接收”处理。
        if (method.startsWith('notifications/')) {
          res.statusCode = 202;
          res.end();
          return;
        }
        calls.push({ method, params });
        let reply: FakeReply | undefined;
        try {
          reply = await handler(method, params);
        } catch (error) {
          reply = {
            http: { status: 500, body: error instanceof Error ? error.message : String(error) },
          };
        }
        const effective: FakeReply =
          reply ??
          (method === 'initialize'
            ? { result: DEFAULT_INITIALIZE_RESULT }
            : // 工具结果必须是 MCP 结果包络；{toolResult} 是本项目兼容的旧字段。
              { result: { toolResult: { ok: true, data: {} } } });
        if (effective.delayMs !== undefined) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            writeReply(res, id, effective);
          }, effective.delayMs);
          timers.add(timer);
          timer.unref();
          return;
        }
        writeReply(res, id, effective);
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** 起服务 → 连客户端 → 执行断言 → 无论成败都回收，避免端口与 keep-alive 泄漏。 */
export async function withFakeMcp<T>(
  handler: FakeHandler,
  fn: (client: AidashMcpClient, server: FakeMcpServer) => Promise<T>,
): Promise<T> {
  const server = await startFakeMcp(handler);
  const client = new AidashMcpClient({ endpoint: server.endpoint, token: TEST_TOKEN });
  try {
    await client.connect();
    return await fn(client, server);
  } finally {
    await client.close();
    await server.close();
  }
}

export async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
  throw new Error('期望调用失败，但实际成功返回了');
}

export async function captureCliError(promise: Promise<unknown>): Promise<CliError> {
  const error = await captureError(promise);
  expect(isCliError(error)).toBe(true);
  return error as CliError;
}

// ---------------------------------------------------------------------------
// runner / report 的纯内存替身
// ---------------------------------------------------------------------------

export interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
}

export function scriptedClient(handler: (name: string, args: Record<string, unknown>) => unknown): {
  client: AidashMcpClient;
  calls: ScriptedCall[];
} {
  const calls: ScriptedCall[] = [];
  const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return handler(name, args);
  });
  return { client: { call } as unknown as AidashMcpClient, calls };
}

export interface LogEntry {
  level: string;
  message: string;
}

export function fakeLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const push = (level: string) => (message: string): void => {
    entries.push({ level, message });
  };
  const logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    failure: (context: string, error: unknown): void => push('error')(`${context}：${String(error)}`),
  } as unknown as Logger;
  return { logger, entries };
}

export function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'tk_branch',
    channel_key: 'devhost/proj',
    title: '分支任务',
    status: 'pending',
    priority: 'P2',
    tags: [],
    assignee: null,
    claim_expires_at: null,
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<WatchConfig> = {}): WatchConfig {
  return {
    ...defaultStatusConfig(),
    endpoint: 'http://127.0.0.1:9/mcp', // 纯内存替身不会真的连它
    harness_id: 'h-branch',
    name: '分支测试',
    poll_interval_seconds: 0,
    gap_seconds: 0,
    heartbeat_interval_seconds: 3600,
    command_timeout_seconds: 10,
    commands: [{ command: 'node -e "process.exit(0)"', tags: [], match_all: true }],
    ...overrides,
  };
}

export function makeExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 1000,
    error: null,
    ...overrides,
  };
}

const tempDirs: string[] = [];

export function tempConfig(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-cli-branch-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'aidash-watch.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return file;
}

export function emptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-cli-branch-empty-'));
  tempDirs.push(dir);
  return dir;
}

/** 清理所有临时目录；测试文件的 afterEach 负责调用，避免夹具模块自己注册钩子。 */
export function cleanupCliFixtures(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言结果。
    }
  }
}
