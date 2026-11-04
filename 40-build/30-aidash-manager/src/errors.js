/**
 * 统一错误类型：CLI 与 HTTP 共用一份 code/status/details。
 *
 * 为什么要 status：同一个失败在 CLI 里只需要一句人话，在 HTTP 里必须能给
 * 前端一个稳定的状态码。如果两边各写一套映射，最后一定出现“页面提示成功、
 * 命令行报失败”的分裂。
 */
export class ManagerError extends Error {
  constructor(code, message, { status = 400, details = undefined } = {}) {
    super(message);
    this.name = 'ManagerError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function toManagerError(error) {
  if (error instanceof ManagerError) return error;
  const message = errorMessage(error);
  // spawn 的 ENOENT/EACCES 是用户配置错误，不是内部异常；给 400 更利于页面提示。
  if (error && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'EACCES')) {
    return new ManagerError('SPAWN_FAILED', message, { status: 400, details: { cause: error.code } });
  }
  return new ManagerError('INTERNAL', message, { status: 500 });
}
