/**
 * 统一 REST 客户端。
 *
 * 设计要点：
 * 1. 令牌只从 localStorage['aidash.token'] 读取，并只放在 Authorization 头里；
 *    不拼进 URL，避免被代理日志、浏览器历史记录二次泄露。
 * 2. 响应包络兼容两种后端实现：任务契约的 {ok,data,error} 与设计文档 04 的
 *    {schema_version,data,meta}。前端只认 data/error，不让页面关心包络差异。
 * 3. 网络错误、HTTP 错误、业务错误统一抛 ApiError，调用方可以按 code 分支，
 *    不会出现“请求失败但页面继续跑”的静默失败。
 */

export interface ApiErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    status: number,
    retryable = false,
    details: unknown = undefined,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.status = status;
  }
}

export const TOKEN_KEY = 'aidash.token';
const API_PREFIX = '/api';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 localStorage 可能抛异常；此时按“未登录”处理即可。
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 写入失败由后续 401 暴露，不在这里中断渲染。
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 忽略：清理失败不影响内存中的退出状态。
  }
}

const unauthorizedListeners = new Set<() => void>();

/** App 注册一次，收到 401 后清令牌并回到令牌输入页。 */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function emitUnauthorized(): void {
  for (const listener of [...unauthorizedListeners]) listener();
}

export type QueryPrimitive = string | number | boolean | null | undefined;

/**
 * 数组按后端约定用逗号连接（type=info,handoff）。
 * 空字符串与 null 直接省略，避免发出 `?status=` 这种“看起来筛选了”的空条件。
 */
export function buildQuery(
  params: Record<string, QueryPrimitive | QueryPrimitive[]>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const parts = value
        .filter((item) => item !== undefined && item !== null && item !== '')
        .map((item) => String(item));
      if (parts.length > 0) search.set(key, parts.join(','));
      continue;
    }
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

interface Envelope {
  ok?: boolean;
  data?: unknown;
  error?: ApiErrorPayload;
  [key: string]: unknown;
}

/** 解析 JSON；非 JSON 或空响应返回 null，由调用方按状态码决定语义。 */
async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractError(payload: unknown): ApiErrorPayload | null {
  if (!isRecord(payload)) return null;
  const raw = payload.error;
  if (isRecord(raw) && typeof raw.code === 'string') {
    return {
      code: raw.code,
      message: typeof raw.message === 'string' ? raw.message : raw.code,
      retryable: raw.retryable === true,
      details: raw.details,
    };
  }
  // 有些实现把错误直接摊平在顶层。
  if (typeof payload.code === 'string' && payload.ok === false) {
    return {
      code: payload.code,
      message: typeof payload.message === 'string' ? payload.message : payload.code,
      retryable: payload.retryable === true,
      details: payload.details,
    };
  }
  return null;
}

function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'INVALID_ARGUMENT';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'BUSY';
    default:
      return 'INTERNAL';
  }
}

function toApiError(
  status: number,
  payload: unknown,
  fallbackMessage: string,
): ApiError {
  const parsed = extractError(payload);
  const code = parsed?.code ?? statusToCode(status);
  const message = parsed?.message ?? fallbackMessage;
  return new ApiError(code, message, status, parsed?.retryable ?? false, parsed?.details);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: options.signal,
      // 面板展示的是实时状态，浏览器缓存会让“刷新”看起来没生效。
      cache: 'no-store',
    });
  } catch (error) {
    // AbortError 是调用方主动取消（组件卸载/切换筛选），必须原样抛出。
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('NETWORK_ERROR', '无法连接 AIDash 服务，请确认服务已启动', 0, true);
  }

  const payload = await readPayload(response);

  if (!response.ok) {
    const apiError = toApiError(response.status, payload, `请求失败（HTTP ${response.status}）`);
    if (apiError.code === 'UNAUTHORIZED') emitUnauthorized();
    throw apiError;
  }

  if (isRecord(payload)) {
    const envelope = payload as Envelope;
    if (envelope.ok === false) {
      const apiError = toApiError(response.status, payload, '请求失败');
      if (apiError.code === 'UNAUTHORIZED') emitUnauthorized();
      throw apiError;
    }
    // 设计文档 04 的包络没有 ok 字段，但一定有 data；任务契约则有 ok+data。
    if ('data' in envelope) return envelope.data as T;
  }

  return payload as T;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'UNAUTHORIZED';
}
