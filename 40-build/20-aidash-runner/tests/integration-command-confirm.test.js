import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAidash, makeTask } from './helpers/fake-mcp.js';
import {
  makeTempDir,
  runCli,
} from './helpers/cli.js';
import { readRegistryEntry } from '../src/registry.js';

/**
 * `--command` 的执行前确认：
 * - 匹配到任务且没有 --yes 时只打印清单、退出 0，不注册/不认领/不执行；
 * - --yes 才继续；
 * - dry-run 不受这件事影响。
 */

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeContext() {
  const dir = makeTempDir('aidash-confirm-test-');
  tempDirs.push(dir);
  const dataDir = path.join(dir, 'data');
  const home = path.join(dir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return {
    dir,
    dataDir,
    home,
    opts() {
      return { cwd: dir, dataDir, home };
    },
  };
}

function baseArgs(fake) {
  return [
    '--command',
    'node -v',
    '--url',
    fake.url,
    '--harness-id',
    'it-command-confirm',
  ];
}

test('--command 有匹配任务时默认只列清单，--yes 才执行；dry-run 不受影响', async () => {
  const fake = await new FakeAidash({
    tasks: [
      makeTask({ id: 'task-confirm-a', tags: ['it'], title: '确认任务A', priority: 'P1' }),
      makeTask({ id: 'task-confirm-b', tags: ['it'], title: '确认任务B', priority: 'P2' }),
    ],
  }).start();
  const ctx = makeContext();
  try {
    // 人类可读输出也要能看到任务清单与 --yes 提示。
    const human = await runCli(
      ['start', ...baseArgs(fake), '--data-dir', ctx.dataDir],
      ctx.opts(),
    );
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /确认任务A/);
    assert.match(human.stdout, /确认任务B/);
    assert.match(human.stdout, /--yes/);
    assert.match(human.stdout, /没有认领、没有执行/);
    assert.equal(fake.callsFor('task.claim').length, 0);
    assert.equal(fake.callsFor('harness.register').length, 0);

    const once = await runCli(
      ['once', ...baseArgs(fake), '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(once.code, 0, once.stderr);
    assert.equal(once.json.data.requires_confirmation, true);
    assert.equal(once.json.data.matched, 2);
    assert.deepEqual(
      once.json.data.planned.map((item) => item.task_id),
      ['task-confirm-a', 'task-confirm-b'],
    );
    assert.equal(fake.callsFor('task.claim').length, 0);
    assert.equal(fake.callsFor('harness.register').length, 0);

    // 后台启动也必须在 fork 之前被拦住。
    const daemon = await runCli(
      ['start', '--daemon', ...baseArgs(fake), '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(daemon.code, 0, daemon.stderr);
    assert.equal(daemon.json.data.requires_confirmation, true);
    assert.equal(readRegistryEntry(ctx.dataDir, 'it-command-confirm'), null);

    // dry-run 是只读命令，不需要 --yes，但也不得认领。
    const dry = await runCli(
      ['dry-run', ...baseArgs(fake), '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.json.data.planned.length, 2);
    assert.equal(fake.callsFor('task.claim').length, 0);

    // 显式确认后才真正执行；once 只跑一个。
    const confirmed = await runCli(
      ['once', ...baseArgs(fake), '--yes', '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(confirmed.code, 0, confirmed.stderr);
    assert.equal(confirmed.json.data.executed, true);
    assert.equal(confirmed.json.data.last_task.outcome, 'completed');
    assert.equal(fake.callsFor('task.claim').length, 1);
    assert.equal(fake.task('task-confirm-a').status, 'done');
    assert.equal(fake.task('task-confirm-b').status, 'pending');
  } finally {
    await fake.stop();
  }
});

test('--command 没有匹配的 pending 任务时不需要 --yes', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  try {
    const result = await runCli(
      ['once', ...baseArgs(fake), '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.data.executed, false);
    // 没有任务时直接走正常 once 流程，会注册 harness 但不会认领。
    assert.equal(fake.callsFor('harness.register').length, 1);
    assert.equal(fake.callsFor('task.claim').length, 0);
  } finally {
    await fake.stop();
  }
});
