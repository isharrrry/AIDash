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
  spawnCli,
  waitFor,
  waitForRegistry,
  writeConfig,
} from './helpers/cli.js';
import { getControlStatus } from '../src/control-client.js';

/**
 * 精确通道 + 初始化任务 + 持续轮询。
 * 全部使用临时 dataDir、假 MCP 和假 harness，不访问 8787。
 */

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeContext() {
  const dir = makeTempDir('aidash-setup-test-');
  tempDirs.push(dir);
  const dataDir = path.join(dir, 'data');
  const home = path.join(dir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return {
    dir,
    dataDir,
    home,
    marker: path.join(dir, 'tasks.log'),
    logFile: path.join(dir, 'runner.log'),
    opts() {
      return { cwd: dir, dataDir, home };
    },
  };
}

function appendTaskIdScript() {
  return "const fs=require('node:fs');fs.appendFileSync(process.argv[1],process.env.AIDASH_TASK_ID+'\\n');";
}

function writeRunnerConfig(ctx, fake, { poll = 3600 } = {}) {
  return writeConfig(ctx.dir, {
    ...baseConfig({ url: fake.url }),
    harness_id: 'it-setup',
    name: 'it-setup',
    poll_interval_seconds: poll,
    gap_seconds: 0,
    lease_seconds: 60,
    log_file: ctx.logFile,
    commands: [
      makeRule({
        name: 'setup-rule',
        tags: [],
        match: { match_all: true },
        argv: nodeScript(appendTaskIdScript(), ctx.marker),
        run: { input: 'none', timeout_seconds: 20 },
      }),
    ],
  });
}

function markerLines(ctx) {
  if (!fs.existsSync(ctx.marker)) return [];
  return fs
    .readFileSync(ctx.marker, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

test('第一次 once 创建通道与任务，第二次复用同一通道和同一幂等任务', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  const channel = 'it-host/setup/topic';
  try {
    const configPath = writeRunnerConfig(ctx, fake);
    const args = [
      'once',
      '--config',
      configPath,
      '--ensure-channel',
      channel,
      '--channel-title',
      'Setup Demo',
      '--create-task',
      'Initial task',
      '--task-description',
      'initial description',
      '--cwd',
      ctx.dir,
      '--data-dir',
      ctx.dataDir,
      '--log-file',
      ctx.logFile,
      '--json',
    ];

    const first = await runCli(args, ctx.opts());
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.data.executed, true);
    assert.equal(first.json.data.last_task.outcome, 'completed');

    const channelState = fake.channels.get(channel);
    assert.ok(channelState, '假 MCP 应创建通道');
    assert.equal(channelState.title, 'Setup Demo');
    assert.equal(channelState.workdir, path.resolve(ctx.dir));

    const created = [...fake.tasks.values()].filter((task) => task.title === 'Initial task');
    assert.equal(created.length, 1);
    assert.equal(created[0].status, 'done');
    assert.equal(created[0].description_md, 'initial description');
    assert.equal(fake.callsFor('channel.upsert').length, 1);
    assert.equal(fake.callsFor('task.create').length, 1);
    assert.equal(fake.callsFor('task.claim').length, 1);
    assert.deepEqual(markerLines(ctx), [created[0].id]);

    const second = await runCli(args, ctx.opts());
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.data.executed, false, '没有新的 pending 任务时不再跑 harness');
    assert.equal(fake.channels.size, 1, '第二次必须复用同一通道');
    assert.equal(fake.callsFor('channel.upsert').length, 2);
    assert.equal(fake.callsFor('task.create').length, 2, '第二次仍会做一次幂等 create');
    assert.equal(
      fake.callsFor('task.create')[0].args.idempotency_key,
      fake.callsFor('task.create')[1].args.idempotency_key,
      '同通道同标题必须使用同一幂等键',
    );
    assert.equal(fake.tasks.size, 1, '幂等 create 不能产生第二个任务');
    assert.equal(fake.callsFor('task.claim').length, 1);
    assert.deepEqual(markerLines(ctx), [created[0].id]);

    const log = fs.readFileSync(ctx.logFile, 'utf8');
    assert.match(log, /通道已创建/);
    assert.match(log, /通道已复用/);
    assert.match(log, /任务已创建并提交/);
    assert.match(log, /任务已存在（幂等），复用/);
  } finally {
    await fake.stop();
  }
});

test('--ensure-channel 不带 --create-task 时仍轮询该通道已有任务', async () => {
  const fake = await new FakeAidash({
    tasks: [makeTask({ id: 'task-existing', channel_key: 'it-host/setup/existing', title: 'Existing', tags: [] })],
  }).start();
  const ctx = makeContext();
  try {
    const configPath = writeRunnerConfig(ctx, fake);
    const result = await runCli(
      [
        'once',
        '--config',
        configPath,
        '--ensure-channel',
        'it-host/setup/existing',
        '--data-dir',
        ctx.dataDir,
        '--json',
      ],
      ctx.opts(),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.data.executed, true);
    assert.equal(result.json.data.last_task.outcome, 'completed');
    assert.equal(fake.callsFor('task.create').length, 0);
    assert.equal(fake.callsFor('task.claim').length, 1);
    assert.equal(fake.channels.get('it-host/setup/existing').workdir, path.resolve(ctx.dir));
    assert.deepEqual(markerLines(ctx), ['task-existing']);
  } finally {
    await fake.stop();
  }
});

test('start 创建任务并完成，之后继续休眠轮询新任务', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  const channel = 'it-host/setup/poll';
  let child = null;
  try {
    const configPath = writeRunnerConfig(ctx, fake, { poll: 1 });
    child = spawnCli(
      [
        'start',
        '--config',
        configPath,
        '--ensure-channel',
        channel,
        '--create-task',
        'First polling task',
        '--data-dir',
        ctx.dataDir,
        '--json',
      ],
      ctx.opts(),
    );
    const { entry } = await waitForRegistry(ctx.dataDir, 'it-setup');

    const first = await waitFor(
      () => [...fake.tasks.values()].find((task) => task.title === 'First polling task' && task.status === 'done'),
      { label: '初始化任务完成' },
    );
    assert.equal(child.exit, null, '任务完成后 start 应仍在运行/休眠');
    assert.equal(fake.callsFor('channel.upsert').length, 1, 'start 每次进程只 upsert 一次');
    assert.equal(fake.callsFor('task.create').length, 1, 'start 每次进程只做一次幂等 create');
    const status = await getControlStatus(entry, { timeoutMs: 1_000 });
    assert.equal(status.registered, true);

    const second = makeTask({
      id: 'task-poll-second',
      channel_key: channel,
      title: 'Second polling task',
      tags: [],
      priority: 'P2',
    });
    fake.addTask(second);

    // 不调用 pull：依靠 start 自己的 1 秒休眠轮询发现新任务，验证“完成后继续轮询”。
    await waitFor(() => fake.task(second.id).status === 'done', {
      timeoutMs: 10_000,
      label: '新任务被后续轮询认领并完成',
    });

    assert.equal(fake.callsFor('task.claim').length, 2);
    assert.deepEqual(markerLines(ctx), [first.id, second.id]);

    const stop = await runCli(['stop', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(stop.code, 0, stop.stderr);
    const exit = await child.waitForExit(15_000);
    assert.equal(exit.code, 0);
  } finally {
    child?.dispose();
    await fake.stop();
  }
});

test('空队列不启动 harness：once 与 start 都不执行命令', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  let child = null;
  try {
    // 已完成任务不能算未结束任务，也不能触发 harness。
    fake.addTask(makeTask({ id: 'task-already-done', status: 'done', tags: [] }));
    const configPath = writeRunnerConfig(ctx, fake);

    const once = await runCli(
      ['once', '--config', configPath, '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(once.code, 0, once.stderr);
    assert.equal(once.json.data.executed, false);
    assert.equal(fake.callsFor('task.claim').length, 0);
    assert.equal(fs.existsSync(ctx.marker), false, 'once 在空队列不能启动 harness');

    child = spawnCli(
      ['start', '--config', configPath, '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    const { entry } = await waitForRegistry(ctx.dataDir, 'it-setup');
    await waitFor(
      async () => {
        const status = await getControlStatus(entry, { timeoutMs: 1_000 });
        return status.last_poll_at ? status : null;
      },
      { label: 'start 完成首次空轮询' },
    );
    assert.equal(fs.existsSync(ctx.marker), false, 'start 在空队列不能启动 harness');
    assert.equal(fake.callsFor('task.claim').length, 0);

    const stop = await runCli(['stop', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(stop.code, 0, stop.stderr);
    await child.waitForExit(15_000);
  } finally {
    child?.dispose();
    await fake.stop();
  }
});

test('--create-task 缺少 --ensure-channel 时在启动前报配置错误', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  try {
    const configPath = writeRunnerConfig(ctx, fake);
    const result = await runCli(
      ['once', '--config', configPath, '--create-task', 'orphan', '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(result.code, 2);
    assert.equal(result.json.ok, false);
    assert.match(result.json.error.message, /--ensure-channel/);
    assert.equal(fake.callsFor('harness.register').length, 0);
  } finally {
    await fake.stop();
  }
});
