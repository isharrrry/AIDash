import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { AppError, toAppError } from '../../shared/errors.js';
import type { AppContext } from '../context.js';
import type { Logger } from '../log.js';
import { mcpRouter } from '../mcp/index.js';
import { accessLog, bearerAuth, rateLimit, requestId } from './middleware.js';
import { fail, ok } from './respond.js';
import { SERVER_VERSION, adminRouter } from './routes/admin.js';
import { askHandler, cardsRouter } from './routes/cards.js';
import { channelsRouter } from './routes/channels.js';
import { kbRouter } from './routes/kb.js';
import { memoryRouter } from './routes/memory.js';
import { reportsRouter } from './routes/reports.js';
import { tasksRouter } from './routes/tasks.js';

// 任务描述允许内嵌截图（base64），1MB 会在两张大图时就 413。
// 上限按“字符”而不是“字节”校验：2,000,000 个中文字符最多约 6 MB，emoji 最多约 8 MB，
// 所以 body 必须留到 10 MB，否则请求会先被 413 拒绝、根本走不到 schema 的字符上限检查。
// 仍是本机单用户服务，10 MB 的内存峰值可接受。
const JSON_BODY_LIMIT = '10mb';

/**
 * Express 装配。
 *
 * 顺序很重要：
 * 1. 安全头与请求 id 最先，错误响应也带 id；
 * 2. 限流在鉴权之前，错误的令牌也会消耗配额（防爆破）；
 * 3. JSON 解析在鉴权之后：10MB 请求体的解析本身耗 CPU/内存，
 *    先解析等于给未认证请求开了免费算力；解析错误也不该抢在 401 前面返回；
 * 4. MCP 与 REST 共用同一份 bearer 校验。
 */
export function createApp(ctx: AppContext, log: Logger): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(requestId());
  app.use(accessLog(log));
  // 限流只罩 /api 与 /mcp，**不罩静态资源**。
  // 为什么：一次页面加载就是 index.html + 若干带 hash 的 JS/CSS 分片，
  // 若它们也吃配额，用户刷新两次就把突发配额耗光、连 API 都调不了。
  // 这不是「防跑飞」，是误伤 —— 浏览器并发加载静态分片本来就是正常行为，
  // 而 REQ-FN-028 约束的对象是「每个令牌/harness 的请求」，指向的是业务调用。
  app.use('/api', rateLimit(ctx.config));
  app.use('/mcp', rateLimit(ctx.config));
  // 认证只罩住 /api 与 /mcp。
  // 浏览器加载页面和 <script>/<link> 时不会带 Authorization；若全局鉴权，
  // SPA 会在用户输入令牌之前就被 401 挡住，永远打不开。静态产物不含业务数据，
  // 真正的数据边界仍然在 /api 与 /mcp 上。
  app.use('/api', bearerAuth(ctx.config));
  app.use('/mcp', bearerAuth(ctx.config));

  // 解析放在限流与鉴权之后：未认证/已限流的请求不再为 10MB 请求体做 JSON.parse。
  // 已被拒绝的请求体留在流里，Node 会按连接语义处理；Express 不需要先读空它。
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.get('/healthz', (_req, res) => {
    // 探活同时回答“连的是哪个库”：路径漂移时，空库也能返回 ok，
    // 只靠 ok 会让人误判数据还在。只监听回环地址，路径属于本机信息。
    res.json({
      ok: true,
      status: 'ok',
      version: SERVER_VERSION,
      db_path: ctx.config.dbPath === ':memory:' ? ':memory:' : path.resolve(ctx.config.dbPath),
    });
  });

  app.post('/api/ask', askHandler(ctx));
  app.use('/api/channels', channelsRouter(ctx));
  app.use('/api/cards', cardsRouter(ctx));
  app.use('/api/tasks', tasksRouter(ctx));
  app.use('/api/memory', memoryRouter(ctx));
  app.use('/api/reports', reportsRouter(ctx));
  app.use('/api/kb', kbRouter(ctx));
  app.use('/api', adminRouter(ctx));
  app.use('/mcp', mcpRouter(ctx, log));

  // 未匹配的 API 路径明确返回 JSON 404，避免 SPA fallback 把调用方引到 HTML。
  app.use('/api', (_req, res) => {
    fail(res, new AppError('NOT_FOUND', 'ENDPOINT_NOT_FOUND'));
  });
  app.use('/mcp', (_req, res) => {
    fail(res, new AppError('NOT_FOUND', 'ENDPOINT_NOT_FOUND'));
  });

  mountStatic(app, ctx.config.staticDir);

  app.use(errorHandler(log));
  return app;
}

function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  if (req.path.startsWith('/api') || req.path.startsWith('/mcp')) {
    res.setHeader('cache-control', 'no-store');
  }
  next();
}

/**
 * 静态页面 + SPA fallback。
 * 只在 dist/web/index.html 存在时启用；开发期走 Vite dev server 的代理，
 * 后端不需要为了前端不存在而报错。
 */
function mountStatic(app: Express, configuredDir: string): void {
  const dir = path.resolve(configuredDir);
  const indexFile = path.join(dir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    app.get('/', (_req, res) => {
      ok(res, {
        service: 'AIDash',
        version: SERVER_VERSION,
        note: 'Web 前端尚未构建：请先运行 pnpm web:build，或使用 pnpm web:dev。',
      });
    });
    return;
  }

  app.use(
    express.static(dir, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, file) => {
        // 带 hash 的构建产物可长缓存；index.html 必须每次回源，否则升级后页面不更新。
        if (file.endsWith('index.html')) res.setHeader('cache-control', 'no-store');
      },
    }),
  );
  app.get(/^(?!\/api(?:\/|$)|\/mcp(?:\/|$)|\/healthz$).*/, (_req, res) => {
    res.sendFile(indexFile);
  });
}

function errorHandler(log: Logger) {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof ZodError) {
      fail(
        res,
        new AppError('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      );
      return;
    }
    // express.json 的语法错误：给 400，而不是落到 INTERNAL。
    if (error instanceof SyntaxError && 'body' in error) {
      fail(res, new AppError('INVALID_ARGUMENT', 'INVALID_JSON'));
      return;
    }
    const appError = toAppError(error);
    if (appError.code === 'INTERNAL') {
      log.error('request_failed', {
        method: req.method,
        path: req.path,
        request_id: res.locals.requestId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
    fail(res, appError);
  };
}
