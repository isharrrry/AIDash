import fs from 'node:fs';
import { LOG_READ_CHUNK_BYTES, MAX_LOG_TAIL_LINES } from './constants.js';
import { readFileTail, tailLines, truncate } from './util.js';

/**
 * 日志读取与“异常简要”。
 *
 * 两类日志格式都要认：
 *   - AIDash 服务端：一行一个 JSON（{ts,level,msg,...}），error/warn 走 stderr；
 *   - runner：`[ISO] LEVEL message key=value` 的纯文本。
 * 两者在管理台里被合并到不同的文件，但摘要逻辑一致：先按级别取，
 * 再对非结构化行做保守的正则兜底。宁可漏报，也不要把正常业务文案全都算成异常。
 */

export function readServiceLog(filePath, lines = 200) {
  const limit = Math.max(1, Math.min(Number(lines) || 200, MAX_LOG_TAIL_LINES));
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, path: filePath, lines: [], truncated: false, size: 0 };
  }
  const { text, size } = readFileTail(filePath, LOG_READ_CHUNK_BYTES);
  const tail = tailLines(text, limit);
  return { exists: true, path: filePath, lines: tail.lines, truncated: tail.truncated, size };
}

const ERROR_TOKEN = /(?:^|[\s[\]])(ERROR|FATAL|CRITICAL|EXCEPTION|UNCAUGHT|UNHANDLED)(?:[\s[\]:]|$)/i;
const WARN_TOKEN = /(?:^|[\s[\]])(WARN|WARNING)(?:[\s[\]:]|$)/i;
const ERROR_CODE = /\b(ECONNREFUSED|EADDRINUSE|ENOENT|EACCES|ETIMEDOUT|EPIPE|SQLITE_[A-Z_]+)\b/;
const JS_ERROR = /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|URIError):/;
const PY_TRACEBACK = /^Traceback \(most recent call last\)/;
const EXIT_CODE = /\bexit(?:ed)?(?: with)? (?:code|status) [1-9]\b/i;
const COMMAND_FAILED = /\bcommand failed\b/i;

function severityOf(line) {
  if (ERROR_TOKEN.test(line) || ERROR_CODE.test(line) || JS_ERROR.test(line) || PY_TRACEBACK.test(line) || EXIT_CODE.test(line) || COMMAND_FAILED.test(line)) {
    return 'error';
  }
  if (WARN_TOKEN.test(line)) return 'warn';
  return null;
}

function parseJsonLine(line) {
  if (!line.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') return null;
    const level = String(parsed.level ?? '').toLowerCase();
    if (level !== 'error' && level !== 'warn' && level !== 'warning') return null;
    const msg = String(parsed.msg ?? parsed.message ?? '(无消息)');
    const extra = Object.entries(parsed)
      .filter(([key]) => !['ts', 'level', 'msg', 'message'].includes(key))
      .filter(([, value]) => value !== undefined && value !== null)
      .slice(0, 6)
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
      .join(' ');
    return {
      severity: level === 'error' ? 'error' : 'warn',
      text: extra ? `${msg} ${extra}` : msg,
      signature: msg,
    };
  } catch {
    return null;
  }
}

function signatureOf(text) {
  return truncate(
    String(text)
      .replace(/\[?\d{4}-\d{2}-\d{2}[T ][0-9:.,+\-Z]+\]?/g, '')
      .replace(/\b[0-9a-f]{8,}\b/gi, '#')
      .replace(/\b\d{2,}\b/g, '#')
      .replace(/\s+/g, ' ')
      .trim(),
    160,
  );
}

/**
 * 返回结构化摘要。items 保留最近的明细，groups 按出现次数排序；
 * 两者都带行号，页面可以直接跳到对应日志位置。
 */
export function summarizeLog(filePath, { maxLines = 2_000, maxItems = 200, maxGroups = 20 } = {}) {
  const result = {
    exists: false,
    path: filePath,
    scanned_lines: 0,
    error_count: 0,
    warn_count: 0,
    groups: [],
    items: [],
  };
  if (!filePath || !fs.existsSync(filePath)) return result;

  const { text } = readFileTail(filePath, LOG_READ_CHUNK_BYTES);
  const all = text.split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const startIndex = Math.max(0, all.length - maxLines);
  const slice = all.slice(startIndex);
  result.exists = true;
  result.scanned_lines = slice.length;

  const groups = new Map();
  for (let offset = 0; offset < slice.length; offset += 1) {
    const line = slice[offset];
    if (!line.trim()) continue;
    const parsed = parseJsonLine(line);
    const severity = parsed?.severity ?? severityOf(line);
    if (!severity) continue;
    const textValue = parsed?.text ?? line;
    const signature = signatureOf(parsed?.signature ?? line);
    if (severity === 'error') result.error_count += 1;
    else result.warn_count += 1;
    const lineNumber = startIndex + offset + 1;
    const item = {
      line: lineNumber,
      severity,
      text: truncate(textValue, 1_000),
      signature,
    };
    if (result.items.length < maxItems) result.items.push(item);
    let group = groups.get(signature);
    if (!group) {
      group = { signature, severity, count: 0, first_line: lineNumber, last_line: lineNumber, samples: [] };
      groups.set(signature, group);
    }
    group.count += 1;
    group.last_line = lineNumber;
    if (group.severity !== 'error') group.severity = severity;
    if (group.samples.length < 3) group.samples.push({ line: lineNumber, text: truncate(textValue, 500) });
  }

  result.groups = [...groups.values()]
    .sort((a, b) => (a.severity === 'error' ? -1 : 1) - (b.severity === 'error' ? -1 : 1) || b.count - a.count)
    .slice(0, maxGroups);
  result.error_count = result.error_count;
  return result;
}

export function mergeSummaries(summaries) {
  const existing = summaries.filter((item) => item && item.exists);
  if (existing.length === 0) {
    return {
      exists: false,
      files: summaries.map((item) => ({ path: item.path, exists: false })),
      error_count: 0,
      warn_count: 0,
      groups: [],
      items: [],
    };
  }
  const groups = new Map();
  const items = [];
  for (const summary of existing) {
    for (const group of summary.groups) {
      const previous = groups.get(group.signature);
      if (previous) {
        previous.count += group.count;
        previous.last_line = Math.max(previous.last_line, group.last_line);
        if (previous.severity !== 'error') previous.severity = group.severity;
      } else {
        groups.set(group.signature, { ...group, samples: [...group.samples] });
      }
    }
    for (const item of summary.items) {
      items.push({ ...item, file: summary.path });
    }
  }
  return {
    exists: true,
    files: summaries.map((item) => ({
      path: item.path,
      exists: item.exists,
      error_count: item.error_count,
      warn_count: item.warn_count,
    })),
    error_count: existing.reduce((sum, item) => sum + item.error_count, 0),
    warn_count: existing.reduce((sum, item) => sum + item.warn_count, 0),
    groups: [...groups.values()].sort(
      (a, b) => (a.severity === 'error' ? -1 : 1) - (b.severity === 'error' ? -1 : 1) || b.count - a.count,
    ),
    items: items.slice(-200),
  };
}
