import crypto from 'node:crypto';
import http from 'node:http';
import { CONTROL_BODY_LIMIT_BYTES, CONTROL_TOKEN_BYTES } from './constants.js';
import { ConfigError, ControlError, errorMessage } from './errors.js';

/**
 * 每个实例自己的本地控制面。
 *
 * 设计约束：
 * - 只监听 127.0.0.1，端口交给系统分配（避免固定端口冲突，也避免被局域网访问）；
 * - 所有请求都要 Bearer 控制令牌，包括 /health —— PID 复用检测依赖 /health 的
 *   指纹，如果没有鉴权，本机任意进程都能伪造一个“我就是那个实例”的响应；
 * - 令牌用 timingSafeEqual 比较，避免按字节比较泄露前缀；
 * - 控制面不是业务 API：端点少、返回结构固定，脚本用 `--json` 消费。
 */

export async function startControlServer({
  identity,
  getStatus,
  onPull,
  onStop,
  onConfig,
  onReload,
  controlToken,
  logger,
}) {
  const token =
    typeof controlToken === 'string' && controlToken
      ? controlToken
      : crypto.randomBytes(CONTROL_TOKEN_BYTES).toString('hex');

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      logger?.warn(`控制面请求处理失败：${errorMessage(error)}`);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL', errorMessage(error));
      else res.end();
    });
  });

  async function handleRequest(req, res) {
    if (!isAuthorized(req.headers.authorization, token)) {
      sendError(res, 401, 'UNAUTHORIZED', '缺少或错误的控制面令牌');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (pathname === '/health') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      const info = identity();
      sendOk(res, 200, { ...info, healthy: true });
      return;
    }

    if (pathname === '/status') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      sendOk(res, 200, getStatus());
      return;
    }

    if (pathname === '/pull') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      req.resume();
      const result = onPull();
      sendOk(res, 200, { ...result, status: getStatus() });
      return;
    }

    if (pathname === '/stop') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      req.resume();
      sendOk(res, 202, { stopping: true });
      // 先把响应写回去，再触发收尾：如果在 handler 里同步 abort，
      // 调用方会看到连接被重置而不是“已接受停止请求”。
      const timer = setTimeout(() => onStop(), 25);
      timer.unref();
      return;
    }

    if (pathname === '/config') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendError(res, error.status ?? 400, error.code ?? 'INVALID_ARGUMENT', error.message);
        return;
      }
      const set = extractPatch(body);
      const persist = body?.persist === true;
      if (!set) {
        sendError(res, 400, 'INVALID_ARGUMENT', '请求体必须是 {"set":{...},"persist":false}');
        return;
      }
      try {
        const result = onConfig(set, persist);
        sendOk(res, 200, result);
      } catch (error) {
        sendConfigError(res, error);
      }
      return;
    }

    if (pathname === '/reload') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      req.resume();
      try {
        const result = onReload();
        sendOk(res, 200, result);
      } catch (error) {
        sendConfigError(res, error);
      }
      return;
    }

    sendError(res, 404, 'NOT_FOUND', `未知控制面端点：${method} ${pathname}`);
  }

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });

  const url = `http://127.0.0.1:${port}`;
  return {
    server,
    token,
    url,
    port,
    close: () =>
      new Promise((resolve) => {
        let finished = false;
        let fallback = null;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (fallback) clearTimeout(fallback);
          resolve();
        };
        // 先关空闲连接，让 keep-alive 不再吊住 close；仍在传响应的连接给 500ms，
        // 之后强制断开，避免进程退出被一个失控客户端卡住。
        server.closeIdleConnections?.();
        server.close(finish);
        fallback = setTimeout(() => {
          server.closeAllConnections?.();
          finish();
        }, 500);
        fallback.unref();
      }),
  };
}

function isAuthorized(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function extractPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.set && typeof body.set === 'object' && !Array.isArray(body.set)) return body.set;
  if (typeof body.key === 'string') return { [body.key]: body.value };
  const keys = Object.keys(body).filter((key) => key !== 'persist');
  if (keys.length > 0) {
    const patch = {};
    for (const key of keys) patch[key] = body[key];
    return patch;
  }
  return null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > CONTROL_BODY_LIMIT_BYTES) {
        fail(new ControlError(413, `请求体超过 ${CONTROL_BODY_LIMIT_BYTES} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => fail(new ControlError(400, `读取请求体失败：${error.message}`)));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new ControlError(400, '请求体必须是 JSON 对象'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new ControlError(400, '请求体不是合法 JSON'));
      }
    });
  });
}

function sendOk(res, status, data) {
  sendJson(res, status, { ok: true, data });
}

function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  sendJson(res, status, { ok: false, error });
}

function sendConfigError(res, error) {
  if (error instanceof ConfigError) {
    sendError(res, 400, error.code, error.message);
    return;
  }
  if (error instanceof ControlError) {
    sendError(res, error.status || 400, error.details?.code ?? 'CONTROL_ERROR', error.message);
    return;
  }
  sendError(res, 500, 'INTERNAL', errorMessage(error));
}

function methodNotAllowed(res, allow) {
  res.setHeader('allow', allow);
  sendError(res, 405, 'METHOD_NOT_ALLOWED', `只支持 ${allow}`);
}

function sendJson(res, status, payload) {
  const text = `${JSON.stringify(payload)}\n`;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(text));
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}
