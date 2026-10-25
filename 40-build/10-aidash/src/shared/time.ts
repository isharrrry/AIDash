/**
 * 时间约定（03 §2.4）：
 * - 存储用整数毫秒；
 * - 对外一律 ISO 8601 UTC 字符串；
 * - “现在”只能从 Clock 取，便于测试推进租约与过期。
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** 可手动推进的测试时钟；生产代码不得引用。 */
export class ManualClock implements Clock {
  private current: number;

  constructor(start = Date.UTC(2026, 0, 1)) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export function toIso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

/**
 * 解析外部 ISO 时间。
 * 非法值必须显式失败，不能静默变成 NaN 写进数据库。
 */
export function fromIso(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RangeError(`invalid ISO datetime: ${value}`);
  }
  return ms;
}

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const DAY_MS = 24 * 60 * MINUTE_MS;
