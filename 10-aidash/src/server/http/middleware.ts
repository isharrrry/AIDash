import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../../shared/errors.js';
import { newRequestId } from '../../shared/ids.js';
import type { Ctx } from '../../shared/types.js';
import type { AppConfig } from '../config.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * 请求 id：优先沿用调用方的，便于跨 MCP/REST 追踪；非法值不信任，重新生成。
 * 任何响应都回写 x-request-id，调用方报错时能直接对上审计记录。
 */
export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const id = incoming && REQUEST_ID.test(incoming) ? incoming : newRequestId();
    res.locals.requestId = id;
    res.setHeader('x-request-id', id);
    next();
  };
}

/**
 * 单令牌认证。
 * 为什么先 sha256 再比较：timingSafeEqual 要求等长输入；
 * 先哈希把任意长度令牌收敛成 32 字节，同时避免长度差异本身泄露信息。
 */
export function bearerAuth(config: AppConfig): RequestHandler {
  const expected = createHash('sha256').update(config.token).digest();
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/healthz') {
      next();
      return;
    }
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      next(new AppError('UNAUTHORIZED', 'AUTH_REQUIRED'));
      return;
    }
    const provided = createHash('sha256').update(match[1]!).digest();
    if (!timingSafeEqual(expected, provided)) {
      next(new AppError('UNAUTHORIZED', 'AUTH_INVALID_TOKEN'));
      return;
    }
    next();
  };
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * 固定窗口限流：本地单用户场景不需要令牌桶的平滑性，
 * 固定窗口实现更简单，也能防止失控 agent 把服务打满。
 */
export function rateLimit(config: AppConfig): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const windowMs = 60_000;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/healthz') {
      next();
      return;
    }
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
      // 顺手清理过期桶，避免长期运行后 Map 无限增长。
      if (buckets.size > 10_000) {
        for (const [k, value] of buckets) {
          if (value.resetAt <= now) buckets.delete(k);
        }
      }
    }
    bucket.count += 1;
    const remaining = Math.max(0, config.rateLimitPerMinute - bucket.count);
    res.setHeader('x-ratelimit-remaining', String(remaining));
    if (bucket.count > config.rateLimitPerMinute) {
      res.setHeader('retry-after', String(Math.ceil((bucket.resetAt - now) / 1000)));
      next(new AppError('RATE_LIMITED', 'RATE_LIMITED'));
      return;
    }
    next();
  };
}

/** 访问日志不放正文、不放头，只保留方法/路径/状态/耗时/请求 id。 */
export function accessLog(
  log: { info: (message: string, fields?: Record<string, unknown>) => void },
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => {
      log.info('http_request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        request_id: res.locals.requestId,
      });
    });
    next();
  };
}

export function ctxOf(res: Response, config: AppConfig): Ctx {
  return {
    actorLabel: config.tokenLabel,
    requestId: String(res.locals.requestId ?? newRequestId()),
    isOwner: true,
  };
}
