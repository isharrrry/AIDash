import {
  CONTROL_REQUEST_TIMEOUT_MS,
} from './constants.js';
import { ControlError } from './errors.js';

/**
 * 控制面客户端。
 *
 * 控制面只暴露在本机随机端口，用 registry 里的随机会话令牌做 Bearer 校验。
 * 它和 AIDash 的 MCP 令牌是两套东西：控制令牌丢了最多是本机无法查询/停止，
 * MCP 令牌丢了则会把任务执行权暴露出去。两者绝不能复用。
 */

/** 只允许回环地址，防止 registry 被改坏后把控制令牌发给外部主机。 */
export function isLoopbackControlUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  return url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
}

export async function controlRequest({
  controlUrl,
  controlToken,
  pathname = '/health',
  method = 'GET',
  body,
  timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
}) {
  if (!isLoopbackControlUrl(controlUrl)) {
    throw new ControlError(400, `控制面地址必须是 http://127.0.0.1:<port>（收到 ${controlUrl}）`);
  }
  if (!controlToken) throw new ControlError(401, 'registry 中没有 control_token，无法访问控制面');

  const url = new URL(String(pathname).replace(/^\/+/, ''), `${controlUrl.replace(/\/+$/, '')}/`);
  const headers = { authorization: `Bearer ${controlToken}`, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ControlError(0, `无法连接控制面 ${controlUrl}：${reason}`);
  }

  const text = await response.text().catch(() => '');
  let parsed = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (response.status === 401) {
    throw new ControlError(401, '控制面令牌校验失败：registry 可能已过期或被其他进程替换');
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === 'object' ? parsed.error : null;
    const message =
      (error && typeof error.message === 'string' && error.message) ||
      (parsed && typeof parsed.message === 'string' && parsed.message) ||
      text ||
      `HTTP ${response.status}`;
    const code = error && typeof error.code === 'string' ? error.code : 'CONTROL_ERROR';
    throw new ControlError(response.status, message, { code, ...(error?.details ?? {}) });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ControlError(response.status, '控制面返回的不是合法 JSON');
  }
  if (parsed.ok === false) {
    const error = parsed.error ?? {};
    throw new ControlError(response.status, error.message ?? '控制面返回失败', {
      code: error.code,
      ...(error.details ?? {}),
    });
  }
  return parsed.data !== undefined ? parsed.data : parsed;
}

export function getControlHealth(entry, options = {}) {
  return controlRequest({
    controlUrl: entry.control_url,
    controlToken: entry.control_token,
    pathname: '/health',
    ...options,
  });
}

export function getControlStatus(entry, options = {}) {
  return controlRequest({
    controlUrl: entry.control_url,
    controlToken: entry.control_token,
    pathname: '/status',
    ...options,
  });
}

export function requestControlPull(entry, options = {}) {
  return controlRequest({
    controlUrl: entry.control_url,
    controlToken: entry.control_token,
    pathname: '/pull',
    method: 'POST',
    ...options,
  });
}

export function requestControlStop(entry, options = {}) {
  return controlRequest({
    controlUrl: entry.control_url,
    controlToken: entry.control_token,
    pathname: '/stop',
    method: 'POST',
    ...options,
  });
}

export function requestControlConfig(entry, patch, persist, options = {}) {
  return controlRequest({
    controlUrl: entry.control_url,
    controlToken: entry.control_token,
    pathname: '/config',
    method: 'POST',
    body: { set: patch, persist: persist === true },
    ...options,
  });
}

export function requestControlReload(entry, options = {}) {
  return controlRequest({
    controlUrl: entry.control_url,
    controlToken: entry.control_token,
    pathname: '/reload',
    method: 'POST',
    ...options,
  });
}
