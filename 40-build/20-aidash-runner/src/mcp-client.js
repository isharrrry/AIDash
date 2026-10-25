import {
  AuthError,
  BusinessError,
  TransportError,
  isRunnerError,
} from './errors.js';
import { VERSION } from './constants.js';
import { redact, registerSecret, truncate } from './redact.js';
import { asRecord, asString } from './util.js';

/**
 * 零依赖 MCP 客户端（Streamable HTTP / JSON-RPC 2.0）。
 *
 * 为什么不复制旧 CLI 的 SDK 客户端：
 * 1. 本包要求运行时零第三方依赖，npm 全局安装不能拖一棵 SDK 依赖树；
 * 2. 我们只需要 8 个工具，不需要 SDK 的完整能力；
 * 3. 错误分类必须自己掌控——401 必须立即停，而 SDK 的 -32001 实际表示连接关闭，
 *    旧实现曾把它误判成 401 让值守壳停机（缺陷台账 D-3）。
 *
 * 协议要点：
 * - 先 initialize，再发 notifications/initialized；
 * - 服务端若返回 Mcp-Session-Id 就带上；AIDash 是 stateless，不返回也不影响；
 * - 响应可能是 application/json，也可能是 text/event-stream，两种都解析；
 * - 工具业务错误由服务端放在 CallToolResult.isError 的文本里，不是 HTTP 错误。
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const ERROR_MESSAGE_LIMIT = 800;
const RETRYABLE_TOOL_CODES = new Set(['ALREADY_CLAIMED', 'RATE_LIMITED', 'BUSY']);
const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  constructor({ endpoint, token, clientName = 'aidash-runner', clientVersion = VERSION }) {
    this.endpoint = endpoint;
    this.token = token;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.protocolVersion = null;
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
    // 令牌可能只来自 --token/--token-file，不在环境变量里。注册到脱敏器后，
    // 日志、卡片正文与错误回显都能把它的原值替换掉；否则这类令牌最容易被
    // 服务端错误信息原样回显到磁盘。
    registerSecret(token);
  }

  async connect({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion },
      },
      { timeoutMs, expectResponse: true },
    );
    const record = asRecord(result);
    this.protocolVersion = asString(record?.protocolVersion) ?? PROTOCOL_VERSION;
    // initialized 是通知，服务端按 202/空响应处理。它失败通常意味着连接已断，
    // 但初始化本身成功过，所以这里只在 401 时抛出，其它情况由后续调用暴露。
    try {
      await this.request('notifications/initialized', {}, { timeoutMs, notification: true });
    } catch (error) {
      if (error instanceof AuthError) throw error;
    }
    this.initialized = true;
    return result;
  }

  /**
   * 尝试 tools/list。仅用于判断服务端是否真的提供 task.get；
   * 失败不致命——规格的服务端没有 tools/list 之外的发现机制，读不到就走降级路径。
   */
  async listToolNames({ timeoutMs = 10_000 } = {}) {
    try {
      const result = await this.request('tools/list', {}, { timeoutMs });
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      return tools.map((tool) => asString(tool?.name)).filter(Boolean);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      return [];
    }
  }

  async callTool(name, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const result = await this.request(
      'tools/call',
      { name, arguments: args },
      { timeoutMs },
    );
    return parseToolResult(name, result);
  }

  /**
   * 内部调用统一入口。
   * 早期几处代码写的是 `client.call(...)`，与 SDK 风格的 `callTool` 并存；
   * 保留这个别名是为了让调用点读起来更短，同时避免运行到第一次拉取才炸出
   * “client.call is not a function”。协议语义完全等同 callTool。
   */
  call(name, args = {}, options = {}) {
    return this.callTool(name, args, options);
  }

  async request(method, params, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const notification = options.notification === true;
    const id = notification ? undefined : this.nextId++;
    const body = { jsonrpc: '2.0', method, params };
    if (!notification) body.id = id;

    let response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        // 本地回环端点；不要跟随重定向，避免把 Authorization 带到别的主机。
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw classifyNetworkError(error, timeoutMs);
    }

    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    if (response.status === 401) {
      throw new AuthError(
        '认证失败（HTTP 401）：AIDASH_TOKEN 可能错误或已轮换；已停止，不重试。请检查令牌来源后重启实例',
      );
    }
    if (!response.ok) throw await classifyHttpError(response);

    if (notification) return null;
    const contentType = response.headers.get('content-type') ?? '';
    let message;
    if (contentType.includes('text/event-stream')) {
      message = await parseSseResponse(response, id);
    } else {
      const text = await response.text();
      if (!text.trim()) throw new TransportError(`${method} 返回空响应`);
      try {
        message = JSON.parse(text);
      } catch {
        throw new TransportError(`${method} 返回的不是合法 JSON`);
      }
    }

    if (Array.isArray(message)) {
      message = message.find((item) => item && item.id === id) ?? message[0];
    }
    const record = asRecord(message);
    if (!record) throw new TransportError(`${method} 返回格式不符：期望 JSON-RPC 对象`);
    if (record.error) throw classifyRpcError(method, record.error);
    return record.result;
  }

  headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
    };
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    return headers;
  }
}

function parseToolResult(toolName, result) {
  const record = asRecord(result);
  if (!record) throw new TransportError(`${toolName} 返回格式不符：期望 JSON 对象`);
  if (record.isError === true) throw classifyToolError(toolName, record);
  if (record.structuredContent !== undefined) return unwrap(record.structuredContent);
  const text = collectText(record.content);
  if (text === null) {
    // 某些工具（例如 release）可能返回空内容；调用方本来就不依赖返回值。
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TransportError(`${toolName} 返回的不是 JSON 文本`);
  }
  return unwrap(parsed);
}

function classifyToolError(toolName, record) {
  const text = collectText(record.content);
  if (!text) return new BusinessError('TOOL_ERROR', `${toolName} 返回错误（无正文）`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { message: text };
  }
  const root = asRecord(payload) ?? {};
  const nested = asRecord(root.error) ?? root;
  const code = asString(nested.code) ?? 'TOOL_ERROR';
  const message = redact(truncate(asString(nested.message) ?? text, ERROR_MESSAGE_LIMIT));
  if (code === 'UNAUTHORIZED') {
    return new AuthError(`认证失败：${message}（401 后已停止，不重试）`);
  }
  return new BusinessError(code, message, {
    retryable: RETRYABLE_TOOL_CODES.has(code),
    details: asRecord(nested.details) ?? undefined,
  });
}

async function classifyHttpError(response) {
  const status = response.status;
  const raw = await response.text().catch(() => '');
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    const error = asRecord(parsed?.error);
    message = asString(error?.message) ?? asString(parsed?.message) ?? asString(parsed?.error) ?? raw;
  } catch {
    // 非 JSON 错误体，保留原文（下面会脱敏）。
  }
  message = redact(truncate(message || `HTTP ${status}`, ERROR_MESSAGE_LIMIT));
  if (status === 403) return new BusinessError('FORBIDDEN', `无权执行：${message}`);
  if (status === 429) {
    return new BusinessError('RATE_LIMITED', `被限流：${message}`, { retryable: true });
  }
  if (status === 503) return new BusinessError('BUSY', `服务繁忙：${message}`, { retryable: true });
  return new TransportError(`HTTP ${status}：${message}`);
}

function classifyRpcError(method, error) {
  const record = asRecord(error) ?? {};
  const code = typeof record.code === 'number' ? record.code : null;
  const message = redact(
    truncate(asString(record.message) ?? `JSON-RPC 错误 ${String(record.code)}`, ERROR_MESSAGE_LIMIT),
  );
  const details = asRecord(record.data) ?? undefined;
  switch (code) {
    case -32001: // MCP SDK 的 ConnectionClosed/RequestTimeout，不是 401（D-3）
      return new TransportError(`${method} 传输中断：${message}`, { details });
    case -32602:
      return new BusinessError('INVALID_ARGUMENT', message, { details });
    case -32601:
      return new BusinessError('METHOD_NOT_FOUND', message, { details });
    case -32003:
      return new BusinessError('FORBIDDEN', message, { details });
    case -32004:
      return new BusinessError('NOT_FOUND', message, { details });
    case -32603:
      return new BusinessError('INTERNAL', message, { details });
    default:
      return new BusinessError('INTERNAL', message, { details });
  }
}

function classifyNetworkError(error, timeoutMs) {
  if (isRunnerError(error)) return error;
  const name = error instanceof Error ? error.name : '';
  const raw = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|aborted/i.test(raw)) {
    return new TransportError(`MCP 请求超时（${timeoutMs}ms）：${redact(truncate(raw, 300))}`);
  }
  return new TransportError(`MCP 传输失败：${redact(truncate(raw, ERROR_MESSAGE_LIMIT))}`);
}

/** SSE 响应可能包含多条事件；按 id 找本次请求的 JSON-RPC 消息。 */
async function parseSseResponse(response, id) {
  const text = await response.text();
  let fallback = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (parsed && parsed.id === id) return parsed;
    if (parsed && parsed.error) fallback = parsed;
  }
  if (fallback) return fallback;
  throw new TransportError('SSE 响应中没有找到对应的 JSON-RPC 消息');
}

function collectText(content) {
  if (!Array.isArray(content)) return null;
  const texts = [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item || item.type !== 'text') continue;
    const text = asString(item.text);
    if (text !== null) texts.push(text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

/** 兼容 {ok:true,data}、{schema_version,data}、{data} 三种信封。 */
function unwrap(value) {
  const record = asRecord(value);
  if (!record) return value;
  if (record.ok === true && 'data' in record) return record.data;
  if ('schema_version' in record && 'data' in record) return record.data;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'data') return record.data;
  return value;
}
