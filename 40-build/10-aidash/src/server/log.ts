export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 极简结构化日志：一行 JSON，便于 grep 与后续接入采集。
 * 不在日志层做全文脱敏的原因：调用方只应传已收敛的字段（错误码、对象 id），
 * 真正的脱敏责任在 audit-service 与错误映射层；这里额外挡一层常见键名。
 */
export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];
  const write = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      msg: message,
      ...(fields ? scrub(fields) : {}),
    });
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization/i;

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) {
      result[key] = '[redacted]';
    } else if (value instanceof Error) {
      result[key] = { name: value.name, message: value.message };
    } else {
      result[key] = value;
    }
  }
  return result;
}
