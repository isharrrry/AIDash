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
 * 单凭据认证：AIDASH_TOKEN（可以是一句短口令）。
 *
 * 为什么先 sha256 再比较：timingSafeEqual 要求等长输入；
 * 先哈希把任意长度凭据收敛成 32 字节，同时避免长度差异本身泄露信息。
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
  /** 当前可用令牌数。用浮点：按毫秒补充，整数会让实际速率被向下截断。 */
  tokens: number;
  /** 上次补充令牌的时间戳。 */
  updatedAt: number;
}

/**
 * 令牌桶限流（REQ-FN-028：默认每令牌 300 请求/分钟、突发 60）。
 *
 * 为什么从固定窗口换成令牌桶：固定窗口有两个真问题 ——
 *   1. 边界效应：窗口末尾打满、下一秒再打满，实际峰值是配额的 2 倍；
 *   2. 表达不了「突发」：固定窗口只有一个数，说不清「长期 300/分钟、但允许一口气 60 个」。
 * 令牌桶把这两件事拆成两个参数（速率 + 容量），正好对应需求里的 300 与 60。
 *
 * 分桶键：当前是**单主体认证**（bearerAuth 比对 token 或可选口令），
 * 所以全进程只有一个桶 —— 这正是 REQ-FN-028 说的「每个令牌」。
 * 不按 req.ip：同一台机器上跑多个 harness 会共用一个配额，一个跑飞全被 429；
 * 而换个 IP 就能绕过，说明它本来也不是安全边界。
 * 将来若引入多令牌，把闭包里那个单桶换成 Map<令牌, Bucket> 即可，桶算法不用动。
 */
export function rateLimit(config: AppConfig): RequestHandler {
  const capacity = Math.max(1, config.rateLimitBurst);
  // 每毫秒补充多少令牌。300/分钟 = 每秒 5 个 = 每毫秒 0.005 个。
  const refillPerMs = config.rateLimitPerMinute / 60_000;

  // 单个桶（见上面的分桶键说明）。闭包持有，不放进全局 Map：
  // 只有一个 key 的 Map 除了增加「什么时候清理」的悬案，没有任何好处。
  let bucket: Bucket = { tokens: capacity, updatedAt: Date.now() };

  return (_req: Request, res: Response, next: NextFunction) => {
    // 范围由挂载点决定（app.ts 只把它挂在 /api 与 /mcp 上）：
    // /healthz 与静态资源根本不进这个中间件，所以这里不再判断路径。
    // 判断反而有害 —— 挂着全局时它像个安全网，实际漏掉了静态资源那一大片。
    const now = Date.now();

    // 按经过的时间补充，上限为容量。这样长时间空闲后能攒满到 burst，
    // 而不是「每次请求只补 1 个」——后者会让突发配额永远用不上。
    const elapsed = now - bucket.updatedAt;
    if (elapsed > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = now;
    }

    if (bucket.tokens < 1) {
      // 等够 1 个令牌需要多久。向上取整到秒：Retry-After 只接受整秒，
      // 向下取整会让客户端在还差几十毫秒时又打一次，继续吃 429。
      const waitMs = (1 - bucket.tokens) / refillPerMs;
      res.setHeader('retry-after', String(Math.max(1, Math.ceil(waitMs / 1000))));
      res.setHeader('x-ratelimit-remaining', '0');
      next(new AppError('RATE_LIMITED', 'RATE_LIMITED'));
      return;
    }

    bucket.tokens -= 1;
    res.setHeader('x-ratelimit-remaining', String(Math.floor(bucket.tokens)));
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
