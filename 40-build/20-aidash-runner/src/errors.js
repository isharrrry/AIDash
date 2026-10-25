/**
 * 错误分层。
 *
 * 为什么必须分：调用方处理方式完全不同——
 * - config/auth：这次根本不该继续，退出码 2，且 401 之后一个请求都不能再发；
 * - transport：管道断了，值守壳要退避重连，不能把网络抖动记成任务失败；
 * - business：连上了但这件事做不成，任务级错误只影响当前任务，不能打死常驻进程。
 *
 * 如果只靠匹配错误字符串，改一句服务端文案就会让恢复策略失效。
 */
export class RunnerError extends Error {
  /**
   * @param {'config'|'auth'|'transport'|'business'} kind
   * @param {0|1|2} exitCode
   * @param {string} code
   * @param {string} message
   * @param {{retryable?: boolean, details?: Record<string, unknown>, cause?: unknown}} [options]
   */
  constructor(kind, exitCode, code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RunnerError';
    this.kind = kind;
    this.exitCode = exitCode;
    this.code = code;
    this.retryable = options.retryable === true;
    this.details = options.details;
  }
}

export class ConfigError extends RunnerError {
  constructor(message, details) {
    super('config', 2, 'CONFIG', message, { details });
    this.name = 'ConfigError';
  }
}

/** 401：立即停止，绝不重试。重试只会把错误令牌不断送到服务端。 */
export class AuthError extends RunnerError {
  constructor(message, details) {
    super('auth', 2, 'UNAUTHORIZED', message, { details });
    this.name = 'AuthError';
  }
}

export class TransportError extends RunnerError {
  constructor(message, options = {}) {
    super('transport', 2, 'TRANSPORT', message, { ...options, retryable: true });
    this.name = 'TransportError';
  }
}

export class BusinessError extends RunnerError {
  constructor(code, message, options = {}) {
    super('business', 1, code, message, options);
    this.name = 'BusinessError';
  }
}

/**
 * 连续同因失败熔断：不是配置错误，也不是网络问题，而是“命令在当前环境里
 * 稳定地快速失败”。继续拉后续任务只会把同一条任务反复跑成 failed，所以主动
 * 停实例；退出码 1 让守护脚本/人能看到“它不是正常空闲退出”。
 */
export class CircuitBreakerError extends RunnerError {
  constructor(message, details) {
    super('business', 1, 'CIRCUIT_BREAKER', message, { details });
    this.name = 'CircuitBreakerError';
  }
}

/** 控制面内部错误：status 是 HTTP 状态码，供 control-server 统一转响应。 */
export class ControlError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ControlError';
    this.status = status;
    this.details = details;
  }
}

export function isRunnerError(error) {
  return error instanceof RunnerError;
}

export function isAuthError(error) {
  return error instanceof AuthError;
}

export function isTransportError(error) {
  return error instanceof TransportError;
}

export function isBusinessError(error) {
  return error instanceof BusinessError;
}

export function errorMessage(error) {
  if (error instanceof RunnerError) return `[${error.code}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
