import fs from 'node:fs';
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultStatusConfig, type CommandRule, type WatchConfig } from '../src/cli/config.js';
import {
  AuthError,
  BusinessError,
  CliError,
  ConfigError,
  TransportError,
  isCliError,
} from '../src/cli/errors.js';
import { executeCommand, type ExecResult } from '../src/cli/exec.js';
import type { Logger } from '../src/cli/log.js';
import { AidashMcpClient } from '../src/cli/mcp-client.js';
import type { TaskItem } from '../src/cli/mcp-parse.js';
import { buildFailReason, postStatusCard, releaseQuietly } from '../src/cli/report.js';
import { listTasks, runWatch, type RunContext } from '../src/cli/runner.js';
import { main, parseArgs } from '../src/cli/index.js';
import {
  TEST_TOKEN,
  captureCliError,
  captureError,
  cleanupCliFixtures,
  emptyDir,
  fakeLogger,
  isRecord,
  makeConfig,
  makeExecResult,
  makeTask,
  scriptedClient,
  startFakeMcp,
  tempConfig,
  withFakeMcp,
} from './fakes/cli-fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupCliFixtures();
});

/**
 * CLI 传输层（mcp-client）错误分支。
 *
 * 由 cli-branches 按主题拆出：连接/HTTP/JSON-RPC 映射、结果包络、超时与断连。
 * 断言保持原样，仅搬移分组。
 */

describe('CLI 分支：MCP 客户端协议错误', () => {
  it('未连接时 call 直接报 TransportError，close 可重复调用', async () => {
    const client = new AidashMcpClient({ endpoint: 'http://127.0.0.1:9/mcp', token: TEST_TOKEN });
    const error = await captureCliError(client.call('task.list', {}));
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toContain('尚未连接');
    // 没连上时 close 走 connected=false 分支，不应发起网络请求，也不应抛错。
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('connect 阶段 HTTP 401 → AuthError；500 → TransportError', async () => {
    for (const [status, expected] of [
      [401, AuthError],
      [500, TransportError],
    ] as const) {
      const server = await startFakeMcp((method) =>
        method === 'initialize' ? { http: { status, body: `status-${status}` } } : undefined,
      );
      const client = new AidashMcpClient({ endpoint: server.endpoint, token: TEST_TOKEN });
      try {
        const error = await captureCliError(client.connect());
        expect(error).toBeInstanceOf(expected);
        if (status === 401) {
          expect(error.message).toContain('认证失败');
          expect(error.message).toContain('收到 401');
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  });

  it('connect 阶段 JSON-RPC 错误（initialize 失败）也会被归一化为 CliError', async () => {
    const server = await startFakeMcp((method) =>
      method === 'initialize'
        ? { rpcError: { code: -32603, message: 'server exploded' } }
        : undefined,
    );
    const client = new AidashMcpClient({ endpoint: server.endpoint, token: TEST_TOKEN });
    try {
      const error = await captureCliError(client.connect());
      expect(error).toBeInstanceOf(BusinessError);
      expect(error.code).toBe('INTERNAL');
      expect(error.exitCode).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('HTTP 403/429/503 映射为 FORBIDDEN/RATE_LIMITED/BUSY，500 归为传输错误', async () => {
    const statusByTool: Record<string, number> = {
      'http-401': 401,
      'http-403': 403,
      'http-429': 429,
      'http-503': 503,
      'http-500': 500,
    };
    await withFakeMcp(
      (_method, params) => {
        const status = statusByTool[String(params.name)];
        return status === undefined ? undefined : { http: { status } };
      },
      async (client) => {
        const unauthorized = await captureCliError(client.call('http-401', {}));
        expect(unauthorized).toBeInstanceOf(AuthError);
        expect(unauthorized.message).toContain('认证失败');
        expect(unauthorized.exitCode).toBe(2);

        const forbidden = await captureCliError(client.call('http-403', {}));
        expect(forbidden).toBeInstanceOf(BusinessError);
        expect(forbidden.code).toBe('FORBIDDEN');
        expect(forbidden.message).toContain('无权执行');

        const limited = await captureCliError(client.call('http-429', {}));
        expect(limited).toBeInstanceOf(BusinessError);
        expect(limited.code).toBe('RATE_LIMITED');
        expect(limited.retryable).toBe(true);

        const busy = await captureCliError(client.call('http-503', {}));
        expect(busy).toBeInstanceOf(BusinessError);
        expect(busy.code).toBe('BUSY');
        expect(busy.retryable).toBe(true);

        const serverError = await captureCliError(client.call('http-500', {}));
        expect(serverError).toBeInstanceOf(TransportError);
        expect(serverError.message).toContain('MCP 传输失败');
      },
    );
  });

  it('JSON-RPC 错误码映射：-32000/-32001 归传输错误，其余保持业务码', async () => {
    const errors: Record<string, { code: number; message: string }> = {
      closed: { code: -32000, message: 'connection closed' },
      timedOut: { code: -32001, message: 'request timed out' },
      forbid: { code: -32003, message: 'denied' },
      missing: { code: -32004, message: 'gone' },
      invalid: { code: -32602, message: 'bad params' },
      internal: { code: -32603, message: 'kaboom' },
      unknown: { code: -12345, message: 'strange code' },
    };
    await withFakeMcp(
      (_method, params) => {
        const rpcError = errors[String(params.name)];
        return rpcError === undefined ? undefined : { rpcError };
      },
      async (client) => {
        // -32000/-32001 是 SDK 的客户端侧传输错误（ConnectionClosed/RequestTimeout），
        // 先于 mapJsonRpcCode 拦截，所以这里期望 TRANSPORT 而不是 CONFLICT/UNAUTHORIZED。
        const expectations: Array<[string, string, 'transport' | 'business']> = [
          ['closed', 'TRANSPORT', 'transport'],
          ['timedOut', 'TRANSPORT', 'transport'],
          ['forbid', 'FORBIDDEN', 'business'],
          ['missing', 'NOT_FOUND', 'business'],
          ['invalid', 'INVALID_ARGUMENT', 'business'],
          ['internal', 'INTERNAL', 'business'],
          ['unknown', 'INTERNAL', 'business'],
        ];
        for (const [tool, expectedCode, expectedKind] of expectations) {
          const error = await captureCliError(client.call(tool, {}));
          expect(error.code).toBe(expectedCode);
          expect(error.kind).toBe(expectedKind);
          expect(error.exitCode).toBe(expectedKind === 'business' ? 1 : 2);
        }
        const closed = await captureCliError(client.call('closed', {}));
        expect(closed).toBeInstanceOf(TransportError);
        expect(closed.retryable).toBe(true);
        const forbidden = await captureCliError(client.call('forbid', {}));
        expect(forbidden.retryable).toBe(false);
      },
    );
  });

  it('JSON-RPC 错误 data 里的业务 code / details 优先于原始码', async () => {
    const errors: Record<string, { code: number; message: string; data?: unknown }> = {
      rate: { code: -32603, message: 'raw', data: { code: 'RATE_LIMITED', message: 'slow down' } },
      evidence: {
        code: -32603,
        message: 'raw',
        data: { code: 'EVIDENCE_REQUIRED', message: 'need card', details: { task_id: 'tk_1' } },
      },
      unauthData: { code: -32603, message: 'raw', data: { message: 'UNAUTHORIZED expired' } },
    };
    await withFakeMcp(
      (_method, params) => {
        const rpcError = errors[String(params.name)];
        return rpcError === undefined ? undefined : { rpcError };
      },
      async (client) => {
        const rate = await captureCliError(client.call('rate', {}));
        expect(rate).toBeInstanceOf(BusinessError);
        expect(rate.code).toBe('RATE_LIMITED');
        expect(rate.retryable).toBe(true);
        expect(rate.message).toBe('slow down');

        const evidence = await captureCliError(client.call('evidence', {}));
        expect(evidence).toBeInstanceOf(BusinessError);
        expect(evidence.code).toBe('EVIDENCE_REQUIRED');
        expect(evidence.exitCode).toBe(1);
        expect(evidence.message).toContain('完成证据缺失');
        expect(evidence.details).toEqual({ task_id: 'tk_1' });

        // data 里没有 code，但 message 命中 CODE_PATTERN → 仍按 UNAUTHORIZED 处理。
        const unauthorized = await captureCliError(client.call('unauthData', {}));
        expect(unauthorized).toBeInstanceOf(AuthError);
      },
    );
  });

  it('isError 结果：无正文、纯文本、JSON 文本、structuredContent、字符串载荷', async () => {
    const results: Record<string, unknown> = {
      'err-empty': { isError: true, content: [] },
      'err-text': { isError: true, content: [{ type: 'text', text: 'boom happened' }] },
      'err-json': {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: { code: 'FORBIDDEN', message: 'no entry', details: { scope: 'x' } },
            }),
          },
        ],
      },
      'err-structured': {
        isError: true,
        structuredContent: {
          code: 'EVIDENCE_REQUIRED',
          message: 'missing evidence',
          details: { card: 'cd_1' },
        },
        // structuredContent 优先，content 里的内容应被忽略。
        content: [{ type: 'text', text: JSON.stringify({ code: 'FORBIDDEN', message: 'ignored' }) }],
      },
      'err-retryable': { isError: true, structuredContent: { code: 'ALREADY_CLAIMED', message: 'taken' } },
      'err-nocode': { isError: true, content: [{ type: 'text', text: JSON.stringify({ message: 'plain failure' }) }] },
      'err-string-payload': { isError: true, content: [{ type: 'text', text: '"UNAUTHORIZED"' }] },
      'err-empty-structured': { isError: true, structuredContent: {} },
    };
    await withFakeMcp(
      (_method, params) => {
        const result = results[String(params.name)];
        return result === undefined ? undefined : { result };
      },
      async (client) => {
        const empty = await captureCliError(client.call('err-empty', {}));
        expect(empty).toBeInstanceOf(BusinessError);
        expect(empty.code).toBe('TOOL_ERROR');
        expect(empty.message).toContain('无正文');

        const plain = await captureCliError(client.call('err-text', {}));
        expect(plain).toBeInstanceOf(BusinessError);
        expect(plain.message).toBe('boom happened');

        const json = await captureCliError(client.call('err-json', {}));
        expect(json).toBeInstanceOf(BusinessError);
        expect(json.code).toBe('FORBIDDEN');
        expect(json.details).toEqual({ scope: 'x' });

        const structured = await captureCliError(client.call('err-structured', {}));
        expect(structured).toBeInstanceOf(BusinessError);
        expect(structured.code).toBe('EVIDENCE_REQUIRED');
        expect(structured.details).toEqual({ card: 'cd_1' });

        const retryable = await captureCliError(client.call('err-retryable', {}));
        expect(retryable.code).toBe('ALREADY_CLAIMED');
        expect(retryable.retryable).toBe(true);

        const noCode = await captureCliError(client.call('err-nocode', {}));
        expect(noCode.code).toBe('TOOL_ERROR');
        expect(noCode.message).toBe('plain failure');

        // JSON.parse 出来的是字符串而非对象：仍要能识别出 UNAUTHORIZED。
        const stringPayload = await captureCliError(client.call('err-string-payload', {}));
        expect(stringPayload).toBeInstanceOf(AuthError);

        const emptyStructured = await captureCliError(client.call('err-empty-structured', {}));
        expect(emptyStructured.code).toBe('TOOL_ERROR');
        expect(emptyStructured.message).toContain('err-empty-structured 返回错误');
      },
    );
  });

  it('正常结果包络：toolResult / structuredContent / content 文本 / 裸值 / 多段文本', async () => {
    const results: Record<string, unknown> = {
      'ok-toolResult': {
        toolResult: { from: 'toolResult' },
        structuredContent: { from: 'structured' },
        content: [{ type: 'text', text: JSON.stringify({ from: 'text' }) }],
      },
      'ok-schema': { structuredContent: { schema_version: '1', data: { from: 'schema' } } },
      'ok-envelope': { structuredContent: { ok: true, data: [1, 2] } },
      'ok-single-data': { structuredContent: { data: { from: 'single' } } },
      'ok-text': { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { from: 'text' } }) }] },
      'ok-multitext': {
        content: [
          { type: 'text', text: '{"a":' },
          { type: 'text', text: '1}' },
        ],
      },
      'ok-scalar': { content: [{ type: 'text', text: '42' }] },
      'ok-passthrough': { content: [{ type: 'text', text: JSON.stringify({ message: 'hi', n: 1 }) }] },
    };
    await withFakeMcp(
      (_method, params) => {
        const result = results[String(params.name)];
        return result === undefined ? undefined : { result };
      },
      async (client) => {
        // 三种包里都有值时，toolResult 优先级最高，其次 structuredContent。
        await expect(client.call('ok-toolResult', {})).resolves.toEqual({ from: 'toolResult' });
        await expect(client.call('ok-schema', {})).resolves.toEqual({ from: 'schema' });
        await expect(client.call('ok-envelope', {})).resolves.toEqual([1, 2]);
        await expect(client.call('ok-single-data', {})).resolves.toEqual({ from: 'single' });
        await expect(client.call('ok-text', {})).resolves.toEqual({ from: 'text' });
        await expect(client.call('ok-multitext', {})).resolves.toEqual({ a: 1 });
        await expect(client.call('ok-scalar', {})).resolves.toBe(42);
        // 不是 {ok:true,data}/{schema_version,data}/单 data 字段时不剥壳。
        await expect(client.call('ok-passthrough', {})).resolves.toEqual({ message: 'hi', n: 1 });
      },
    );
  });

  it('空内容、只有非文本块、非 JSON 文本、畸形 result 都是传输错误', async () => {
    const results: Record<string, unknown> = {
      empty: { content: [] },
      'image-only': { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] },
      'bad-json': { content: [{ type: 'text', text: 'not-json-at-all' }] },
      malformed: { content: 'oops' },
    };
    await withFakeMcp(
      (_method, params) => {
        const result = results[String(params.name)];
        return result === undefined ? undefined : { result };
      },
      async (client) => {
        const empty = await captureCliError(client.call('empty', {}));
        expect(empty).toBeInstanceOf(TransportError);
        expect(empty.message).toContain('返回空内容');

        const imageOnly = await captureCliError(client.call('image-only', {}));
        expect(imageOnly).toBeInstanceOf(TransportError);
        expect(imageOnly.message).toContain('返回空内容');

        const badJson = await captureCliError(client.call('bad-json', {}));
        expect(badJson).toBeInstanceOf(TransportError);
        expect(badJson.message).toContain('返回的不是 JSON 文本');

        // result 形状违反 CallToolResultSchema（content 必须是数组）→ SDK 校验失败。
        const malformed = await captureCliError(client.call('malformed', {}));
        expect(malformed).toBeInstanceOf(TransportError);
        expect(malformed.message).toContain('MCP 传输失败');
      },
    );
  });

  it('200 但响应不是 JSON（text/plain）→ TransportError', async () => {
    await withFakeMcp(
      (method) =>
        method === 'tools/call'
          ? { http: { status: 200, contentType: 'text/plain', body: 'plain text body' } }
          : undefined,
      async (client) => {
        const error = await captureCliError(client.call('anything', {}));
        expect(error).toBeInstanceOf(TransportError);
        expect(error.message).toContain('Unexpected content type');
      },
    );
  });

  it('请求超时：SDK 的 -32001 归 TransportError，不再误判成 401 停机', async () => {
    await withFakeMcp(
      (_method, params) =>
        params.name === 'slow-tool' ? { delayMs: 800, result: { ok: true, data: {} } } : undefined,
      async (client) => {
        const error = await captureCliError(client.call('slow-tool', {}, { timeoutMs: 60 }));
        // 回归守卫（原 D-3）：SDK 的 RequestTimeout 码是 -32001，曾被 mapJsonRpcCode
        // 映射成 UNAUTHORIZED。于是一次普通超时会让调用方停止整个值守循环
        // （AuthError 不重试），而 REQ-FN-050 要求超时可重试/退避。
        expect(error).toBeInstanceOf(TransportError);
        expect(error.message).toContain('Request timed out');
        expect(error.message).toContain('MCP 传输失败');
        expect(error.retryable).toBe(true);
        expect(error.exitCode).toBe(2);
      },
    );
  });

  it('调用进行中关闭连接：挂起的请求被拒绝而不是永远等待', async () => {
    const server = await startFakeMcp((_method, params) =>
      params.name === 'slow-tool' ? { delayMs: 1000, result: { ok: true, data: {} } } : undefined,
    );
    const client = new AidashMcpClient({ endpoint: server.endpoint, token: TEST_TOKEN });
    try {
      await client.connect();
      const pending = client.call('slow-tool', {});
      await new Promise((resolve) => setTimeout(resolve, 80));
      await client.close();
      const error = await captureError(pending);
      expect(isCliError(error)).toBe(true);
      // 连接关闭同样属于传输层（-32000），必须是 TransportError 而不是 AuthError。
      expect(error).toBeInstanceOf(TransportError);
      expect(error.message).toMatch(/Connection closed|中断|abort/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
