/**
 * 值守壳错误分层。
 *
 * 为什么单独分层：
 * - 配置/认证错误（exit 2）意味着“这次根本不该继续跑”，进程应立刻退出；
 * - 业务错误（exit 1）意味着“连上了，但这件活干不成”，任务要按状态机回报；
 * - 传输错误（exit 2）意味着“管道断了”，不能把它误当成任务失败写进卡片；
 *   否则网络抖一下，用户的验收记录里就会多出一条假的“命令失败”。
 *
 * 这三类错误的恢复语义不同，所以必须让调用方（index/runner）能一眼区分，
 * 而不是靠匹配错误字符串。
 */

export type ExitCode = 0 | 1 | 2;

export type ErrorKind = 'config' | 'auth' | 'transport' | 'business';

export interface CliErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** 所有可预期错误的基类；未预期异常不允许进入这里。 */
export class CliError extends Error {
  readonly kind: ErrorKind;
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    kind: ErrorKind,
    exitCode: ExitCode,
    code: string,
    message: string,
    options: CliErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.kind = kind;
    this.exitCode = exitCode;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** 配置缺失/非法、令牌缺失。exit 2，不重试。 */
export class ConfigError extends CliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('config', 2, 'CONFIG', message, { details });
    this.name = 'ConfigError';
  }
}

/** 401：立即停止，绝不重试（重试只会把错误令牌刷进日志）。 */
export class AuthError extends CliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('auth', 2, 'UNAUTHORIZED', message, { details });
    this.name = 'AuthError';
  }
}

/** 网络/协议层问题：连接拒绝、超时、响应不是 JSON。exit 2。 */
export class TransportError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super('transport', 2, 'TRANSPORT', message, options);
    this.name = 'TransportError';
  }
}

/**
 * 服务端明确返回的业务错误（INVALID_ARGUMENT / CONFLICT / EVIDENCE_REQUIRED…）。
 * exit 1；retryable 只用于提示，runner 不会自动重试写操作。
 */
export class BusinessError extends CliError {
  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super('business', 1, code, message, options);
    this.name = 'BusinessError';
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}

export function isTransportError(error: unknown): error is TransportError {
  return error instanceof TransportError;
}

export function isBusinessError(error: unknown): error is BusinessError {
  return error instanceof BusinessError;
}

/** 日志里统一用 code + message，避免把 Error.stack 里的敏感环境变量带出去。 */
export function errorMessage(error: unknown): string {
  if (error instanceof CliError) return `[${error.code}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
