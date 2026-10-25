import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAidash, makeTask } from './helpers/fake-mcp.js';
import {
  baseConfig,
  makeRule,
  makeTempDir,
  nodeScript,
  runCli,
  writeConfig,
} from './helpers/cli.js';

/**
 * 集成用例：两个任务连续以同一退出码 + 同一 stderr 首行在 2 秒内失败后，
 * 常驻实例必须 WARN 并自行退出，第三个任务不能被认领。
 * 命令是本地 node 脚本，不碰真实 AIDash、不碰真实数据目录。
 */

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeContext() {
  const dir = makeTempDir('aidash-breaker-test-');
  tempDirs.push(dir);
  const dataDir = path.join(dir, 'data');
  const home = path.join(dir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return {
    dir,
    dataDir,
    home,
    logFile: path.join(dir, 'logs', 'runner.log'),
    opts() {
      return { cwd: dir, dataDir, home };
    },
  };
}

function sameFastFailureScript() {
  return "process.stderr.write('same-fast-boom\\n');process.exit(7);";
}

test('连续 2 个同因快速失败后熔断退出，不认领第三个任务', async () => {
  const fake = await new FakeAidash({
    tasks: [
      makeTask({ id: 'task-fast-a', tags: ['it'], title: '快速失败A' }),
      makeTask({ id: 'task-fast-b', tags: ['it'], title: '快速失败B' }),
      makeTask({ id: 'task-fast-c', tags: ['it'], title: '不应执行C' }),
    ],
  }).start();
  const ctx = makeContext();
  try {
    const configPath = writeConfig(ctx.dir, {
      ...baseConfig({ url: fake.url }),
      harness_id: 'it-breaker',
      name: 'it-breaker',
      poll_interval_seconds: 3600,
      gap_seconds: 0,
      lease_seconds: 60,
      log_file: ctx.logFile,
      commands: [
        makeRule({
          name: 'fast-fail',
          tags: ['it'],
          argv: nodeScript(sameFastFailureScript()),
        }),
      ],
    });

    const result = await runCli(
      ['start', '--config', configPath, '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );

    assert.equal(result.code, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, 'CIRCUIT_BREAKER');
    assert.match(result.json.error.message, /连续 2 个任务/);
    assert.match(result.json.error.message, /退出码 7/);
    assert.match(result.json.error.message, /same-fast-boom/);
    assert.equal(result.json.error.details.consecutive_tasks, 2);
    assert.deepEqual(result.json.error.details.task_ids, ['task-fast-a', 'task-fast-b']);

    assert.equal(fake.callsFor('task.claim').length, 2, '第三个任务不应被认领');
    assert.equal(fake.task('task-fast-a').status, 'failed');
    assert.equal(fake.task('task-fast-b').status, 'failed');
    assert.equal(fake.task('task-fast-c').status, 'pending');
    assert.equal(fake.cards.length, 2);

    const log = fs.readFileSync(ctx.logFile, 'utf8');
    assert.match(log, /WARN\s+连续 2 个任务/);
    assert.match(log, /暂停认领并退出/);
    assert.match(log, /same-fast-boom/);
  } finally {
    await fake.stop();
  }
});
