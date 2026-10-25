import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.js';
import { ensureDirSync } from './util.js';

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 日志同时写 stderr 与文件（前台也一样）。
 *
 * 后台模式没有终端，文件是唯一现场；前台模式如果只写 stderr，用户关掉终端后
 * 复盘同样没有证据。两条路径共用同一个 Logger，避免“前台看得到、日志里没有”。
 *
 * 文件写入用同步 append：值守壳日志量不大，换来的好处是进程被强杀时不会丢最后
 * 几行——恰恰是这几行最值钱。写失败不能在日志里递归报错，只提示一次并继续。
 */
export class Logger {
  constructor({ filePath = null, level = 'info', stderr = true } = {}) {
    this.filePath = filePath;
    this.level = LEVEL_WEIGHT[level] ? level : 'info';
    this.stderr = stderr;
    this.fileErrorReported = false;
    if (filePath) {
      try {
        ensureDirSync(path.dirname(filePath), 0o700);
      } catch (error) {
        this.reportFileError(error);
      }
    }
  }

  debug(message, meta) {
    this.write('debug', message, meta);
  }

  info(message, meta) {
    this.write('info', message, meta);
  }

  warn(message, meta) {
    this.write('warn', message, meta);
  }

  error(message, meta) {
    this.write('error', message, meta);
  }

  failure(context, error) {
    const message = error instanceof Error ? error.message : String(error);
    this.error(`${context}：${message}`);
  }

  /** harness 的原始输出：不加 level 前缀，但同样脱敏后落盘。 */
  writeRaw(text) {
    if (!text) return;
    this.append(redact(text));
  }

  write(level, message, meta) {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const suffix = meta
      ? ` ${Object.entries(meta)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' ')}`
      : '';
    const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}${suffix}\n`;
    const safe = redact(line);
    if (this.stderr) {
      try {
        process.stderr.write(safe);
      } catch {
        // stderr 被关闭（例如父进程退出）时不能因此终止值守循环。
      }
    }
    this.append(safe);
  }

  append(text) {
    if (!this.filePath) return;
    try {
      fs.appendFileSync(this.filePath, text, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      this.reportFileError(error);
    }
  }

  reportFileError(error) {
    if (this.fileErrorReported) return;
    this.fileErrorReported = true;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      process.stderr.write(redact(`[aidash-runner] 日志文件写入失败：${reason}（后续不再重复提示）\n`));
    } catch {
      // 连 stderr 都写不了，只能放弃提示；不能递归调用日志。
    }
  }
}
