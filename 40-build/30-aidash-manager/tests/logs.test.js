import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readServiceLog, summarizeLog, mergeSummaries } from '../src/logs.js';

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-log-'));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('同时识别 AIDash JSON 日志与 runner 文本日志', () => {
  const dir = tempDir();
  const file = path.join(dir, 'service.log');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', level: 'info', msg: 'listening' }),
      JSON.stringify({ ts: '2026-01-01T00:00:01Z', level: 'warn', msg: 'db_missing', db_path: 'x' }),
      JSON.stringify({ ts: '2026-01-01T00:00:02Z', level: 'error', msg: 'listen_failed', code: 'EADDRINUSE' }),
      '[2026-01-01T00:00:03Z] INFO  正常输出',
      '[2026-01-01T00:00:04Z] ERROR 命令失败：ECONNREFUSED',
      '    at somewhere (file.js:1:1)',
    ].join('\n'),
  );
  const summary = summarizeLog(file);
  assert.equal(summary.exists, true);
  assert.equal(summary.error_count, 2);
  assert.equal(summary.warn_count, 1);
  assert.ok(summary.groups.some((group) => group.signature.includes('listen_failed')));
  assert.ok(summary.items.every((item) => item.text.length > 0));
});

test('空日志与不存在文件不报错', () => {
  const dir = tempDir();
  const empty = path.join(dir, 'empty.log');
  fs.writeFileSync(empty, '');
  const summary = summarizeLog(empty);
  assert.equal(summary.exists, true);
  assert.equal(summary.error_count, 0);
  assert.equal(summarizeLog(path.join(dir, 'none.log')).exists, false);
});

test('尾读只取最后 N 行', () => {
  const dir = tempDir();
  const file = path.join(dir, 'many.log');
  fs.writeFileSync(file, Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n'));
  const result = readServiceLog(file, 5);
  assert.deepEqual(result.lines, ['line-15', 'line-16', 'line-17', 'line-18', 'line-19']);
  assert.equal(result.truncated, true);
});

test('合并多文件摘要', () => {
  const dir = tempDir();
  const a = path.join(dir, 'a.log');
  const b = path.join(dir, 'b.log');
  fs.writeFileSync(a, 'ERROR a failed\n');
  fs.writeFileSync(b, 'WARN  b slow\nERROR a failed\n');
  const merged = mergeSummaries([summarizeLog(a), summarizeLog(b)]);
  assert.equal(merged.error_count, 2);
  assert.equal(merged.warn_count, 1);
});
