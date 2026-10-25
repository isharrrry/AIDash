import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildBlockReason,
  buildFailReason,
  buildIdempotencyKey,
  buildStatusCard,
  displayCommand,
  normalizePriority,
} from '../src/report.js';
import {
  buildChildEnv,
} from '../src/exec.js';
import {
  buildCompleteFailureReason,
  buildEvidenceFailureReason,
  canReport,
  classifyCommandOutcome,
  evidenceFailureAction,
  isLeaseLostError,
  shouldExitAfterConsecutiveErrors,
  shouldRelease,
} from '../src/failure-policy.js';
import {
  redact,
  registerSecret,
  resetSecrets,
  sanitizeForCard,
  stripAnsi,
  truncate,
} from '../src/redact.js';
import { EdgeBuffer } from '../src/ring-buffer.js';
import {
  readResultFile,
  substitutePlaceholders,
  taskMarkdown,
  taskPayload,
  taskStdin,
  writeTaskFiles,
} from '../src/task-file.js';
import { BusinessError } from '../src/errors.js';
import { makeTempDir } from './helpers/cli.js';

const tempDirs = [];
function tempDir() {
  const dir = makeTempDir('aidash-unit-test-');
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  resetSecrets();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------ failure policy ------------------------------ */

test('只有命令没启动才允许 release', () => {
  assert.equal(shouldRelease(false), true);
  assert.equal(shouldRelease(undefined), true);
  assert.equal(shouldRelease(true), false);
});

test('证据回报失败：成功 block，失败 fail，绝不 release', () => {
  assert.equal(evidenceFailureAction(true), 'block');
  assert.equal(evidenceFailureAction(false), 'fail');
  assert.match(buildEvidenceFailureReason(true, '网络错误'), /命令已执行但证据回报失败/);
  assert.match(buildEvidenceFailureReason(false, '网络错误'), /命令执行失败且证据回报失败/);
  assert.match(buildEvidenceFailureReason(true, '网络错误'), /未 release，避免重复执行/);
  assert.match(buildCompleteFailureReason('x'), /未 release/);
});

test('canReport 对 lease_lost/stop/auth 一律返回 false', () => {
  assert.equal(canReport(false, ''), false);
  assert.equal(canReport(true, ''), true);
  for (const reason of ['lease_lost', 'stop', 'auth']) {
    assert.equal(canReport(true, reason), false);
  }
});

test('租约丢失错误识别', () => {
  assert.equal(isLeaseLostError(new BusinessError('ALREADY_CLAIMED', 'x')), true);
  assert.equal(isLeaseLostError(new BusinessError('CONFLICT', 'x')), true);
  assert.equal(isLeaseLostError(new BusinessError('NOT_FOUND', 'x')), true);
  assert.equal(isLeaseLostError(new BusinessError('INTERNAL', 'x')), false);
  assert.equal(isLeaseLostError(new Error('x')), false);
});

test('命令结论：命令失败永远压过 harness 自报 success', () => {
  const ok = { started: true, exitCode: 0, timedOut: false, spawnError: null };
  assert.deepEqual(classifyCommandOutcome(ok, null), { commandSucceeded: true, result: 'success' });
  assert.deepEqual(classifyCommandOutcome(ok, { result: 'partial' }), {
    commandSucceeded: true,
    result: 'partial',
  });
  assert.deepEqual(classifyCommandOutcome({ ...ok, exitCode: 3 }, { result: 'success' }), {
    commandSucceeded: false,
    result: 'failed',
  });
  assert.deepEqual(classifyCommandOutcome({ ...ok, timedOut: true }, { result: 'success' }), {
    commandSucceeded: false,
    result: 'failed',
  });
  assert.deepEqual(classifyCommandOutcome({ ...ok, spawnError: 'ENOENT' }, null), {
    commandSucceeded: false,
    result: 'failed',
  });
  assert.deepEqual(classifyCommandOutcome({ ...ok, started: false }, null), {
    commandSucceeded: false,
    result: 'failed',
  });
});

test('连续错误阈值', () => {
  assert.equal(shouldExitAfterConsecutiveErrors(4), false);
  assert.equal(shouldExitAfterConsecutiveErrors(5), true);
  assert.equal(shouldExitAfterConsecutiveErrors(3, 3), true);
});

/* --------------------------------- redaction -------------------------------- */

test('脱敏：已登记令牌、Bearer、AIDASH_TOKEN 与通用敏感赋值', () => {
  resetSecrets();
  registerSecret('registered-secret-value-123');
  const text = [
    'token=registered-secret-value-123',
    'Authorization: Bearer abcdefghijklmnop',
    'AIDASH_TOKEN=fake-env-token-123456',
    'DB_PASSWORD=hunter2',
    'SIGNING_KEY=super-secret-key',
    'NORMAL_VALUE=visible',
  ].join('\n');
  const output = redact(text);
  assert.equal(output.includes('registered-secret-value-123'), false);
  assert.equal(output.includes('abcdefghijklmnop'), false);
  assert.equal(output.includes('fake-env-token-123456'), false);
  assert.equal(output.includes('hunter2'), false);
  assert.equal(output.includes('super-secret-key'), false);
  assert.match(output, /NORMAL_VALUE=visible/);
  assert.match(output, /Bearer \*\*\*/);
  resetSecrets();
});

test('脱敏：环境变量中的 AIDASH_TOKEN 原值被替换', () => {
  resetSecrets();
  const original = process.env.AIDASH_TOKEN;
  process.env.AIDASH_TOKEN = 'fake-env-secret-abcdef';
  try {
    const output = redact('回显：fake-env-secret-abcdef');
    assert.equal(output.includes('fake-env-secret-abcdef'), false);
    assert.match(output, /\*\*\*/);
  } finally {
    if (original === undefined) delete process.env.AIDASH_TOKEN;
    else process.env.AIDASH_TOKEN = original;
  }
});

test('ANSI 清理、截断与卡片正文', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripAnsi('\u001b]0;title\u0007x'), 'x');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
  const card = sanitizeForCard('\u001b[31mBearer abcdefghijklmnop\u001b[0m', 100);
  assert.equal(card.includes('\u001b'), false);
  assert.equal(card.includes('abcdefghijklmnop'), false);
});

/* -------------------------------- ring buffer ------------------------------- */

test('首尾 8KB 环：小输出完整、跨越边界不重复、超长有省略标记', () => {
  const buffer = new EdgeBuffer(4);
  buffer.append('abc');
  assert.equal(buffer.toString(), 'abc');
  assert.equal(buffer.truncated, false);

  buffer.append('def');
  assert.equal(buffer.total, 6);
  assert.equal(buffer.toString(), 'abcdef');

  const long = new EdgeBuffer(4);
  long.append('abcdefghij');
  assert.match(long.toString(), /输出过长，中间省略 2 字节/);
  assert.match(long.toString(), /^abcd/);
  assert.match(long.toString(), /ghij$/);
  assert.equal(long.truncated, true);
});

/* ---------------------------------- report ---------------------------------- */

test('幂等键由 claim_token 派生，同 claim 稳定、换 claim 变化', () => {
  const first = buildIdempotencyKey('task-1', 'claim-a');
  assert.equal(first, buildIdempotencyKey('task-1', 'claim-a'));
  assert.notEqual(first, buildIdempotencyKey('task-1', 'claim-b'));
  assert.match(first, /^runner-task-1-/);
  assert.ok(first.length <= 128);
  assert.equal(normalizePriority('P1'), 'P1');
  assert.equal(normalizePriority('P9'), 'P2');
});

test('状态卡包含任务、结果、命令与日志，且不含控制字段', () => {
  const task = {
    id: 'task-9',
    channel_key: 'chan-a',
    title: 'Demo',
    priority: 'P1',
    claim_token: 'should-not-appear',
  };
  const card = buildStatusCard({
    task,
    argv: ['node', '-v'],
    cwd: '/work',
    execResult: {
      exitCode: 0,
      signal: null,
      durationMs: 1234,
      timedOut: false,
      spawnError: null,
      output: 'hello',
      stderrTail: '',
      started: true,
    },
    resultFile: { summary: '完成', detail_md: '细节', result: 'success' },
    logFile: '/logs/x.log',
    idempotencyKey: 'runner-key',
    result: 'success',
  });
  assert.equal(card.type, 'status');
  assert.equal(card.task_id, 'task-9');
  assert.equal(card.channel_key, 'chan-a');
  assert.equal(card.priority, 'P1');
  assert.equal(card.result, 'success');
  assert.equal(card.summary, '完成');
  assert.equal(card.idempotency_key, 'runner-key');
  assert.match(card.detail_md, /node -v/);
  assert.match(card.detail_md, /退出码：0/);
  assert.match(card.detail_md, /\/logs\/x\.log/);
  assert.equal(card.detail_md.includes('should-not-appear'), false);
  assert.equal(card.body_md, undefined);
});

test('失败卡摘要只出现一次退出码', () => {
  const card = buildStatusCard({
    task: { id: 'task-fail', channel_key: 'chan', title: '失败任务', priority: 'P1' },
    argv: ['node', 'x.js'],
    cwd: '/work',
    execResult: {
      started: true,
      exitCode: 3,
      signal: null,
      durationMs: 1_200,
      timedOut: false,
      aborted: false,
      abortedReason: '',
      spawnError: null,
      output: '',
      stderrTail: 'boom\n',
    },
    resultFile: null,
    logFile: null,
    idempotencyKey: 'runner-key',
    result: 'failed',
  });
  assert.equal((card.summary.match(/退出码/g) ?? []).length, 1);
  assert.match(card.summary, /退出码 3/);
});

test('失败/阻塞理由包含命令、退出码与耗时', () => {
  const execResult = {
    started: true,
    exitCode: 3,
    signal: null,
    durationMs: 1500,
    timedOut: false,
    aborted: false,
    abortedReason: '',
    spawnError: null,
    stderrTail: 'boom\n',
    output: '',
  };
  const fail = buildFailReason({ argv: ['node', 'x.js'], execResult, extra: '额外' });
  assert.match(fail, /node x\.js/);
  assert.match(fail, /退出码 3/);
  assert.match(fail, /额外/);
  const block = buildBlockReason({ argv: ['node', 'x.js'], execResult, reason: '需要人工' });
  assert.match(block, /需要人工/);
  assert.equal(displayCommand(['a'.repeat(500)]).length <= 160, true);
});

/* --------------------------------- task file -------------------------------- */

test('任务临时文件只暴露 harness 字段，清理后目录消失', () => {
  const baseDir = tempDir();
  const task = {
    id: 'task-file-1',
    channel_key: 'chan',
    title: '标题',
    description_md: '正文',
    priority: 'P0',
    tags: ['a'],
    due_at: null,
    kind: 'task',
    status: 'claimed',
    assignee: null,
    claim_token: 'secret-token',
  };
  const files = writeTaskFiles(task, { baseDir });
  try {
    const payload = JSON.parse(fs.readFileSync(files.jsonPath, 'utf8'));
    assert.equal(payload.id, 'task-file-1');
    assert.equal(payload.description_md, '正文');
    assert.equal('claim_token' in payload, false);
    assert.match(fs.readFileSync(files.mdPath, 'utf8'), /# 标题/);
    assert.match(taskMarkdown(task), /## 描述/);
    assert.equal(taskPayload(task).claim_token, undefined);
    assert.match(substitutePlaceholders(['x', '{task_file}', '{task_md_file}'], files)[1], /task\.json$/);
  } finally {
    files.cleanup();
  }
  assert.equal(fs.existsSync(files.dir), false);
});

test('stdin 内容支持 task_json 与 task_md', () => {
  const task = { id: 't', title: 'T', description_md: 'D', tags: [] };
  assert.match(taskStdin(task, 'task_json'), /"id": "t"/);
  assert.match(taskStdin(task, 'task_md'), /# T/);
});

test('结果文件读取失败时回退，不把任务判失败', () => {
  const dir = tempDir();
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ summary: 's', detail_md: 'd', result: 'partial' }));
  assert.deepEqual(readResultFile(good), { summary: 's', detail_md: 'd', result: 'partial' });

  const badResult = path.join(dir, 'bad.json');
  fs.writeFileSync(badResult, JSON.stringify({ summary: 's', result: 'weird' }));
  assert.equal(readResultFile(badResult).result, null);

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{not json');
  assert.equal(readResultFile(broken), null);
  assert.equal(readResultFile(path.join(dir, 'missing.json')), null);
});

/* ---------------------------------- child env -------------------------------- */

test('子进程环境只放行白名单，敏感键双重过滤', () => {
  const baseEnv = {
    PATH: '/bin',
    HOME: '/home/me',
    AIDASH_TOKEN: 'secret-token',
    MY_SECRET: 'secret',
    DB_PASSWORD: 'secret',
    HTTPS_PROXY: 'http://proxy',
  };
  const env = buildChildEnv({
    passthrough: ['path', 'AIDASH_TOKEN', 'MY_SECRET', 'DB_PASSWORD', 'HTTPS_PROXY'],
    extraEnv: {
      AIDASH_RUNNER: '1',
      // CHANNEL_KEY 是任务元数据，不是凭据；不能被 *_KEY 后缀误杀。
      AIDASH_CHANNEL_KEY: 'chan-1',
      AIDASH_LLM_API_KEY: 'secret',
      GIT_KEY: 'secret',
      COUNT: 3,
      EMPTY: undefined,
    },
    baseEnv,
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HTTPS_PROXY, 'http://proxy');
  assert.equal(env.AIDASH_RUNNER, '1');
  assert.equal(env.AIDASH_CHANNEL_KEY, 'chan-1');
  assert.equal(env.COUNT, '3');
  assert.equal(env.AIDASH_TOKEN, undefined);
  assert.equal(env.MY_SECRET, undefined);
  assert.equal(env.DB_PASSWORD, undefined);
  assert.equal(env.AIDASH_LLM_API_KEY, undefined);
  assert.equal(env.GIT_KEY, undefined);
  assert.equal('EMPTY' in env, false);
});

test('空 argv 与已中止信号都不会真正 spawn', async () => {
  const { executeCommand } = await import('../src/exec.js');
  assert.equal((await executeCommand({ argv: [] })).started, false);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const aborted = await executeCommand({ argv: ['node', '-v'], signal: controller.signal });
  assert.equal(aborted.started, false);
  assert.equal(aborted.aborted, true);
});
