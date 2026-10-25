import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  clearClaudeSession,
  findExistingSessionFlags,
  isClaudeLikeCommand,
  isClaudeResumeFailure,
  normalizeResumeEngine,
  prepareClaudeFallback,
  prepareClaudeInvocation,
  readClaudeSession,
  sessionFilePath,
} from '../src/claude-session.js';
import { makeTempDir } from './helpers/cli.js';

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = makeTempDir('aidash-claude-session-test-');
  tempDirs.push(dir);
  return dir;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('Claude 引擎与命令识别：只对 claude / claude-* 生效，shell 也支持', () => {
  assert.equal(normalizeResumeEngine(undefined), null);
  assert.equal(normalizeResumeEngine('CLAUDE'), 'claude');
  assert.throws(() => normalizeResumeEngine('other'), /只支持 claude/);

  assert.equal(isClaudeLikeCommand(['claude', '-p', 'x'], false), true);
  assert.equal(isClaudeLikeCommand(['npx', 'claude', '-p'], false), true);
  assert.equal(isClaudeLikeCommand(['node', '/tmp/claude-fake.mjs', 'marker'], false), true);
  assert.equal(isClaudeLikeCommand(['node', '/tmp/other.js'], false), false);
  assert.equal(isClaudeLikeCommand(['node', '-e', 'claude'], false), false);
  assert.equal(isClaudeLikeCommand(['echo', 'claude'], false), false);
  assert.equal(isClaudeLikeCommand(['npx', '-y', 'claude'], false), true);
  assert.equal(isClaudeLikeCommand(['claude -p "hi"'], true), true);
  assert.equal(isClaudeLikeCommand(['cd repo && claude -p "hi"'], true), true);
  assert.equal(isClaudeLikeCommand(['echo "claude"'], true), false);
  assert.equal(isClaudeLikeCommand(['myclaude -p "hi"'], true), false);
  assert.equal(isClaudeLikeCommand(['node scripts/other.js'], true), false);

  assert.equal(findExistingSessionFlags(['claude', '--resume', 'id'], false), '--resume');
  assert.equal(findExistingSessionFlags(['claude', '--session-id', 'id'], false), '--session-id');
  assert.equal(findExistingSessionFlags(['claude --continue'], true), '--continue');
  assert.equal(findExistingSessionFlags(['node', '/tmp/claude-fake.mjs'], false), null);
});

test('首次生成 session-id 并落盘，后续同通道 resume，其他通道独立', () => {
  const dataDir = tempDir();
  const channel = 'host/proj/topic';
  const argv = ['node', '/tmp/claude-fake.mjs', 'marker'];

  const first = prepareClaudeInvocation({
    engine: 'claude',
    argv,
    shell: false,
    channelKey: channel,
    dataDir,
  });
  assert.equal(first.mode, 'new');
  assert.match(first.sessionId, UUID_RE);
  assert.deepEqual(first.argv.slice(-2), ['--session-id', first.sessionId]);
  const state = readClaudeSession(dataDir, channel);
  assert.equal(state.session_id, first.sessionId);
  assert.equal(state.engine, 'claude');
  assert.equal(state.channel_key, channel);
  assert.equal(fs.existsSync(sessionFilePath(dataDir, channel)), true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(sessionFilePath(dataDir, channel)).mode & 0o777, 0o600);
  }
  const raw = fs.readFileSync(sessionFilePath(dataDir, channel), 'utf8');
  assert.equal(raw.includes('fake-token'), false);

  const second = prepareClaudeInvocation({
    engine: 'claude',
    argv,
    shell: false,
    channelKey: channel,
    dataDir,
  });
  assert.equal(second.mode, 'resume');
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(second.argv.slice(-2), ['--resume', first.sessionId]);

  const other = prepareClaudeInvocation({
    engine: 'claude',
    argv,
    shell: false,
    channelKey: 'host/proj/other',
    dataDir,
  });
  assert.equal(other.mode, 'new');
  assert.notEqual(other.sessionId, first.sessionId);

  const shellFirst = prepareClaudeInvocation({
    engine: 'claude',
    argv: ['claude -p "hi"'],
    shell: true,
    channelKey: 'host/proj/shell',
    dataDir,
  });
  assert.equal(shellFirst.mode, 'new');
  assert.match(shellFirst.argv[0], new RegExp(`^claude -p "hi" --session-id ${shellFirst.sessionId}$`));
  const shellSecond = prepareClaudeInvocation({
    engine: 'claude',
    argv: ['claude -p "hi"'],
    shell: true,
    channelKey: 'host/proj/shell',
    dataDir,
  });
  assert.equal(shellSecond.mode, 'resume');
  assert.match(shellSecond.argv[0], new RegExp(`^claude -p "hi" --resume ${shellFirst.sessionId}$`));
});

test('非 Claude、未开启、已有 session 参数时不加旗标；fallback 清旧并生成新 id', () => {
  const dataDir = tempDir();
  const channel = 'host/proj/topic';
  const plain = ['node', '/tmp/other.js'];
  const none = prepareClaudeInvocation({
    engine: 'claude',
    argv: plain,
    shell: false,
    channelKey: channel,
    dataDir,
  });
  assert.equal(none.mode, 'none');
  assert.deepEqual(none.argv, plain);

  const disabled = prepareClaudeInvocation({
    engine: null,
    argv: ['claude', '-p'],
    shell: false,
    channelKey: channel,
    dataDir,
  });
  assert.equal(disabled.mode, 'none');

  const conflict = prepareClaudeInvocation({
    engine: 'claude',
    argv: ['claude', '--resume', 'existing'],
    shell: false,
    channelKey: channel,
    dataDir,
  });
  assert.equal(conflict.mode, 'none');

  const first = prepareClaudeInvocation({
    engine: 'claude',
    argv: ['claude', '-p', 'x'],
    shell: false,
    channelKey: channel,
    dataDir,
  });
  const fallback = prepareClaudeFallback({
    argv: ['claude', '-p', 'x'],
    shell: false,
    channelKey: channel,
    dataDir,
  });
  assert.equal(fallback.mode, 'fallback');
  assert.notEqual(fallback.sessionId, first.sessionId);
  assert.deepEqual(fallback.argv.slice(-2), ['--session-id', fallback.sessionId]);
  assert.equal(readClaudeSession(dataDir, channel).session_id, fallback.sessionId);
  assert.equal(clearClaudeSession(dataDir, channel), true);
  assert.equal(readClaudeSession(dataDir, channel), null);
});

test('resume 失败检测基于实际 Claude 输出，且排除成功/超时/中止', () => {
  const base = { started: true, exitCode: 1, timedOut: false, aborted: false };
  assert.equal(
    isClaudeResumeFailure(base, 'No conversation found with session ID: 123'),
    true,
  );
  assert.equal(isClaudeResumeFailure(base, 'No conversation found to continue'), true);
  assert.equal(isClaudeResumeFailure(base, 'Session not found: xyz'), true);
  assert.equal(isClaudeResumeFailure({ ...base, exitCode: 0 }, 'No conversation found'), false);
  assert.equal(isClaudeResumeFailure({ ...base, timedOut: true }, 'No conversation found'), false);
  assert.equal(isClaudeResumeFailure({ ...base, aborted: true }, 'No conversation found'), false);
  assert.equal(isClaudeResumeFailure(base, 'some unrelated command failure'), false);
});
