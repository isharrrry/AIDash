import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgv } from '../src/args.js';
import {
  assertHasCommands,
  findConfigPath,
  instanceIdOf,
  loadConfig,
  resolveDataDir,
  resolveLogFile,
  resolveToken,
} from '../src/config.js';
import { normalizeEndpoint, parseConfigObject } from '../src/config-parse.js';
import { ConfigError } from '../src/errors.js';
import { prepareRuntime } from '../src/cli/common.js';
import { makeTempDir, makeRule, baseConfig } from './helpers/cli.js';

/** parseArgv 返回 {command, positionals, flags}；这些单测只关心 flags。 */
function flagSet(argv) {
  return parseArgv(argv).flags;
}

const tempDirs = [];
function tempDir(prefix = 'aidash-config-test-') {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 临时的 homedir：避免读到开发机真实的 ~/.aidash/runner.json。 */
function withFakeHome(fn) {
  const original = os.homedir;
  const home = tempDir('aidash-home-');
  os.homedir = () => home;
  try {
    return fn(home);
  } finally {
    os.homedir = original;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('默认配置符合规格', () => {
  withFakeHome(() => {
    const cwd = tempDir();
    const { config, warnings, configPath } = loadConfig(flagSet([]), { env: {}, cwd });
    assert.equal(configPath, null);
    assert.equal(config.endpoint, 'http://127.0.0.1:8787/mcp');
    assert.equal(config.harness_id.startsWith('watch-'), true);
    assert.equal(config.poll_interval_seconds, 5);
    assert.equal(config.lease_seconds, 900);
    assert.equal(config.heartbeat_interval_seconds, 60);
    assert.equal(config.gap_seconds, 2);
    assert.equal(config.command_timeout_seconds, 1800);
    assert.deepEqual(config.commands, []);
    assert.deepEqual(warnings, []);
  });
});

test('配置查找顺序：--config > 环境变量 > 当前目录', () => {
  const cwd = tempDir();
  const cwdConfig = path.join(cwd, 'aidash-runner.json');
  const envConfig = path.join(tempDir(), 'env.json');
  const flagConfig = path.join(tempDir(), 'flag.json');
  for (const file of [cwdConfig, envConfig, flagConfig]) writeJson(file, baseConfig());

  const foundFlag = findConfigPath(flagSet(['--config', flagConfig]), { AIDASH_RUNNER_CONFIG: envConfig }, cwd);
  assert.equal(foundFlag.path, flagConfig);
  assert.equal(foundFlag.source, '--config');

  const foundEnv = findConfigPath(flagSet([]), { AIDASH_RUNNER_CONFIG: envConfig }, cwd);
  assert.equal(foundEnv.path, envConfig);
  assert.equal(foundEnv.source, 'AIDASH_RUNNER_CONFIG');

  const foundCwd = findConfigPath(flagSet([]), {}, cwd);
  assert.equal(foundCwd.path, cwdConfig);
  assert.equal(foundCwd.source, 'cwd');
});

test('显式指定的配置文件不存在时直接报错，不静默退回默认值', () => {
  const missing = path.join(tempDir(), 'missing.json');
  assert.throws(
    () => loadConfig(flagSet(['--config', missing]), { env: {}, cwd: process.cwd() }),
    (error) =>
      error instanceof ConfigError &&
      error.message.includes('配置文件不存在') &&
      error.message.includes('--config'),
  );
  assert.throws(
    () => loadConfig(flagSet([]), { env: { AIDASH_RUNNER_CONFIG: missing }, cwd: process.cwd() }),
    (error) => error instanceof ConfigError && error.message.includes('AIDASH_RUNNER_CONFIG'),
  );
});

test('CLI 覆盖优先级高于配置文件', () => {
  const cwd = tempDir();
  const configPath = path.join(cwd, 'aidash-runner.json');
  writeJson(configPath, {
    ...baseConfig({ url: 'http://127.0.0.1:9999/mcp' }),
    poll_interval_seconds: 11,
    commands: [makeRule({ argv: ['node', '-v'] })],
  });
  const flags = flagSet([
    'start',
    '--url',
    'http://127.0.0.1:9998',
    '--harness-id',
    'my-runner',
    '--name',
    'My Runner',
    '--poll',
    '12',
    '--lease',
    '90',
    '--heartbeat',
    '30',
    '--gap',
    '1.5',
    '--channel',
    'chan-a',
    '--channel',
    'chan-b/*',
    '--log-file',
    'my.log',
  ]);
  const { config } = loadConfig(flags, { env: {}, cwd });
  assert.equal(config.endpoint, 'http://127.0.0.1:9998/mcp');
  assert.equal(config.harness_id, 'my-runner');
  assert.equal(config.name, 'My Runner');
  assert.equal(config.poll_interval_seconds, 12);
  assert.equal(config.lease_seconds, 90);
  assert.equal(config.heartbeat_interval_seconds, 30);
  assert.equal(config.gap_seconds, 1.5);
  assert.deepEqual(config.channels, ['chan-a', 'chan-b/*']);
  assert.equal(config.log_file, path.join(cwd, 'my.log'));
});

test('--command 替换配置规则并显式使用 shell + match_all', () => {
  const cwd = tempDir();
  const configPath = path.join(cwd, 'aidash-runner.json');
  writeJson(configPath, { commands: [makeRule({ name: 'old', argv: ['node', '-v'] })] });
  const flags = flagSet(['start', '--command', 'echo hello', '--cwd', 'work']);
  const { config } = loadConfig(flags, { env: {}, cwd });
  assert.equal(config.commands.length, 1);
  assert.equal(config.commands[0].name, 'cli-command');
  assert.deepEqual(config.commands[0].run.argv, ['echo hello']);
  assert.equal(config.commands[0].run.shell, true);
  assert.equal(config.commands[0].match.match_all, true);
  assert.equal(config.commands[0].run.cwd, path.join(cwd, 'work'));
});

test('--cwd 在多条规则时拒绝猜测', () => {
  const cwd = tempDir();
  const configPath = path.join(cwd, 'aidash-runner.json');
  writeJson(configPath, {
    commands: [makeRule({ name: 'a', argv: ['node', '-v'] }), makeRule({ name: 'b', argv: ['node', '-v'] })],
  });
  assert.throws(
    () => loadConfig(flagSet(['start', '--cwd', 'x']), { env: {}, cwd }),
    (error) => error instanceof ConfigError && error.message.includes('多条规则'),
  );
});

test('令牌顺序：AIDASH_TOKEN > --token/--key > --token-file', () => {
  const tokenFile = path.join(tempDir(), 'token.txt');
  fs.writeFileSync(tokenFile, '  file-token-123456  \n', 'utf8');

  const fromEnv = resolveToken(flagSet(['--token', 'cli-token-123456']), {
    AIDASH_TOKEN: 'env-token-123456',
  });
  assert.equal(fromEnv.token, 'env-token-123456');
  assert.equal(fromEnv.source, 'env');
  assert.match(fromEnv.warnings.join('\n'), /AIDASH_TOKEN 环境变量优先/);

  const fromCli = resolveToken(flagSet(['--token', 'cli-token-123456']), {});
  assert.equal(fromCli.token, 'cli-token-123456');
  assert.equal(fromCli.source, 'cli');
  assert.match(fromCli.warnings.join('\n'), /shell 历史/);

  const fromFile = resolveToken(flagSet(['--token-file', tokenFile]), {});
  assert.equal(fromFile.token, 'file-token-123456');
  assert.equal(fromFile.source, 'file');

  // 仅口令启动的服务端：没有令牌/文件时，口令作为最后兜底。
  const fromPassphrase = resolveToken(flagSet([]), {
    AIDASH_PASSPHRASE: 'passphrase-123456',
  });
  assert.equal(fromPassphrase.token, 'passphrase-123456');
  assert.equal(fromPassphrase.source, 'passphrase');
  assert.match(fromPassphrase.warnings.join('\n'), /AIDASH_PASSPHRASE/);

  // 显式命令行令牌优先于环境口令，避免“只想临时换令牌却被口令盖住”。
  const cliOverPassphrase = resolveToken(flagSet(['--token', 'cli-token-123456']), {
    AIDASH_PASSPHRASE: 'passphrase-123456',
  });
  assert.equal(cliOverPassphrase.token, 'cli-token-123456');
  assert.equal(cliOverPassphrase.source, 'cli');

  assert.throws(
    () => resolveToken(flagSet(['--token', 'a', '--key', 'b']), {}),
    (error) => error instanceof ConfigError && error.message.includes('只能给一个'),
  );
  assert.throws(
    () => resolveToken(flagSet([]), {}),
    (error) => error instanceof ConfigError && error.message.includes('AIDASH_TOKEN'),
  );
  assert.throws(
    () => resolveToken(flagSet([]), { AIDASH_TOKEN: 'has space token' }),
    (error) => error instanceof ConfigError && error.message.includes('空白'),
  );
});

test('没有任何匹配条件的规则必须显式 match_all=true', () => {
  assert.throws(
    () =>
      parseConfigObject({
        commands: [
          {
            name: 'danger',
            match: {},
            run: { argv: ['node', '-v'] },
          },
        ],
      }),
    (error) => error instanceof ConfigError && error.message.includes('match_all=true'),
  );
});

test('未知字段只警告，凭据类顶层键直接拒绝', () => {
  const warnings = [];
  parseConfigObject(
    { unknown_field: 1, commands: [makeRule({ argv: ['node', '-v'], match: { match_all: true } })] },
    { warnings },
  );
  assert.match(warnings.join('\n'), /未知配置项 unknown_field/);

  assert.throws(
    () => parseConfigObject({ aidash_token: 'nope', commands: [] }),
    (error) => error instanceof ConfigError && error.message.includes('凭据'),
  );
});

test('相对 cwd/result_file 按配置文件目录解析', () => {
  const configDir = tempDir();
  const config = parseConfigObject(
    {
      commands: [
        makeRule({
          argv: ['node', '-v'],
          match: { match_all: true },
          run: { cwd: 'work', result_file: 'out/result.json' },
        }),
      ],
    },
    { configPath: path.join(configDir, 'aidash-runner.json'), configDir },
  );
  assert.equal(config.commands[0].run.cwd, path.join(configDir, 'work'));
  assert.equal(config.commands[0].run.result_file, path.join(configDir, 'out', 'result.json'));
});

test('环境变量白名单过滤令牌类变量并给出警告', () => {
  const warnings = [];
  const config = parseConfigObject(
    {
      env_passthrough: ['PATH', 'AIDASH_TOKEN', 'MY_SECRET', 'HTTPS_PROXY'],
      commands: [makeRule({ argv: ['node', '-v'], match: { match_all: true } })],
    },
    { warnings },
  );
  assert.deepEqual(config.env_passthrough, ['PATH', 'HTTPS_PROXY']);
  assert.match(warnings.join('\n'), /敏感变量 AIDASH_TOKEN 已被忽略/);
  assert.match(warnings.join('\n'), /敏感变量 MY_SECRET 已被忽略/);
});

test('run.env 里写敏感变量名会被拒绝', () => {
  assert.throws(
    () =>
      parseConfigObject({
        commands: [
          {
            name: 'bad-env',
            match: { match_all: true },
            run: { argv: ['node', '-v'], env: { DB_PASSWORD: 'x' } },
          },
        ],
      }),
    (error) => error instanceof ConfigError && error.message.includes('敏感变量名'),
  );
});

test('concurrency 目前只支持 1', () => {
  assert.throws(
    () => parseConfigObject({ concurrency: 2, commands: [] }),
    (error) => error instanceof ConfigError && error.message.includes('concurrency'),
  );
});

test('normalizeEndpoint 补 /mcp 并拒绝内嵌凭据', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.1:8787'), 'http://127.0.0.1:8787/mcp');
  assert.equal(normalizeEndpoint('http://127.0.0.1:8787/mcp/'), 'http://127.0.0.1:8787/mcp');
  assert.equal(normalizeEndpoint('http://127.0.0.1:8787/api?x=1#y'), 'http://127.0.0.1:8787/api/mcp');
  assert.throws(() => normalizeEndpoint('ftp://x'), /只支持 http\/https/);
  assert.throws(() => normalizeEndpoint('http://user:pass@x'), /不能内嵌账号密码/);
});

test('data_dir / log_file 的解析顺序', () => {
  withFakeHome((home) => {
    const cwd = tempDir();
    const config = { data_dir: path.join(cwd, 'from-config') };
    assert.equal(resolveDataDir(flagSet([]), config, {}, cwd), config.data_dir);
    assert.equal(
      resolveDataDir(flagSet([]), config, { AIDASH_RUNNER_HOME: path.join(cwd, 'from-env') }, cwd),
      path.join(cwd, 'from-env'),
    );
    assert.equal(
      resolveDataDir(flagSet(['--data-dir', 'from-flag']), config, { AIDASH_RUNNER_HOME: 'x' }, cwd),
      path.join(cwd, 'from-flag'),
    );
    assert.equal(resolveDataDir(flagSet([]), { data_dir: '' }, {}, cwd), path.join(home, '.aidash', 'runner'));

    assert.equal(
      resolveLogFile(flagSet([]), { log_file: '' }, '/data', 'watch-a', cwd),
      path.join('/data', 'logs', 'watch-a.log'),
    );
    assert.equal(
      resolveLogFile(flagSet(['--log-file', 'flag.log']), { log_file: '/x.log' }, '/data', 'watch-a', cwd),
      path.join(cwd, 'flag.log'),
    );
  });
});

test('instanceIdOf 做路径安全整形', () => {
  assert.equal(instanceIdOf({ harness_id: 'watch-a.b_c:d' }), 'watch-a.b_c:d');
  assert.equal(instanceIdOf({ harness_id: '../evil/harness' }), '..-evil-harness');
  assert.equal(instanceIdOf({ harness_id: '...' }), '-');
});

test('--command 启动时警告：它是 shell 命令，不是自然语言提示词', () => {
  withFakeHome(() => {
    const dir = tempDir();
    const configPath = path.join(dir, 'aidash-runner.json');
    writeJson(configPath, {
      ...baseConfig(),
      commands: [makeRule({ argv: ['node', '-v'] })],
    });

    const flags = flagSet([
      'start',
      '--config',
      configPath,
      '--command',
      '写个py hello打印程序',
      '--data-dir',
      tempDir(),
    ]);
    const prepared = prepareRuntime(flags, { requireToken: false });
    const text = prepared.warnings.join('\n');

    assert.match(text, /--command 按 shell 命令执行/);
    assert.match(text, /自然语言不会被 AI 解释/);
    assert.match(text, /match_all 会作用于所有匹配任务/);
  });
});

test('assertHasCommands 的提示包含 init 与 --command', () => {
  assert.throws(
    () => assertHasCommands({ commands: [] }),
    (error) =>
      error instanceof ConfigError && error.message.includes('init') && error.message.includes('--command'),
  );
  assert.doesNotThrow(() => assertHasCommands({ commands: [{}] }));
});
