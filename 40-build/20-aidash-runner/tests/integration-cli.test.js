import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  baseConfig,
  makeRule,
  makeTempDir,
  readJson,
  runCli,
  writeConfig,
} from './helpers/cli.js';

const tempDirs = [];
function tempDir(prefix = 'aidash-cli-test-') {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function options({ cwd, dataDir, home, token, env } = {}) {
  return {
    cwd: cwd ?? tempDir(),
    dataDir: dataDir ?? tempDir(),
    home: home ?? tempDir('aidash-cli-home-'),
    token,
    env,
  };
}

test('--version 与 --help 的 JSON 输出', async () => {
  const opts = options();
  const version = await runCli(['--version', '--json'], opts);
  assert.equal(version.code, 0);
  assert.equal(version.json.ok, true);
  assert.equal(typeof version.json.data.version, 'string');

  const help = await runCli(['--help', '--json'], opts);
  assert.equal(help.code, 0);
  assert.match(help.json.data.help, /用法:/);
  assert.match(help.json.data.help, /start --daemon/);
  // --command 的语义必须是“shell 命令”而不是“自然语言提示词”。
  assert.match(help.json.data.help, /不是自然语言提示词/);
  assert.match(help.json.data.help, /\{task_file\}/);
  // 精确通道不是 --channel 的匹配过滤，help 必须让两者一眼可分。
  assert.match(help.json.data.help, /--ensure-channel/);
  assert.match(help.json.data.help, /与 --channel 的匹配过滤不同/);
  assert.match(help.json.data.help, /--resume <engine>/);
});

test('未知命令与缺少参数值返回退出码 2 且带 JSON 错误', async () => {
  const opts = options();
  const unknown = await runCli(['nope', '--json'], opts);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.json.ok, false);
  assert.equal(unknown.json.error.code, 'CONFIG');
  assert.match(unknown.json.error.message, /未知命令/);

  const missingValue = await runCli(['start', '--poll', '--json'], opts);
  assert.equal(missingValue.code, 2);
  assert.equal(missingValue.json.ok, false);
});

test('没有配置也没有 --command 时给出 init/--command 提示', async () => {
  const opts = options();
  const result = await runCli(['start', '--json'], opts);
  assert.equal(result.code, 2);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error.message, /aidash-runner init/);
  assert.match(result.json.error.message, /--command/);
});

test('init 生成安全示例配置，默认不覆盖', async () => {
  const cwd = tempDir();
  const opts = options({ cwd });

  const created = await runCli(['init', '--json'], opts);
  assert.equal(created.code, 0);
  const configPath = path.join(cwd, 'aidash-runner.json');
  assert.equal(created.json.data.path, configPath);
  const config = readJson(configPath);
  assert.equal(config.commands.length, 1);
  assert.deepEqual(config.commands[0].match.tags, ['aidash-runner-demo']);
  assert.equal(config.commands[0].match.match_all, false);

  const again = await runCli(['init', '--json'], opts);
  assert.equal(again.code, 2);
  assert.match(again.json.error.message, /已存在/);

  const forced = await runCli(['init', '--force', '--json'], opts);
  assert.equal(forced.code, 0);
  assert.equal(forced.json.data.overwritten, true);
});

test('init --command 直接生成可运行的 match_all 规则', async () => {
  const cwd = tempDir();
  const opts = options({ cwd });
  const command = 'node -e "console.log(1)"';

  const created = await runCli(['init', '--command', command, '--cwd', cwd, '--json'], opts);
  assert.equal(created.code, 0, `stdout=${created.stdout}\nstderr=${created.stderr}`);
  const config = readJson(path.join(cwd, 'aidash-runner.json'));
  assert.equal(config.commands.length, 1);
  assert.deepEqual(config.commands[0].match, {
    tags: [],
    title_prefix: '',
    channel_key: '',
    priority: [],
    kind: [],
    match_all: true,
  });
  assert.deepEqual(config.commands[0].run.argv, [command]);
  assert.equal(config.commands[0].run.shell, true);
  assert.equal(config.commands[0].run.cwd, path.resolve(cwd));
});

test('init --preset claude 生成跨平台 argv 规则，不经过 shell', async () => {
  const cwd = tempDir();
  const opts = options({ cwd });

  const created = await runCli(['init', '--preset', 'claude', '--cwd', cwd, '--json'], opts);
  assert.equal(created.code, 0, `stdout=${created.stdout}\nstderr=${created.stderr}`);
  const config = readJson(path.join(cwd, 'aidash-runner.json'));
  const rule = config.commands[0];
  assert.equal(rule.name, 'claude-task');
  assert.equal(rule.match.match_all, true);
  assert.equal(rule.run.shell, false);
  assert.equal(rule.run.argv[0], 'claude');
  assert.equal(rule.run.argv[1], '--dangerously-skip-permissions');
  assert.match(rule.run.argv[3], /\{task_file\}/);
  assert.equal(rule.run.result_file, 'claude-result.json');
  assert.equal(rule.run.cwd, path.resolve(cwd));

  const unknown = await runCli(['init', '--preset', 'nope', '--force', '--json'], opts);
  assert.equal(unknown.code, 2);
  assert.match(unknown.json.error.message, /未知 preset/);
});

test('check：有效配置通过；缺令牌只警告；坏配置退出 2', async () => {
  const cwd = tempDir();
  const dataDir = tempDir();
  const configPath = writeConfig(cwd, {
    ...baseConfig(),
    commands: [makeRule({ name: 'ok', argv: ['node', '-v'], match: { tags: ['it'] } })],
  });

  const ok = await runCli(['check', '--config', configPath, '--data-dir', dataDir, '--json'], {
    ...options({ cwd, dataDir }),
  });
  assert.equal(ok.code, 0, `stdout=${ok.stdout}\nstderr=${ok.stderr}`);
  assert.equal(ok.json.data.ok, true);
  assert.equal(ok.json.data.config_path, configPath);
  assert.equal(ok.json.data.commands, 1);

  const noToken = await runCli(
    ['check', '--config', configPath, '--data-dir', dataDir, '--json'],
    { ...options({ cwd, dataDir }), token: null },
  );
  assert.equal(noToken.code, 0);
  assert.match(noToken.json.data.warnings.join('\n'), /令牌不可用/);

  const badPath = path.join(cwd, 'bad.json');
  fs.writeFileSync(
    badPath,
    JSON.stringify({
      commands: [{ name: 'bad', match: {}, run: { argv: ['node', '-v'] } }],
    }),
    'utf8',
  );
  const bad = await runCli(['check', '--config', badPath, '--data-dir', dataDir, '--json'], options({ cwd }));
  assert.equal(bad.code, 2);
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.error.message, /match_all=true/);

  const missing = await runCli(['check', '--config', path.join(cwd, 'missing.json'), '--json'], options({ cwd }));
  assert.equal(missing.code, 2);
  assert.match(missing.json.error.message, /配置文件不存在/);
});

test('list / status / logs / stop 在没有实例时给出明确错误', async () => {
  const opts = options();
  const list = await runCli(['list', '--data-dir', opts.dataDir, '--json'], opts);
  assert.equal(list.code, 0);
  assert.deepEqual(list.json.data.instances, []);
  assert.equal(list.json.data.data_dir, opts.dataDir);

  for (const [args, code] of [
    [['status', '--json'], 'NO_LIVE_INSTANCE'],
    [['logs', '--json'], 'NO_INSTANCE'],
    [['stop', '--json'], 'NO_LIVE_INSTANCE'],
    [['pull', '--json'], 'NO_LIVE_INSTANCE'],
  ]) {
    const result = await runCli([...args, '--data-dir', opts.dataDir], opts);
    assert.equal(result.code, 1, `${args[0]} 应退出 1`);
    assert.equal(result.json.error.code, code, `${args[0]} 错误码`);
  }
});

test('config 子命令用法校验', async () => {
  const opts = options();
  const bogus = await runCli(['config', 'bogus', '--json'], opts);
  assert.equal(bogus.code, 2);
  assert.match(bogus.json.error.message, /用法/);

  const setMissing = await runCli(['config', 'set', 'poll_interval_seconds', '--json'], opts);
  assert.equal(setMissing.code, 2);
  assert.match(setMissing.json.error.message, /用法/);
});
