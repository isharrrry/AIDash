import { errorMessage } from './errors.js';

/**
 * CLI 日志与脱敏。
 *
 * 约定：
 * - 日志一律写 stderr，stdout 只留给 status/dry-run 的可读结果，方便管道处理；
 * - 写入前统一脱敏。令牌可能出现在服务端错误回显、子进程输出、甚至异常 message 里，
 *   所以脱敏必须放在“最后一厘米”，而不是依赖每个调用点自觉；
 * - 只比较短字符串，不打印令牌本身，也不打印 `Bearer` 后面的内容。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_ENV_KEYS = ['AIDASH_TOKEN', 'AIDASH_LLM_API_KEY'] as const;

export type LogMeta = Record<string, string | number | boolean | null | undefined>;

/**
 * 读取当前环境里的敏感值。
 * 长度小于 6 的值不参与替换：单字符令牌替换会破坏整行日志的可读性，
 * 而这类“令牌”本身也不具备可用强度。我们同时保证代码里从不主动打印令牌。
 */
function currentSecrets(): string[] {
  const secrets: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 6) secrets.push(value);
  }
  return secrets;
}

/** 文本脱敏：替换环境里的令牌值、Bearer 头、KEY=VALUE 形式。 */
export function redact(text: string): string {
  let output = text;
  for (const secret of currentSecrets()) {
    output = output.split(secret).join('***');
  }
  // HTTP 头被回显时，只保留 scheme，不保留凭据。
  output = output.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
  // 子进程/日志里偶尔会打印 `AIDASH_TOKEN=xxx`，整段抹掉。
  output = output.replace(/\b(AIDASH_TOKEN|AIDASH_LLM_API_KEY)\s*=\s*\S+/g, '$1=***');
  return output;
}

/** 按字符数截断（卡片 schema 限制是按字符串长度，不是字节数）。 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function readLogLevel(): LogLevel {
  const raw = (process.env.AIDASH_WATCH_LOG_LEVEL ?? process.env.AIDASH_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

export function createLogger(level: LogLevel = readLogLevel()): Logger {
  return new Logger(level);
}

export class Logger {
  private readonly threshold: number;

  constructor(level: LogLevel) {
    this.threshold = LEVEL_WEIGHT[level];
  }

  debug(message: string, meta?: LogMeta): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: LogMeta): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    this.write('error', message, meta);
  }

  /** 把已知异常记成一行；调用方不需要自己拼 code。 */
  failure(context: string, error: unknown): void {
    this.error(`${context}：${errorMessage(error)}`);
  }

  private write(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_WEIGHT[level] < this.threshold) return;
    const suffix = meta
      ? ` ${Object.entries(meta)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' ')}`
      : '';
    const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
    process.stderr.write(`${redact(line)}\n`);
  }
}
