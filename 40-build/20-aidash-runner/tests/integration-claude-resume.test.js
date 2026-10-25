import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAidash, makeTask } from './helpers/fake-mcp.js';
import {
  DEFAULT_FAKE_TOKEN,
  baseConfig,
  makeRule,
  makeTempDir,
  runCli,
  writeConfig,
} from './helpers/cli.js';

/**
 * 只用假 claude-*.mjs 验证：
 * - session id 跨两次 CLI 进程持久化；
 * - 首次 --session-id，第二次 --resume；
 * - resume 输出“会话不存在”时清除旧 id，并只回退一次不带 --resume 的执行。
 * 不启动真实 Claude、不读取真实 ~/.claude 会话、不使用真实令牌。
 */

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeContext() {
  const dir = makeTempDir('aidash-claude-resume-test-');
  tempDirs.push(dir);
  const dataDir = path.join(dir, 'data');
  const home = path.join(dir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return {
    dir,
    dataDir,
    home,
    marker: path.join(dir, 'claude-attempts.jsonl'),
    logFile: path.join(dir, 'runner.log'),
    opts() {
      return { cwd: dir, dataDir, home };
    },
  };
}

function writeFakeClaude(ctx, { failResume = false } = {}) {
  const scriptPath = path.join(ctx.dir, 'claude-fake.mjs');
  const body = [
    "import fs from 'node:fs';",
    'const marker = process.argv[2];',
    'const rest = process.argv.slice(3);',
    "const flag = (name) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : null; };",
    "const mode = rest.includes('--resume') ? 'resume' : rest.includes('--session-id') ? 'new' : 'none';",
    'const sessionId = flag(\'--resume\') ?? flag(\'--session-id\');',
    "fs.appendFileSync(marker, JSON.stringify({ mode, sessionId, taskId: process.env.AIDASH_TASK_ID, args: rest }) + '\\n');",
    'if (mode === \'resume\') {',
    failResume
      ? "  process.stderr.write('No conversation found with session ID: ' + sessionId + '\\n');"
      : '',
    failResume ? '  process.exit(1);' : '',
    '}',
    'process.exit(0);',
  ]
    .filter(Boolean)
    .join('\n');
  fs.writeFileSync(scriptPath, `${body}\n`, 'utf8');
  return scriptPath;
}

function writeResumeConfig(ctx, fake, fakeClaude) {
  return writeConfig(ctx.dir, {
    ...baseConfig({ url: fake.url }),
    harness_id: 'it-claude-resume',
    name: 'it-claude-resume',
    poll_interval_seconds: 3600,
    gap_seconds: 0,
    lease_seconds: 60,
    log_file: ctx.logFile,
    commands: [
      makeRule({
        name: 'claude-resume-rule',
        tags: [],
        match: { match_all: true },
        argv: [process.execPath, fakeClaude, ctx.marker],
        run: { input: 'none', timeout_seconds: 20 },
      }),
    ],
  });
}

function readAttempts(ctx) {
  if (!fs.existsSync(ctx.marker)) return [];
  return fs
    .readFileSync(ctx.marker, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readSessionFiles(dataDir) {
  const dir = path.join(dataDir, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => path.join(dir, name));
}

function runOnce(ctx, configPath) {
  return runCli(
    [
      'once',
      '--config',
      configPath,
      '--resume',
      'claude',
      '--data-dir',
      ctx.dataDir,
      '--log-file',
      ctx.logFile,
      '--json',
    ],
    ctx.opts(),
  );
}

test('session id 首次落盘，第二次独立进程用 --resume 接上', async () => {
  const channel = 'it-host/resume/topic';
  const fake = await new FakeAidash({
    tasks: [
      makeTask({ id: 'task-resume-a', channel_key: channel, title: 'Resume A', tags: [] }),
      makeTask({ id: 'task-resume-b', channel_key: channel, title: 'Resume B', tags: [] }),
    ],
  }).start();
  const ctx = makeContext();
  try {
    const fakeClaude = writeFakeClaude(ctx);
    const configPath = writeResumeConfig(ctx, fake, fakeClaude);

    const first = await runOnce(ctx, configPath);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.data.last_task.outcome, 'completed');

    const second = await runOnce(ctx, configPath);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.data.last_task.outcome, 'completed');

    const attempts = readAttempts(ctx);
    assert.deepEqual(attempts.map((item) => item.mode), ['new', 'resume']);
    assert.match(attempts[0].sessionId, UUID_RE);
    assert.equal(attempts[1].sessionId, attempts[0].sessionId);

    const sessionFiles = readSessionFiles(ctx.dataDir);
    assert.equal(sessionFiles.length, 1);
    const state = JSON.parse(fs.readFileSync(sessionFiles[0], 'utf8'));
    assert.equal(state.session_id, attempts[0].sessionId);
    assert.equal(state.channel_key, channel);
    assert.equal(fs.readFileSync(sessionFiles[0], 'utf8').includes(DEFAULT_FAKE_TOKEN), false);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(sessionFiles[0]).mode & 0o777, 0o600);
    }

    assert.equal(fake.task('task-resume-a').status, 'done');
    assert.equal(fake.task('task-resume-b').status, 'done');
  } finally {
    await fake.stop();
  }
});

test('resume 会话不存在：清除旧 id，只回退一次 --session-id 新会话', async () => {
  const channel = 'it-host/resume/fallback';
  const fake = await new FakeAidash({
    tasks: [
      makeTask({ id: 'task-fallback-a', channel_key: channel, title: 'Fallback A', tags: [] }),
      makeTask({ id: 'task-fallback-b', channel_key: channel, title: 'Fallback B', tags: [] }),
    ],
  }).start();
  const ctx = makeContext();
  try {
    const fakeClaude = writeFakeClaude(ctx, { failResume: true });
    const configPath = writeResumeConfig(ctx, fake, fakeClaude);

    const first = await runOnce(ctx, configPath);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.data.last_task.outcome, 'completed');

    const second = await runOnce(ctx, configPath);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.data.last_task.outcome, 'completed');
    assert.equal(fake.task('task-fallback-b').status, 'done');

    const attempts = readAttempts(ctx);
    assert.deepEqual(attempts.map((item) => item.mode), ['new', 'resume', 'new']);
    assert.equal(attempts[0].taskId, 'task-fallback-a');
    assert.equal(attempts[1].taskId, 'task-fallback-b');
    assert.equal(attempts[2].taskId, 'task-fallback-b');
    assert.equal(attempts[1].sessionId, attempts[0].sessionId);
    assert.notEqual(attempts[2].sessionId, attempts[1].sessionId);

    const sessionFiles = readSessionFiles(ctx.dataDir);
    assert.equal(sessionFiles.length, 1);
    const state = JSON.parse(fs.readFileSync(sessionFiles[0], 'utf8'));
    assert.equal(state.session_id, attempts[2].sessionId, '旧 id 必须被新 id 替换');
    assert.match(fs.readFileSync(ctx.logFile, 'utf8'), /回退一次不带 --resume/);
    assert.equal(attempts.length, 3, '失败后只允许回退一次，不能无限重试');
  } finally {
    await fake.stop();
  }
});
