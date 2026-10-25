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
  readJson,
  runCli,
  spawnCli,
  waitFor,
  waitForPidDead,
  waitForRegistry,
  writeConfig,
} from './helpers/cli.js';
import { getControlStatus } from '../src/control-client.js';
import { readRegistryEntry } from '../src/registry.js';
import { terminateProcessTree } from '../src/exec.js';
import { isPidAlive } from '../src/util.js';

/**
 * 真实子进程 + 真实 HTTP fake MCP 的端到端测试。
 * 每个用例使用独立临时目录与独立 fake 服务，所有实例注册表都落在临时目录，
 * 不读写用户真实的 ~/.aidash。
 */

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeContext(prefix = 'aidash-run-test-') {
  const dir = makeTempDir(prefix);
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
    opts(extra = {}) {
      return { dataDir, home, cwd: dir, ...extra };
    },
  };
}

function writeRunnerConfig(ctx, fake, { commands, overrides = {} } = {}) {
  const config = {
    ...baseConfig({ url: fake.url }),
    log_file: ctx.logFile,
    ...overrides,
    commands,
  };
  return writeConfig(ctx.dir, config);
}

function envProbeScript() {
  return [
    "const fs=require('node:fs');",
    "const t=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));",
    'fs.writeFileSync(process.argv[1],JSON.stringify({',
    'id:process.env.AIDASH_TASK_ID,',
    'title:process.env.AIDASH_TASK_TITLE,',
    'channel:process.env.AIDASH_CHANNEL_KEY,',
    'token:process.env.AIDASH_TOKEN??null,',
    'llmKey:process.env.AIDASH_LLM_API_KEY??null,',
    'path:Boolean(process.env.Path||process.env.PATH),',
    'fileTask:t',
    '}));',
    "console.log('Bearer fake-output-token-123456789');",
    "console.log('ACCESS_KEY=fake-access-key-value');",
    "console.log('\\u001b[31mRED-ANSI\\u001b[0m');",
  ].join('');
}

function slowScript() {
  return [
    "const fs=require('node:fs');",
    'fs.writeFileSync(process.argv[1],String(process.pid));',
    'setTimeout(()=>{},60000);',
  ].join('');
}

function failScript() {
  return "process.stderr.write('boom-failure\\n');process.exit(3);";
}

function resultScript() {
  return [
    "const fs=require('node:fs');",
    "fs.writeFileSync(process.argv[1],JSON.stringify({summary:'需要人工确认',detail_md:'harness 主动 block',result:'blocked'}));",
  ].join('');
}

async function stopDaemonPid(pid) {
  if (!Number.isInteger(pid) || !isPidAlive(pid)) return;
  await terminateProcessTree(pid, { force: true }).catch(() => undefined);
}

async function waitForStatus(entry, predicate, label) {
  return waitFor(async () => {
    const status = await getControlStatus(entry, { timeoutMs: 1_000 });
    return predicate(status) ? status : null;
  }, { timeoutMs: 20_000, label });
}

/* -------------------------------------------------------------------------- */

test('前台 start → list/status → stop，registry 随退出清理', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  let child = null;
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript('process.exit(0)') })],
    });
    child = spawnCli(['start', '--config', configPath, '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    const { entry } = await waitForRegistry(ctx.dataDir, 'it-runner');
    assert.equal(entry.mode, 'foreground');
    assert.equal(entry.pid, child.child.pid);
    await waitForStatus(entry, (status) => status.connected && status.registered, '实例连接并注册');

    const list = await runCli(['list', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(list.code, 0);
    assert.equal(list.json.data.instances.length, 1);
    assert.equal(list.json.data.instances[0].instance_id, 'it-runner');
    assert.equal(list.json.data.instances[0].alive, true);
    assert.equal(list.json.data.instances[0].mode, 'foreground');
    assert.equal(list.json.data.instances[0].pid, child.child.pid);

    const status = await runCli(['status', 'it-runner', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(status.code, 0);
    assert.equal(status.json.data.instance_id, 'it-runner');
    assert.equal(status.json.data.mode, 'foreground');
    assert.equal(status.json.data.config.poll_interval_seconds, 3600);
    assert.equal(status.json.data.connected, true);
    assert.equal(status.json.data.registered, true);

    const stop = await runCli(['stop', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(stop.code, 0);
    assert.equal(stop.json.data.stopped, true);
    assert.equal(stop.json.data.instances[0].stopped, true);

    const exit = await child.waitForExit(15_000);
    assert.equal(exit.code, 0);
    assert.equal(readRegistryEntry(ctx.dataDir, 'it-runner'), null);
  } finally {
    child?.dispose();
    await fake.stop();
  }
});

test('后台 start --daemon → list 显示 background → 优雅 stop', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  let daemonPid = null;
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript('process.exit(0)') })],
    });
    const started = await runCli(
      ['start', '--daemon', '--config', configPath, '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(started.code, 0, started.stderr);
    assert.equal(started.json.data.mode, 'background');
    assert.equal(started.json.data.instance_id, 'it-runner');
    daemonPid = started.json.data.pid;

    await waitForRegistry(ctx.dataDir, 'it-runner');
    const list = await runCli(['list', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(list.json.data.instances[0].mode, 'background');
    assert.equal(list.json.data.instances[0].alive, true);
    assert.equal(list.json.data.instances[0].pid, daemonPid);

    const stop = await runCli(['stop', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(stop.code, 0);
    assert.equal(stop.json.data.stopped, true);
    await waitForPidDead(daemonPid);
    assert.equal(readRegistryEntry(ctx.dataDir, 'it-runner'), null);
  } finally {
    await stopDaemonPid(daemonPid);
    await fake.stop();
  }
});

test('命令不存在：只释放一次并以配置错误退出，不循环重试', async () => {
  const ctx = makeContext('aidash-run-test-missing-cmd-');
  const task = makeTask({ id: 'tk_missing_cmd', title: '缺命令任务', tags: ['it'] });
  const fake = await new FakeAidash({ tasks: [task] }).start();
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [
        makeRule({
          name: 'missing-command',
          argv: ['aidash-definitely-missing-command-xyz'],
        }),
      ],
    });
    const result = await runCli(
      ['once', '--config', configPath, '--data-dir', ctx.dataDir, '--json', '--log-file', ctx.logFile],
      ctx.opts(),
    );
    assert.equal(result.code, 2, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout + result.stderr, /无法启动命令|命令无法启动/);
    // 关键：只 claim / release 一次，不能每 2 秒重认领同一任务。
    assert.equal(fake.callsFor('task.claim').length, 1);
    assert.equal(fake.callsFor('task.release').length, 1);
  } finally {
    await fake.stop();
  }
});

test('once：执行任务、过滤令牌环境、发证据卡并 complete', async () => {
  const task = makeTask({ tags: ['it'], title: 'Once 任务', channel_key: 'chan-it' });
  const fake = await new FakeAidash({ tasks: [task] }).start();
  const ctx = makeContext();
  const marker = path.join(ctx.dir, 'marker.json');
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [
        makeRule({
          argv: nodeScript(envProbeScript(), marker, '{task_file}'),
          run: { input: 'file' },
        }),
      ],
    });

    const result = await runCli(
      ['once', '--config', configPath, '--data-dir', ctx.dataDir, '--json', '--log-file', ctx.logFile],
      ctx.opts(),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.data.executed, true);
    assert.equal(result.json.data.last_task.outcome, 'completed');
    assert.equal(result.json.data.stats.completed, 1);

    const payload = readJson(marker);
    assert.equal(payload.id, task.id);
    assert.equal(payload.title, 'Once 任务');
    assert.equal(payload.channel, 'chan-it');
    assert.equal(payload.token, null, 'AIDASH_TOKEN 不能传给 harness');
    assert.equal(payload.llmKey, null);
    assert.equal(payload.path, true);
    assert.equal(payload.fileTask.id, task.id);
    assert.match(payload.fileTask.description_md, /description/);
    assert.equal('claim_token' in payload.fileTask, false);

    const stored = fake.task(task.id);
    assert.equal(stored.status, 'done');
    assert.equal(stored.claim_token, null);

    const events = fake.callsFor('task.update').map((call) => call.args.event);
    assert.deepEqual(events, ['start', 'complete']);
    const complete = fake.callsFor('task.update').find((call) => call.args.event === 'complete');
    assert.equal(complete.args.evidence_card_ids.length, 1);
    assert.equal(fake.callsFor('task.release').length, 0);
    assert.equal(fake.cards.length, 1);

    const card = fake.cards[0];
    assert.equal(card.type, 'status');
    assert.equal(card.task_id, task.id);
    assert.equal(card.result, 'success');
    assert.match(card.summary, /命令执行成功/);
    assert.match(card.idempotency_key, new RegExp(`^runner-${task.id}-`));
    assert.equal(card.detail_md.includes('\u001b'), false, '卡片正文必须清除 ANSI');
    assert.match(card.detail_md, /RED-ANSI/);
    assert.equal(card.detail_md.includes('fake-output-token-123456789'), false);
    assert.equal(card.detail_md.includes('fake-access-key-value'), false);
    assert.match(card.detail_md, /Bearer \*\*\*/);
    assert.match(card.detail_md, /ACCESS_KEY=\*\*\*/);

    const log = fs.readFileSync(ctx.logFile, 'utf8');
    assert.match(log, /任务 .*开始执行/);
    assert.match(log, /已完成/);
    assert.match(log, /Bearer \*\*\*/);
    assert.match(log, /ACCESS_KEY=\*\*\*/);
    assert.equal(log.includes('fake-output-token-123456789'), false);
    assert.equal(log.includes('fake-access-key-value'), false);
  } finally {
    await fake.stop();
  }
});

test('dry-run 不认领；once 跳过暂缓/他人指派/无规则，并按优先级执行', async () => {
  const deferred = makeTask({
    id: 'task-deferred',
    tags: ['it'],
    defer_reason: '等评审',
    deferred_until: '2099-01-01T00:00:00.000Z',
  });
  const assigned = makeTask({ id: 'task-assigned', tags: ['it'], assignee: 'other' });
  const unmatched = makeTask({ id: 'task-unmatched', tags: ['other'] });
  const p1 = makeTask({ id: 'task-p1', tags: ['it'], priority: 'P1' });
  const p0 = makeTask({ id: 'task-p0', tags: ['it'], priority: 'P0' });
  const fake = await new FakeAidash({ tasks: [deferred, assigned, unmatched, p1, p0] }).start();
  const ctx = makeContext();
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript('process.exit(0)') })],
    });

    const dry = await runCli(['dry-run', '--config', configPath, '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.json.data.pending, 5);
    assert.deepEqual(dry.json.data.planned.map((item) => item.task_id), ['task-p0', 'task-p1']);
    const skipped = Object.fromEntries(dry.json.data.skipped.map((item) => [item.task_id, item.reasons]));
    assert.match(skipped['task-deferred'].join('；'), /任务已暂缓/);
    assert.match(skipped['task-assigned'].join('；'), /assignee=other/);
    assert.match(skipped['task-unmatched'].join('；'), /没有匹配的 command 规则/);
    assert.equal(fake.callsFor('task.claim').length, 0);
    assert.equal(fake.callsFor('harness.register').length, 0);

    const once = await runCli(['once', '--config', configPath, '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(once.code, 0, once.stderr);
    assert.equal(once.json.data.last_task.outcome, 'completed');
    assert.equal(fake.task('task-p0').status, 'done');
    assert.equal(fake.task('task-p1').status, 'pending');
    assert.equal(fake.task('task-deferred').status, 'pending');
    assert.equal(fake.task('task-assigned').status, 'pending');
    assert.equal(fake.task('task-unmatched').status, 'pending');
    assert.equal(fake.callsFor('task.claim').length, 1);
    assert.equal(fake.callsFor('task.release').length, 0);
  } finally {
    await fake.stop();
  }
});

test('pull 立即唤醒长轮询并执行任务；logs 可读；stop 优雅退出', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  let child = null;
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript('process.exit(0)') })],
    });
    child = spawnCli(['start', '--config', configPath, '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    const { entry } = await waitForRegistry(ctx.dataDir, 'it-runner');
    await waitForStatus(entry, (status) => Boolean(status.last_poll_at), '首轮轮询完成');

    const task = makeTask({ id: 'task-pull', tags: ['it'] });
    fake.addTask(task);

    const pull = await runCli(['pull', '--data-dir', ctx.dataDir, '--json', '--wait'], ctx.opts());
    assert.equal(pull.code, 0, pull.stderr);
    assert.equal(pull.json.data.triggered, true);
    assert.equal(pull.json.data.waited, true);
    await waitFor(() => fake.task(task.id).status === 'done', { label: 'pull 后任务完成' });

    const logs = await runCli(['logs', '--data-dir', ctx.dataDir, '--json', '--lines', '80'], ctx.opts());
    assert.equal(logs.code, 0, logs.stderr);
    assert.equal(logs.json.data.instance_id, 'it-runner');
    assert.ok(logs.json.data.lines.length > 3);
    assert.match(logs.json.data.lines.join('\n'), /已连接 AIDash|已注册 harness/);

    const stop = await runCli(['stop', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(stop.code, 0);
    const exit = await child.waitForExit(15_000);
    assert.equal(exit.code, 0);
  } finally {
    child?.dispose();
    await fake.stop();
  }
});

test('config get/set/persist/reload：白名单、类型转换与需重启键', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  let child = null;
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript('process.exit(0)') })],
    });
    child = spawnCli(['start', '--config', configPath, '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    const { entry } = await waitForRegistry(ctx.dataDir, 'it-runner');

    const get1 = await runCli(['config', 'get', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(get1.code, 0, get1.stderr);
    assert.equal(get1.json.data.config.poll_interval_seconds, 3600);

    const setPoll = await runCli(
      ['config', 'set', 'poll_interval_seconds', '45', '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(setPoll.code, 0, setPoll.stderr);
    assert.equal(setPoll.json.data.config.poll_interval_seconds, 45);
    assert.equal(setPoll.json.data.persisted, false);

    const setChannels = await runCli(
      ['config', 'set', 'channels', 'chan-a, chan-b', '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(setChannels.code, 0, setChannels.stderr);
    assert.deepEqual(setChannels.json.data.config.channels, ['chan-a', 'chan-b']);

    const status = await getControlStatus(entry);
    assert.equal(status.config.poll_interval_seconds, 45);
    assert.deepEqual(status.config.channels, ['chan-a', 'chan-b']);

    const restartKey = await runCli(
      ['config', 'set', 'harness_id', 'other-id', '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.notEqual(restartKey.code, 0);
    assert.match(restartKey.json.error.message, /不支持运行时修改|需要重启/);

    const persisted = await runCli(
      ['config', 'set', 'poll_interval_seconds', '50', '--persist', '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(persisted.code, 0, persisted.stderr);
    const raw = readJson(configPath);
    assert.equal(raw.poll_interval_seconds, 50);
    assert.equal(raw.commands.length, 1);

    raw.poll_interval_seconds = 55;
    raw.gap_seconds = 0.5;
    raw.name = 'renamed';
    raw.command_timeout_seconds = 45;
    raw.commands[0].name = 'changed-in-file';
    fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const reload = await runCli(['config', 'reload', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(reload.code, 0, reload.stderr);
    assert.ok(reload.json.data.applied.includes('poll_interval_seconds'));
    assert.ok(reload.json.data.applied.includes('gap_seconds'));
    assert.ok(reload.json.data.restart_required.includes('name'));
    // 不热改的键必须逐个报出来，不能默默忽略。
    assert.ok(reload.json.data.restart_required.includes('commands'));
    assert.ok(reload.json.data.restart_required.includes('command_timeout_seconds'));
    assert.equal(reload.json.data.config.poll_interval_seconds, 55);
    assert.equal(reload.json.data.config.command_timeout_seconds, 30);
    assert.equal(reload.json.data.config.commands[0].name, 'it-rule');

    const stop = await runCli(['stop', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(stop.code, 0);
    await child.waitForExit(15_000);
  } finally {
    child?.dispose();
    await fake.stop();
  }
});

test('kill 强杀后台实例与 harness 进程树，且不 release', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  const marker = path.join(ctx.dir, 'slow.pid');
  let daemonPid = null;
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript(slowScript(), marker) })],
    });
    const started = await runCli(
      ['start', '--daemon', '--config', configPath, '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(started.code, 0, started.stderr);
    daemonPid = started.json.data.pid;
    const { entry } = await waitForRegistry(ctx.dataDir, 'it-runner');

    const task = makeTask({ id: 'task-slow', tags: ['it'] });
    fake.addTask(task);
    const pull = await runCli(['pull', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(pull.code, 0, pull.stderr);

    const running = await waitForStatus(
      entry,
      (status) => Number.isInteger(status.current_task?.pid),
      'harness 子进程启动',
    );
    const harnessPid = running.current_task.pid;
    await waitFor(() => fs.existsSync(marker), { label: 'harness 写入 pid 文件' });
    assert.equal(Number(fs.readFileSync(marker, 'utf8')), harnessPid);

    const killed = await runCli(['kill', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(killed.code, 0, killed.stderr);
    assert.equal(killed.json.data.killed, true);
    assert.equal(killed.json.data.instances[0].stopped, true);
    assert.equal(killed.json.data.instances[0].child_pid, harnessPid);

    await waitForPidDead(harnessPid);
    await waitForPidDead(daemonPid);
    assert.equal(isPidAlive(daemonPid), false);
    assert.equal(fake.callsFor('task.release').length, 0);
    assert.equal(fake.cards.length, 0, `不应在 kill 后发卡：${JSON.stringify(fake.cards)}`);
    assert.equal(fake.task(task.id).status, 'in_progress');
  } finally {
    await stopDaemonPid(daemonPid);
    await fake.stop();
  }
});

test('服务端丢失 harness 注册后自动重连并重新注册', async () => {
  const fake = await new FakeAidash().start();
  const ctx = makeContext();
  let child = null;
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript('process.exit(0)') })],
    });
    child = spawnCli(['start', '--config', configPath, '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    const { entry } = await waitForRegistry(ctx.dataDir, 'it-runner');
    await waitForStatus(entry, (status) => status.connected && status.registered, '首次注册完成');
    const registrationsBefore = fake.callsFor('harness.register').length;

    // 模拟服务端重启后内存注册表丢失：HTTP 还在，但 harness 已不存在。
    // 下一次 claim 会得到 HARNESS_NOT_REGISTERED；runner 必须重连并重新注册，
    // 而不是一直退避重试同一个失效状态。
    fake.harnesses.clear();
    const task = makeTask({ id: 'task-after-restart', tags: ['it'] });
    fake.addTask(task);
    const pull = await runCli(['pull', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(pull.code, 0, pull.stderr);

    await waitFor(
      () => fake.callsFor('harness.register').length > registrationsBefore,
      { label: 'runner 重新注册 harness' },
    );
    await waitFor(() => fake.task(task.id).status === 'done', { label: '重注册后任务完成' });
    const status = await getControlStatus(entry, { timeoutMs: 2_000 });
    assert.equal(status.registered, true);
    assert.equal(fake.cards.length, 1);

    const stop = await runCli(['stop', '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(stop.code, 0);
    await child.waitForExit(15_000);
  } finally {
    child?.dispose();
    await fake.stop();
  }
});

test('401 立即停止（只发一次 initialize），registry 被清理', async () => {
  const fake = await new FakeAidash().start();
  fake.unauthorized = true;
  const ctx = makeContext();
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript('process.exit(0)') })],
    });
    const result = await runCli(
      ['start', '--config', configPath, '--data-dir', ctx.dataDir, '--json'],
      ctx.opts(),
    );
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.json.error.message, /401/);
    assert.equal(result.json.error.code, 'UNAUTHORIZED');
    assert.equal(fake.requests, 1, '401 后不得重试');
    assert.equal(readRegistryEntry(ctx.dataDir, 'it-runner'), null);
  } finally {
    await fake.stop();
  }
});

test('complete 回报失败 → block，不 release', async () => {
  const fake = await new FakeAidash({ tasks: [makeTask({ id: 'task-complete-fail', tags: ['it'] })] }).start();
  fake.failOnEvents.add('complete');
  const ctx = makeContext();
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript('process.exit(0)') })],
    });
    const result = await runCli(['once', '--config', configPath, '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.data.last_task.outcome, 'report_failed');
    assert.equal(fake.task('task-complete-fail').status, 'blocked');
    assert.equal(fake.callsFor('task.release').length, 0);
    assert.equal(fake.cards.length, 1);
    const block = fake.callsFor('task.update').find((call) => call.args.event === 'block');
    assert.ok(block);
    assert.match(block.args.reason, /命令已执行但完成回报失败/);
    assert.match(block.args.reason, /未 release/);
  } finally {
    await fake.stop();
  }
});

test('证据卡发送失败 → 命令成功则 block，不 release', async () => {
  const fake = await new FakeAidash({ tasks: [makeTask({ id: 'task-card-fail', tags: ['it'] })] }).start();
  fake.failCards = true;
  const ctx = makeContext();
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript('process.exit(0)') })],
    });
    const result = await runCli(['once', '--config', configPath, '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.data.last_task.outcome, 'report_failed');
    assert.equal(fake.task('task-card-fail').status, 'blocked');
    assert.equal(fake.callsFor('task.release').length, 0);
    assert.equal(fake.cards.length, 0);
    const block = fake.callsFor('task.update').find((call) => call.args.event === 'block');
    assert.match(block.args.reason, /命令已执行但证据回报失败/);
    assert.match(block.args.reason, /未 release/);
  } finally {
    await fake.stop();
  }
});

test('命令失败 → failed 卡 + fail，且不 release；result_file=blocked 时 block', async () => {
  const failTask = makeTask({ id: 'task-command-fail', tags: ['it'] });
  const fake = await new FakeAidash({ tasks: [failTask] }).start();
  const ctx = makeContext();
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript(failScript()) })],
    });
    const failed = await runCli(['once', '--config', configPath, '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(failed.code, 0, failed.stderr);
    assert.equal(failed.json.data.last_task.outcome, 'failed');
    assert.equal(fake.task(failTask.id).status, 'failed');
    assert.equal(fake.callsFor('task.release').length, 0);
    assert.equal(fake.cards.length, 1);
    assert.equal(fake.cards[0].result, 'failed');
    assert.match(fake.cards[0].detail_md, /退出码：3/);
    const failCall = fake.callsFor('task.update').find((call) => call.args.event === 'fail');
    assert.match(failCall.args.reason, /退出码 3/);
  } finally {
    await fake.stop();
  }

  const blockTask = makeTask({ id: 'task-result-blocked', tags: ['it'] });
  const fake2 = await new FakeAidash({ tasks: [blockTask] }).start();
  const ctx2 = makeContext();
  const resultFile = path.join(ctx2.dir, 'result.json');
  try {
    const configPath = writeRunnerConfig(ctx2, fake2, {
      commands: [
        makeRule({
          argv: nodeScript(resultScript(), resultFile),
          run: { input: 'none', result_file: resultFile },
        }),
      ],
    });
    const blocked = await runCli(
      ['once', '--config', configPath, '--data-dir', ctx2.dataDir, '--json'],
      ctx2.opts(),
    );
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(blocked.json.data.last_task.outcome, 'blocked');
    assert.equal(fake2.task(blockTask.id).status, 'blocked');
    assert.equal(fake2.cards[0].result, 'blocked');
    assert.equal(fake2.cards[0].summary, '需要人工确认');
    assert.equal(fake2.callsFor('task.release').length, 0);
  } finally {
    await fake2.stop();
  }
});

test('租约丢失：终止命令、不 release、不发卡', async () => {
  const task = makeTask({ id: 'task-lease-lost', tags: ['it'] });
  const fake = await new FakeAidash({ tasks: [task] }).start();
  fake.leaseLostOnRenew = true;
  const ctx = makeContext();
  try {
    const configPath = writeRunnerConfig(ctx, fake, {
      overrides: { lease_seconds: 1 },
      commands: [makeRule({ argv: nodeScript(slowScript(), path.join(ctx.dir, 'lease.pid')) })],
    });
    const result = await runCli(
      ['once', '--config', configPath, '--data-dir', ctx.dataDir, '--json'],
      ctx.opts({ timeoutMs: 30_000 }),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.data.last_task.outcome, 'lease_lost');
    assert.equal(fake.callsFor('task.release').length, 0);
    assert.equal(fake.cards.length, 0);
    assert.equal(fake.task(task.id).status, 'in_progress');
    assert.ok(fake.callsFor('task.claim').length >= 1);
  } finally {
    await fake.stop();
  }
});

test('claim 视图缺少 description 时用 task.list(include_description) 兜底', async () => {
  const task = makeTask({ id: 'task-desc', tags: ['it'], description_md: 'FALLBACK-DESCRIPTION' });
  const fake = await new FakeAidash({ tasks: [task] }).start();
  fake.claimViewOmitsDescription = true;
  const ctx = makeContext();
  const marker = path.join(ctx.dir, 'desc.json');
  try {
    const script = [
      "const fs=require('node:fs');",
      "const t=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));",
      'fs.writeFileSync(process.argv[1],JSON.stringify({description:t.description_md}));',
    ].join('');
    const configPath = writeRunnerConfig(ctx, fake, {
      commands: [makeRule({ argv: nodeScript(script, marker, '{task_file}') })],
    });
    const result = await runCli(['once', '--config', configPath, '--data-dir', ctx.dataDir, '--json'], ctx.opts());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readJson(marker).description, 'FALLBACK-DESCRIPTION');
    const detailLookups = fake
      .callsFor('task.list')
      .filter((call) => call.args.status === 'claimed' && call.args.include_description === true);
    assert.equal(detailLookups.length >= 1, true);
    assert.equal(fake.callsFor('card.post').length, 1);
  } finally {
    await fake.stop();
  }
});
