import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { AuthError, BusinessError, CliError, TransportError } from './errors.js';
import { redact, truncate } from './log.js';
import { asNumber, asRecord, asString } from './mcp-parse.js';

/**
 * MCP 客户端（Streamable HTTP）。
 *
 * 为什么只走 MCP：
 * 值守壳需要的注册、心跳、列任务、认领/续租、回报、释放，在 MCP-001/002/011/013/010/014
 * 里已经齐全。再写一套 REST 客户端会让同一语义有两份实现，任何一边改字段都会漂移；
 * 而且 MCP 的 tools/list 是唯一能自描述的入口（AGENTS.md 也以它为真值）。
 *
 * 错误归一化：
 * - JSON-RPC / HTTP 层错误统一收敛成 CliError；
 * - UNAUTHORIZED 一律 AuthError，调用方必须停止，不做任何重试；
 * - EVIDENCE_REQUIRED 单独保留 code，runner 依此按错误退出而不是“再发一次卡”。
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const ERROR_MESSAGE_LIMIT = 800;
const RETRYABLE_CODES = new Set(['ALREADY_CLAIMED', 'RATE_LIMITED', 'BUSY']);
const CODE_PATTERN =
  /\b(INVALID_ARGUMENT|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|CONFLICT|ALREADY_CLAIMED|EVIDENCE_REQUIRED|RATE_LIMITED|BUSY|INTERNAL)\b/;

export interface AidashMcpClientOptions {
  endpoint: string;
  token: string;
  clientName?: string;
  clientVersion?: string;
}

export class AidashMcpClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(options: AidashMcpClientOptions) {
    this.transport = new StreamableHTTPClientTransport(new URL(options.endpoint), {
      // 令牌只放在请求头里；不拼进 URL，避免被代理日志记录。
      requestInit: {
        headers: { Authorization: `Bearer ${options.token}` },
      },
    });
    this.client = new Client(
      {
        name: options.clientName ?? 'aidash-watch',
        version: options.clientVersion ?? '2.0.0',
      },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect(this.transport);
      this.connected = true;
    } catch (error) {
      throw classifyMcpError(error);
    }
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await this.client.close();
    } catch {
      // 关闭失败不应覆盖主流程已经算好的退出码；这里不重试、不打印。
    }
  }

  /**
   * 调用工具并返回结构化结果。
   * SDK 可能把结果放在 structuredContent、兼容字段 toolResult 或 text content 里，
   * 这里统一收口，业务层不需要关心传输细节。
   */
  async call<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.connected) throw new TransportError('MCP 客户端尚未连接');
    let raw: unknown;
    try {
      raw = await this.client.callTool({ name, arguments: args }, undefined, {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      throw classifyMcpError(error);
    }
    return parseToolResult<T>(name, raw);
  }
}

function parseToolResult<T>(toolName: string, raw: unknown): T {
  const record = asRecord(raw);
  if (!record) throw new TransportError(`${toolName} 返回格式不符：期望 JSON 对象`);
  if (record.isError === true) throw classifyToolError(toolName, record);

  if (record.toolResult !== undefined) return unwrapResult(record.toolResult) as T;
  if (record.structuredContent !== undefined) return unwrapResult(record.structuredContent) as T;

  const text = collectText(record.content);
  if (text) return unwrapResult(parseJsonText(toolName, text)) as T;
  throw new TransportError(`${toolName} 返回空内容`);
}

function classifyToolError(toolName: string, record: Record<string, unknown>): CliError {
  const structured = record.structuredContent;
  if (structured !== undefined) return classifyErrorPayload(structured, `${toolName} 返回错误`);

  const text = collectText(record.content);
  if (!text) return new BusinessError('TOOL_ERROR', `${toolName} 返回错误（无正文）`);
  try {
    const parsed: unknown = JSON.parse(text);
    return classifyErrorPayload(parsed, `${toolName} 返回错误`);
  } catch {
    return classifyErrorPayload({ message: text }, `${toolName} 返回错误`);
  }
}

function classifyMcpError(error: unknown): CliError {
  if (error instanceof CliError) return error;

  if (error instanceof McpError) {
    const data = asRecord(error.data);
    const mappedCode = mapJsonRpcCode(error.code);
    const payload: Record<string, unknown> = {
      ...(data ?? {}),
      code: asString(data?.code) ?? mappedCode,
      message: asString(data?.message) ?? error.message,
    };
    return classifyErrorPayload(payload, error.message);
  }

  if (error instanceof Error) {
    const record = asRecord(error);
    const status = record ? (asNumber(record.status) ?? asNumber(record.code)) : null;
    const message = redact(truncate(error.message || error.name, ERROR_MESSAGE_LIMIT));

    if (status === 401 || /http\s*401|unauthorized/i.test(error.message)) {
      return new AuthError(`认证失败：${message}（收到 401，已停止，不重试）`);
    }
    if (status === 403) return new BusinessError('FORBIDDEN', `无权执行：${message}`);
    if (status === 429) {
      return new BusinessError('RATE_LIMITED', `被限流：${message}`, { retryable: true });
    }
    if (status === 503) {
      return new BusinessError('BUSY', `服务繁忙：${message}`, { retryable: true });
    }
    if (error.name === 'AbortError') return new TransportError('MCP 调用被中断');
    if (/timeout|timed out/i.test(`${error.name} ${error.message}`)) {
      return new TransportError(`MCP 调用超时：${message}`);
    }
    return new TransportError(`MCP 传输失败：${message}`);
  }

  return new TransportError(`MCP 传输失败：${redact(String(error))}`);
}

interface ErrorPayloadParts {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function readErrorPayload(payload: unknown, fallback: string): ErrorPayloadParts {
  const root = asRecord(payload);
  const nested = root && asRecord(root.error) ? asRecord(root.error) : null;
  const rawMessage =
    asString(nested?.message) ??
    asString(root?.message) ??
    (typeof payload === 'string' ? payload : null) ??
    fallback;
  const detected = detectCode(rawMessage);
  const code = asString(nested?.code) ?? asString(root?.code) ?? detected ?? '';
  const details = asRecord(nested?.details) ?? asRecord(root?.details);
  return { code, message: rawMessage, ...(details ? { details } : {}) };
}

function classifyErrorPayload(payload: unknown, fallback: string): CliError {
  const parts = readErrorPayload(payload, fallback);
  const message = redact(truncate(parts.message || fallback, ERROR_MESSAGE_LIMIT));

  if (parts.code === 'UNAUTHORIZED' || /http\s*401|unauthorized/i.test(parts.message)) {
    return new AuthError(`认证失败：${message}（收到 401，已停止，不重试）`, parts.details);
  }
  if (parts.code === 'EVIDENCE_REQUIRED') {
    return new BusinessError('EVIDENCE_REQUIRED', `完成证据缺失：${message}`, {
      details: parts.details,
    });
  }
  if (parts.code === 'FORBIDDEN') {
    return new BusinessError('FORBIDDEN', `无权执行：${message}`, { details: parts.details });
  }
  if (parts.code) {
    return new BusinessError(parts.code, message, {
      retryable: RETRYABLE_CODES.has(parts.code),
      details: parts.details,
    });
  }
  return new BusinessError('TOOL_ERROR', message, { details: parts.details });
}

function mapJsonRpcCode(code: number): string {
  switch (code) {
    case -32001:
      return 'UNAUTHORIZED';
    case -32003:
      return 'FORBIDDEN';
    case -32004:
      return 'NOT_FOUND';
    case -32602:
      return 'INVALID_ARGUMENT';
    case -32000:
      return 'CONFLICT';
    case -32603:
      return 'INTERNAL';
    default:
      return 'INTERNAL';
  }
}

function detectCode(text: string): string | null {
  const match = CODE_PATTERN.exec(text);
  return match?.[1] ?? null;
}

function collectText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item || item.type !== 'text') continue;
    const text = asString(item.text);
    if (text) texts.push(text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

function parseJsonText(toolName: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TransportError(`${toolName} 返回的不是 JSON 文本`);
  }
}

/** 兼容 REST 信封 {schema_version,data} 与“只有一个 data 字段”的包装。 */
function unwrapResult(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if ('schema_version' in record && 'data' in record) return record.data;
  // MCP 工具统一返回 {ok:true,data}；REST 风格则可能是 {data}。
  if (record.ok === true && 'data' in record) return record.data;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'data') return record.data;
  return value;
}
