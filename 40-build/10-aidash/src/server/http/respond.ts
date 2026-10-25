import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, HTTP_STATUS, toAppError } from '../../shared/errors.js';

/** 统一成功信封：页面只认 data，错误只认 error，不用猜顶层字段。 */
export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

export function fail(res: Response, error: unknown): void {
  const appError = toAppError(error);
  res.status(HTTP_STATUS[appError.code]).json({ ok: false, error: appError.toBody() });
}

/** Express 5 已能捕获 async 异常，这个包装让意图显式，也方便单元测试。 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function requireString(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('INVALID_ARGUMENT', 'PARAM_REQUIRED', { key });
  }
  return value;
}

export function queryString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function queryInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError('INVALID_ARGUMENT', 'PARAM_OUT_OF_RANGE', { min, max });
  }
  return n;
}

export function queryBool(value: unknown): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * 三态布尔：参数缺省必须是 undefined，而不是 false。
 *
 * 为什么不能直接复用 queryBool：
 * `has_risk=false` 在仓储层是“排除带隐患任务”，`undefined` 才是“不筛”。
 * 列表接口如果把缺省值折成 false，会把带隐患任务从默认列表里静默剔除，
 * 且 `risk_open=true` 会同时叠加“无隐患”和“有未解除隐患”两个互斥条件，恒为空。
 */
export function queryBoolOptional(value: unknown): boolean | undefined {
  return value === undefined ? undefined : queryBool(value);
}

/** 逗号分隔列表，顺带去重，避免 IN (?,?) 里出现重复参数。 */
export function queryList(value: unknown): string[] | undefined {
  const raw = queryString(value);
  if (!raw) return undefined;
  return [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
}

export function parseTime(value: unknown, key: string): number | undefined {
  const raw = queryString(value);
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new AppError('INVALID_ARGUMENT', 'INVALID_TIME', { key });
  }
  return parsed;
}
