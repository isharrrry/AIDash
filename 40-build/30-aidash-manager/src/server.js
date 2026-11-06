import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, MAX_WEB_PORT_TRIES, VERSION } from './constants.js';
import { handleApi, ok, fail, createApiContext, verifyManagerToken } from './api.js';
import { ManagerError } from './errors.js';
import { safeEqual } from './util.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIST = path.join(PACKAGE_ROOT, 'web-dist');
const COOKIE_NAME = 'aidash_manager_token';

/**
 * 监听地址不一定能直接放进 URL：`0.0.0.0` / `::` 是通配地址，浏览器和 curl
 * 都无法可靠连接（Windows 上直接失败）；IPv6 字面量还要求加方括号。
 * 这里只影响“打印/打开”的地址，bind 仍用用户给的值。
 */
export function formatHostForUrl(host) {
  const raw = String(host ?? '').replace(/^\[|\]$/g, '');
  const display = raw === '' || raw === '0.0.0.0' || raw === '::' ? '127.0.0.1' : raw;
  return display.includes(':') ? `[${display}]` : display;
}

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.map', 'application/json; charset=utf-8'],
]);

function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function tokenFromRequest(req, url) {
  const queryToken = url.searchParams.get('token');
  if (queryToken) return { token: queryToken, source: 'query' };
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME]) return { token: cookies[COOKIE_NAME], source: 'cookie' };
  const header = req.headers['x-aidash-manager-token'];
  if (typeof header === 'string' && header) return { token: header, source: 'header' };
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return { token: authorization.slice('Bearer '.length).trim(), source: 'bearer' };
  }
  return { token: null, source: null };
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / CLI / 同源导航
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...extraHeaders });
  res.end();
}

function sendStatic(req, res, pathname, webDist = WEB_DIST) {
  if (!fs.existsSync(path.join(webDist, 'index.html'))) {
    const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AIDash Manager</title>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:60px auto;line-height:1.7">
<h1>AIDash Manager ${VERSION}</h1>
<p>Web 前端尚未构建。开发时运行 <code>pnpm -C 40-build manager:dev</code>，
发布包请确认 <code>web-dist/index.html</code> 存在。</p>
<p>API 已可用：<code>/api/state</code>（需要访问令牌）。</p>
</body></html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  const filePath = path.resolve(webDist, `.${decoded}`);
  const rel = path.relative(webDist, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  let target = filePath;
  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    // SPA fallback：前端使用 hash/局部状态，未知路径一律回 index.html。
    target = path.join(webDist, 'index.html');
    try {
      stat = fs.statSync(target);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
  }
  const ext = path.extname(target).toLowerCase();
  const immutable = target.includes(`${path.sep}assets${path.sep}`) && /-[A-Za-z0-9_]{6,}\./.test(path.basename(target));
  res.writeHead(200, {
    'content-type': MIME.get(ext) ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(target).pipe(res);
}

export function createManagerServer({ store, host, port, startedAt, webDist = WEB_DIST }) {
  const managerToken = store.webToken();
  const apiContext = createApiContext({ store, host, port, startedAt });

  const server = http.createServer((req, res) => {
    securityHeaders(res);
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    if (url.pathname === '/healthz' || url.pathname === '/api/healthz') {
      ok(res, { status: 'ok', version: VERSION, uptime_ms: Date.now() - Date.parse(apiContext.startedAt) });
      return;
    }

    const { token, source } = tokenFromRequest(req, url);
    if (source === 'query') {
      if (!verifyManagerToken(token, managerToken)) {
        fail(res, new ManagerError('UNAUTHORIZED', '访问令牌不正确；请从命令行启动提示里复制完整链接', { status: 401 }));
        return;
      }
      // 令牌从地址栏挪到 HttpOnly Cookie，避免刷新/转发时把令牌留在历史与 Referer 里。
      url.searchParams.delete('token');
      const location = `${url.pathname}${url.search}`;
      const cookie = `${COOKIE_NAME}=${encodeURIComponent(managerToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`;
      redirect(res, location, { 'set-cookie': cookie });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!token || !safeEqual(token, managerToken)) {
        fail(res, new ManagerError('UNAUTHORIZED', '需要管理台访问令牌；请使用启动时打印的链接打开页面', { status: 401 }));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (!originAllowed(req)) {
          fail(res, new ManagerError('ORIGIN_DENIED', '请求来源与 Host 不一致，已拒绝', { status: 403 }));
          return;
        }
        const contentType = String(req.headers['content-type'] ?? '');
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          if (!contentType.includes('application/json')) {
            fail(res, new ManagerError('CONTENT_TYPE_REQUIRED', '写接口要求 application/json', { status: 415 }));
            return;
          }
        }
      }
      void handleApi(req, res, url, apiContext).then((handled) => {
        if (!handled && !res.headersSent) {
          fail(res, new ManagerError('NOT_FOUND', `未知 API：${req.method} ${url.pathname}`, { status: 404 }));
        }
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    sendStatic(req, res, url.pathname, webDist);
  });

  return {
    server,
    token: managerToken,
    url: `http://${formatHostForUrl(host)}:${port}`,
    setPort(actualPort) {
      apiContext.port = actualPort;
    },
  };
}

function listenOnce(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port, exclusive: true });
  });
}

/**
 * 默认端口被占用时自动往后找：管理台经常和别的本地开发工具抢端口，
 * 让用户为了一个默认值去改参数没有意义。显式 --port 时保持严格，
 * 因为脚本可能依赖那个端口。
 */
export async function startManagerServer({
  store,
  host = DEFAULT_WEB_HOST,
  port = DEFAULT_WEB_PORT,
  strictPort = false,
  webDist = WEB_DIST,
}) {
  const startedAt = new Date().toISOString();
  let lastError = null;
  const tries = strictPort ? 1 : MAX_WEB_PORT_TRIES;
  for (let offset = 0; offset < tries; offset += 1) {
    const candidate = port + offset;
    if (candidate > 65535) break;
    const { server, token, url, setPort } = createManagerServer({ store, host, port: candidate, startedAt, webDist });
    try {
      const address = await listenOnce(server, host, candidate);
      const actualPort = typeof address === 'object' && address ? address.port : candidate;
      setPort(actualPort);
      const accessUrl = `http://${formatHostForUrl(host)}:${actualPort}`;
      store.writeWebRuntime({
        pid: process.pid,
        host,
        port: actualPort,
        url: accessUrl,
        started_at: startedAt,
      });
      return {
        server,
        host,
        port: actualPort,
        token,
        url: accessUrl,
        startedAt,
      };
    } catch (error) {
      lastError = error;
      try {
        server.close();
      } catch {
        // server 从未监听成功时 close 可能抛 ERR_SERVER_NOT_RUNNING；没有资源需要回收。
      }
      if (error && error.code === 'EADDRINUSE' && !strictPort) continue;
      throw new ManagerError('LISTEN_FAILED', `无法监听 ${host}:${candidate}：${error.message}`, {
        status: 500,
      });
    }
  }
  throw new ManagerError(
    'LISTEN_FAILED',
    `默认端口 ${port} 起连续 ${tries} 个端口都被占用；请用 --port 指定空闲端口（${lastError?.message ?? ''}）`,
    { status: 500 },
  );
}

/**
 * 拉起系统浏览器。返回是否成功“启动命令”——spawn 的错误是异步抛出的，
 * 老实现直接 return true 会把“没有图形环境/缺少 xdg-open”误报成成功，
 * 启动提示里那句“请手动复制链接”就永远不会出现。
 */
export function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => finish(true));
      child.once('error', () => finish(false));
      child.unref();
    } catch {
      finish(false);
    }
  });
}
