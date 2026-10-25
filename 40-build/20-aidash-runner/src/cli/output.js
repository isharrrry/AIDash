import { ControlError, RunnerError, errorMessage } from '../errors.js';

/**
 * CLI 输出统一出口。
 *
 * --json 时 stdout 只允许出现一个 JSON 信封：子进程输出、日志、警告全部走 stderr
 * 或日志文件。脚本才能 `aidash-runner list --json | jq` 而不用过滤杂音。
 */
export class CliOutput {
  constructor({ json = false } = {}) {
    this.json = json === true;
  }

  /** 成功数据：json 打印 {ok:true,data}；human 由调用方给可读文本。 */
  write(data, human = '') {
    if (this.json) {
      this.writeJson({ ok: true, data });
      return;
    }
    if (human) process.stdout.write(human.endsWith('\n') ? human : `${human}\n`);
  }

  /** 只有可读文本的场景（help、日志原文）。 */
  text(human) {
    process.stdout.write(human.endsWith('\n') ? human : `${human}\n`);
  }

  warn(message) {
    process.stderr.write(`[aidash-runner] ${message}\n`);
  }

  error(error) {
    const code = errorCode(error);
    const message = errorMessage(error);
    if (this.json) {
      this.writeJson({
        ok: false,
        error: {
          code,
          message,
          ...(error?.details ? { details: error.details } : {}),
        },
      });
      return;
    }
    process.stderr.write(`aidash-runner: ${message}\n`);
  }

  writeJson(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

export function errorCode(error) {
  if (error instanceof RunnerError) return error.code;
  if (error instanceof ControlError) {
    return typeof error.details?.code === 'string' ? error.details.code : 'CONTROL_ERROR';
  }
  if (error && typeof error.code === 'string') return error.code;
  return 'ERROR';
}

export function exitCodeFor(error) {
  if (error instanceof RunnerError) return error.exitCode;
  if (error instanceof ControlError) return error.status === 401 ? 2 : 1;
  return 1;
}

export function publicInstance(entry) {
  if (!entry) return null;
  return {
    instance_id: entry.instance_id,
    pid: entry.pid,
    mode: entry.mode,
    harness_id: entry.harness_id,
    config_path: entry.config_path ?? '',
    control_url: entry.control_url ?? '',
    log_file: entry.log_file ?? '',
    started_at: entry.started_at ?? '',
    version: entry.version ?? '',
    alive: entry.alive === true,
    stale_reason: entry.stale_reason ?? null,
  };
}

/** 简单等宽表；中文列宽不追求完美对齐，先保证字段不串行。 */
export function table(rows, headers) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length), 0),
  );
  const format = (row) =>
    row
      .map((cell, index) => String(cell ?? '').padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  return [format(headers), ...rows.map(format)].join('\n');
}
