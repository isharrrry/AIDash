import { isAuthError, isTransportError } from './errors.js';
import { sleep as defaultSleep } from './util.js';

/**
 * 有界重试：只用于「状态回报」这类可以安全重复的幂等调用。
 *
 * 为什么需要它：服务端对连续任务会限流（HTTP 429 / 工具码 RATE_LIMITED）。
 * 旧实现收到限流只打一条 WARN 就放弃，`task.update` 与 `task.release` 不会
 * 自动补发，任务就卡在 claimed/in_progress 直到租约过期——用户看到的是
 * “任务明明跑完了却一直不动”。
 *
 * 边界：
 * - 最多 3 次尝试，退避 500ms / 1500ms；
 * - 只重试 AuthError 之外、明确标记 retryable 的错误（RATE_LIMITED / BUSY）
 *   或 TransportError；401 立即抛出，绝不再把坏令牌送一遍；
 * - 服务端给了 details.retry_after 时优先采用，但封顶 5 秒，避免一个异常值
 *   把值守壳睡死；
 * - 重试只包住“发请求”本身，不包命令执行，因此不会改变
 *   “命令跑过绝不 release / 租约丢失不 release”的安全语义。
 */

export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = Object.freeze([500, 1_500]);
export const MAX_RETRY_AFTER_MS = 5_000;

/** AuthError 永不重试；TransportError 按类判断；其余看 retryable 标记。 */
export function isRetryableError(error) {
  if (!error || isAuthError(error)) return false;
  if (isTransportError(error)) return true;
  return error.retryable === true;
}

function nonNegativeNumber(value) {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * 读取服务端建议的等待时间。
 * `retry_after` 按秒解释（HTTP/服务端常规约定）；同时兼容毫秒字段 `retry_after_ms`。
 * 无论来源如何都封顶 MAX_RETRY_AFTER_MS。
 */
export function retryAfterDelayMs(error) {
  const details = error?.details;
  if (!details || typeof details !== 'object') return null;

  const milliseconds = nonNegativeNumber(details.retry_after_ms ?? details.retryAfterMs);
  if (milliseconds !== null) return Math.min(milliseconds, MAX_RETRY_AFTER_MS);

  const seconds = nonNegativeNumber(details.retry_after ?? details.retryAfter);
  if (seconds !== null) return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);

  return null;
}

/** attempt 是刚失败的那次尝试序号（从 1 开始）。 */
export function retryDelayMs(error, attempt, { backoffMs = RETRY_BACKOFF_MS } = {}) {
  const fromServer = retryAfterDelayMs(error);
  if (fromServer !== null) return fromServer;
  const index = Math.max(0, Math.min(attempt - 1, backoffMs.length - 1));
  return backoffMs[index] ?? RETRY_BACKOFF_MS[0];
}

/**
 * 执行 operation，按策略重试。
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation
 * @param {{
 *   maxAttempts?: number,
 *   backoffMs?: number[],
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>,
 *   signal?: AbortSignal,
 *   onRetry?: (info: {error: Error, attempt: number, delayMs: number}) => void
 * }} [options]
 * @returns {Promise<T>}
 */
export async function callWithRetry(operation, options = {}) {
  const {
    maxAttempts = RETRY_MAX_ATTEMPTS,
    backoffMs = RETRY_BACKOFF_MS,
    sleep = defaultSleep,
    signal,
    onRetry,
  } = options;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isRetryableError(error) || attempt >= maxAttempts) throw error;

      const delayMs = retryDelayMs(error, attempt, { backoffMs });
      if (typeof onRetry === 'function') {
        try {
          onRetry({ error, attempt, delayMs });
        } catch {
          // 观察者失败不能改变重试决策。
        }
      }
      await sleep(delayMs, signal);
      // 等待期间被停止：把原始错误交出，让上层按 auth/stop 语义收尾。
      if (signal?.aborted) throw error;
    }
  }
}
