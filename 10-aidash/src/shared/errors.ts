/**
 * 统一业务错误。
 *
 * 设计意图（04 §2）：
 * - 业务层只抛 AppError，不抛数据库/HTTP 细节；
 * - 接入层据此映射 HTTP 状态码与 JSON-RPC code；
 * - retryable 决定调用方是否可以安全重试（写操作还需 idempotency_key）。
 */
export const ERROR_CODES = [
  'INVALID_ARGUMENT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'ALREADY_CLAIMED',
  'EVIDENCE_REQUIRED',
  'RATE_LIMITED',
  'BUSY',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_CLAIMED: 409,
  EVIDENCE_REQUIRED: 409,
  RATE_LIMITED: 429,
  BUSY: 503,
  INTERNAL: 500,
};

export const RETRYABLE: Record<ErrorCode, boolean> = {
  INVALID_ARGUMENT: false,
  UNAUTHORIZED: false,
  FORBIDDEN: false,
  NOT_FOUND: false,
  CONFLICT: false,
  ALREADY_CLAIMED: true,
  EVIDENCE_REQUIRED: false,
  RATE_LIMITED: true,
  BUSY: true,
  INTERNAL: false,
};

/** JSON-RPC 错误码映射（04 §2.3） */
export const JSON_RPC_CODE: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: -32602,
  NOT_FOUND: -32004,
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32003,
  CONFLICT: -32000,
  ALREADY_CLAIMED: -32000,
  EVIDENCE_REQUIRED: -32000,
  RATE_LIMITED: -32000,
  BUSY: -32000,
  INTERNAL: -32603,
};

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/**
 * 业务异常的唯一定义。
 * details 只允许放可公开元数据（守卫 ID、枚举值、字段名），禁止放 SQL/路径/令牌。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    retryable?: boolean,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.retryable = retryable ?? RETRYABLE[code];
  }

  toBody(): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** 把任意异常收敛为 AppError；未知异常不把原始信息暴露给调用方。 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError('INTERNAL', 'INTERNAL_ERROR');
}
