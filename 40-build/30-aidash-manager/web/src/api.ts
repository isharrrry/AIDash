import type {
  AidashConfigView,
  ConfigView,
  CreatePayload,
  DiscoverResult,
  ErrorSummary,
  HarnessTemplate,
  LogResult,
  ManagerState,
  PortCheck,
  RunnerConfigView,
  Service,
} from './types';

const TOKEN_KEY = 'aidash_manager_token';

export class ApiError extends Error {
  code: string;
  status: number;
  details: unknown;

  constructor(message: string, code: string, status: number, details: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class Unauthorized extends ApiError {}

export function getStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setStoredToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 sessionStorage 可能不可用；此时依赖 Cookie。
  }
}

async function request<T>(pathname: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = getStoredToken();
  if (token) headers['x-aidash-manager-token'] = token;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(pathname, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new ApiError(`无法连接管理台：${error instanceof Error ? error.message : String(error)}`, 'NETWORK', 0, null);
  }
  let payload: unknown = null;
  const text = await response.text().catch(() => '');
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  const envelope = payload as
    | { ok?: boolean; data?: T; error?: { code?: string; message?: string; details?: unknown } }
    | null;
  if (!response.ok || !envelope || envelope.ok !== true) {
    const message = envelope?.error?.message ?? (text || `HTTP ${response.status}`);
    const error = new ApiError(
      message,
      envelope?.error?.code ?? 'HTTP_ERROR',
      response.status,
      envelope?.error?.details ?? null,
    );
    if (response.status === 401) throw new Unauthorized(message, error.code, 401, error.details);
    throw error;
  }
  return envelope.data as T;
}

export const api = {
  state: () => request<ManagerState>('/api/state'),
  templates: () => request<HarnessTemplate[]>('/api/templates'),
  discover: (cwd: string, appDir = '') =>
    request<DiscoverResult>(
      `/api/discover?cwd=${encodeURIComponent(cwd)}${appDir ? `&appDir=${encodeURIComponent(appDir)}` : ''}`,
    ),
  checkPort: (host: string, port: number) =>
    request<PortCheck>(`/api/ports?host=${encodeURIComponent(host)}&port=${port}`),
  createService: (payload: CreatePayload) => request<Service>('/api/services', { method: 'POST', body: payload }),
  updateService: (id: string, payload: Record<string, unknown>) =>
    request<Service>(`/api/services/${encodeURIComponent(id)}`, { method: 'PUT', body: payload }),
  deleteService: (id: string, force: boolean) =>
    request<{ removed: string; name: string }>(
      `/api/services/${encodeURIComponent(id)}?force=${force ? 'true' : 'false'}`,
      { method: 'DELETE' },
    ),
  start: (id: string) =>
    request<{ service: Service; runtime: unknown }>(`/api/services/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      body: {},
    }),
  stop: (id: string, force: boolean) =>
    request<{ service: Service; runtime: unknown }>(`/api/services/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      body: { force },
    }),
  restart: (id: string) =>
    request<{ service: Service; runtime: unknown }>(`/api/services/${encodeURIComponent(id)}/restart`, {
      method: 'POST',
      body: {},
    }),
  logs: (id: string, source: string, lines: number) =>
    request<LogResult>(
      `/api/services/${encodeURIComponent(id)}/logs?source=${encodeURIComponent(source)}&lines=${lines}`,
    ),
  errors: (id: string) =>
    request<ErrorSummary>(`/api/services/${encodeURIComponent(id)}/errors`),
  config: (id: string) =>
    request<ConfigView>(`/api/services/${encodeURIComponent(id)}/config`),
  saveConfig: (id: string, body: Record<string, unknown>) =>
    request<{ service: Service; config: AidashConfigView | RunnerConfigView; warnings?: string[] }>(
      `/api/services/${encodeURIComponent(id)}/config`,
      { method: 'PUT', body },
    ),
  applyTemplate: (id: string, templateKey: string) =>
    request<{ service: Service; config: RunnerConfigView; warnings?: string[] }>(
      `/api/services/${encodeURIComponent(id)}/config/template`,
      { method: 'POST', body: { templateKey } },
    ),
  setToken: (id: string, token: string) =>
    request<{ has_token: boolean }>(`/api/services/${encodeURIComponent(id)}/token`, {
      method: 'POST',
      body: { token },
    }),
  open: (id: string) =>
    request<{ url: string | null }>(`/api/services/${encodeURIComponent(id)}/open`, {
      method: 'POST',
      body: {},
    }),
};
