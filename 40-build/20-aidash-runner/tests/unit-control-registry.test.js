import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import {
  controlRequest,
  getControlHealth,
  getControlStatus,
  isLoopbackControlUrl,
  requestControlConfig,
  requestControlPull,
  requestControlReload,
  requestControlStop,
} from '../src/control-client.js';
import {
  buildRegistryEntry,
  inspectRegistryEntry,
  instancesDir,
  listRegistryEntries,
  readRegistryEntry,
  registryFilePath,
  removeRegistryEntry,
  writeRegistryEntry,
} from '../src/registry.js';
import {
  applyConfigPatch,
  assertLiveKey,
  coerceConfigValue,
  configView,
  persistConfigPatch,
} from '../src/config-keys.js';
import { parseConfigObject } from '../src/config-parse.js';
import { ControlError, ConfigError } from '../src/errors.js';
import { makeRule, makeTempDir } from './helpers/cli.js';
import { sleep } from '../src/util.js';

const tempDirs = [];
function tempDir() {
  const dir = makeTempDir('aidash-control-test-');
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function entryFor(control, overrides = {}) {
  return buildRegistryEntry({
    instanceId: overrides.instanceId ?? 'watch-test',
    pid: overrides.pid ?? process.pid,
    mode: 'foreground',
    harnessId: overrides.harnessId ?? 'watch-test',
    configPath: '',
    controlUrl: overrides.controlUrl ?? control.url,
    controlToken: overrides.controlToken ?? control.token,
    logFile: '',
    startedAt: overrides.startedAt ?? '2026-01-01T00:00:00.000Z',
    version: '0.1.0',
  });
}

async function startFakeControl(overrides = {}) {
  const identity = {
    instance_id: 'watch-test',
    pid: process.pid,
    harness_id: 'watch-test',
    name: 'test',
    mode: 'foreground',
    started_at: '2026-01-01T00:00:00.000Z',
    version: '0.1.0',
    ...overrides.identity,
  };
  let stopCalls = 0;
  const control = await startControlServer({
    identity: () => identity,
    getStatus: () => ({ instance_id: identity.instance_id, pid: process.pid, status_value: 1 }),
    onPull: () => ({ triggered: true, queued: false }),
    onStop: () => {
      stopCalls += 1;
    },
    onConfig: (patch, persist) => ({ applied: Object.keys(patch), persisted: persist, patch }),
    onReload: () => ({ reloaded: true, applied: ['poll_interval_seconds'], restart_required: ['name'] }),
    controlToken: overrides.token ?? 'control-token-for-tests-123456',
    logger: null,
  });
  return { control, identity, getStopCalls: () => stopCalls };
}

/* --------------------------------- registry --------------------------------- */

test('registry 原子写入、读取与 pid 守卫删除', () => {
  const dataDir = tempDir();
  const entry = buildRegistryEntry({
    instanceId: 'watch-a',
    pid: process.pid,
    mode: 'background',
    harnessId: 'watch-a',
    configPath: '/cfg.json',
    controlUrl: 'http://127.0.0.1:1234',
    controlToken: 'control-token',
    logFile: '/logs/a.log',
    startedAt: '2026-01-01T00:00:00.000Z',
    version: '0.1.0',
  });
  const filePath = writeRegistryEntry(dataDir, entry);
  assert.equal(filePath, registryFilePath(dataDir, 'watch-a'));
  assert.equal(fs.existsSync(filePath), true);

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(raw.control_token, 'control-token');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
  const leftovers = fs.readdirSync(instancesDir(dataDir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);

  const loaded = readRegistryEntry(dataDir, 'watch-a');
  assert.equal(loaded.mode, 'background');
  assert.equal(loaded.invalid, null);

  // 错误 pid 不能删掉别的实例记录。
  assert.equal(removeRegistryEntry(dataDir, 'watch-a', { pid: process.pid + 1 }), false);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(removeRegistryEntry(dataDir, 'watch-a', { pid: process.pid }), true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(removeRegistryEntry(dataDir, 'watch-a'), false);
});

test('损坏的 registry 保留为 invalid 记录供 list 解释', () => {
  const dataDir = tempDir();
  const dir = instancesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json', 'utf8');
  fs.writeFileSync(path.join(dir, 'array.json'), '[]', 'utf8');
  writeRegistryEntry(
    dataDir,
    buildRegistryEntry({
      instanceId: 'good',
      pid: process.pid,
      mode: 'foreground',
      harnessId: 'good',
      controlUrl: 'http://127.0.0.1:1',
      controlToken: 't',
      logFile: '',
      startedAt: '2026-01-01T00:00:00Z',
      version: '0.1.0',
    }),
  );
  const entries = listRegistryEntries(dataDir);
  assert.equal(entries.length, 3);
  const broken = entries.find((item) => item.instance_id === 'broken');
  assert.match(broken.invalid[0], /合法 JSON/);
  const array = entries.find((item) => item.instance_id === 'array');
  assert.match(array.invalid[0], /顶层不是对象/);
});

test('存活判定要求 PID + 回环控制面 + 指纹一致', async () => {
  const { control } = await startFakeControl();
  try {
    const alive = await inspectRegistryEntry(entryFor(control));
    assert.equal(alive.alive, true);

    const wrongFingerprint = await inspectRegistryEntry(
      entryFor(control, { startedAt: '2026-01-02T00:00:00.000Z' }),
    );
    assert.equal(wrongFingerprint.alive, false);
    assert.match(wrongFingerprint.stale_reason, /fingerprint-mismatch/);

    const external = await inspectRegistryEntry(
      entryFor(control, { controlUrl: 'http://example.com:80', controlToken: control.token }),
    );
    assert.equal(external.alive, false);
    assert.match(external.stale_reason, /not-loopback/);

    const dead = await inspectRegistryEntry(entryFor(control, { pid: 2_147_483_647 }));
    assert.equal(dead.alive, false);
    assert.equal(dead.stale_reason, 'pid-not-running');

    assert.equal((await inspectRegistryEntry(null)).stale_reason, 'registry-missing');
  } finally {
    await control.close();
  }
});

/* -------------------------------- control API ------------------------------- */

test('控制面要求 Bearer 令牌，且只接受回环地址', async () => {
  const { control } = await startFakeControl();
  const entry = entryFor(control);
  try {
    const noAuth = await fetch(`${control.url}/health`);
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(`${control.url}/health`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrong.status, 401);

    const health = await getControlHealth(entry);
    assert.equal(health.instance_id, 'watch-test');
    assert.equal(health.pid, process.pid);
    assert.equal(health.healthy, true);

    assert.equal(isLoopbackControlUrl('http://127.0.0.1:1'), true);
    assert.equal(isLoopbackControlUrl('http://[::1]:1'), true);
    assert.equal(isLoopbackControlUrl('http://localhost:1'), false);
    assert.equal(isLoopbackControlUrl('https://127.0.0.1:1'), false);
    assert.equal(isLoopbackControlUrl('not-a-url'), false);
    await assert.rejects(
      () => controlRequest({ controlUrl: 'http://example.com', controlToken: 'x', pathname: '/health' }),
      (error) => error instanceof ControlError && error.status === 400,
    );
    await assert.rejects(
      () => controlRequest({ controlUrl: control.url, controlToken: '', pathname: '/health' }),
      (error) => error instanceof ControlError && error.status === 401,
    );
  } finally {
    await control.close();
  }
});

test('控制面端点：status/pull/config/reload/stop/404/405', async () => {
  const { control, getStopCalls } = await startFakeControl();
  const entry = entryFor(control);
  try {
    const status = await getControlStatus(entry);
    assert.equal(status.status_value, 1);

    const pull = await requestControlPull(entry);
    assert.equal(pull.triggered, true);
    assert.equal(pull.status.status_value, 1);

    const config = await requestControlConfig(entry, { poll_interval_seconds: '15' }, true);
    assert.deepEqual(config.applied, ['poll_interval_seconds']);
    assert.equal(config.persisted, true);
    assert.deepEqual(config.patch, { poll_interval_seconds: '15' });

    const reload = await requestControlReload(entry);
    assert.equal(reload.reloaded, true);
    assert.deepEqual(reload.restart_required, ['name']);

    const stop = await requestControlStop(entry);
    assert.equal(stop.stopping, true);
    await sleep(120);
    assert.equal(getStopCalls(), 1);

    const notFound = await fetch(`${control.url}/nope`, {
      headers: { authorization: `Bearer ${control.token}` },
    });
    assert.equal(notFound.status, 404);

    const wrongMethod = await fetch(`${control.url}/health`, {
      method: 'POST',
      headers: { authorization: `Bearer ${control.token}` },
    });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await control.close();
  }
});

test('控制面 /config 的非法请求体返回 400', async () => {
  const { control } = await startFakeControl();
  try {
    const response = await fetch(`${control.url}/config`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${control.token}`,
        'content-type': 'application/json',
      },
      body: '[]',
    });
    assert.equal(response.status, 400);
  } finally {
    await control.close();
  }
});

/* -------------------------------- config keys ------------------------------- */

function parsedConfig(extra = {}) {
  return parseConfigObject({
    poll_interval_seconds: 30,
    gap_seconds: 2,
    commands: [makeRule({ name: 'x', argv: ['node', '-v'], match: { tags: ['it'] } })],
    ...extra,
  });
}

test('config set 值类型转换：数字、整数、数组、敏感变量', () => {
  assert.equal(coerceConfigValue('poll_interval_seconds', '45'), 45);
  assert.equal(coerceConfigValue('gap_seconds', '0.5'), 0.5);
  assert.throws(() => coerceConfigValue('lease_seconds', '1.5'), /整数/);
  assert.throws(() => coerceConfigValue('poll_interval_seconds', '0'), /1\.\.86400/);
  assert.deepEqual(coerceConfigValue('channels', 'a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(coerceConfigValue('channels', '[]'), []);
  assert.deepEqual(coerceConfigValue('channels', '["a","b"]'), ['a', 'b']);
  assert.throws(() => coerceConfigValue('channels', '[bad'), /JSON/);
  assert.throws(() => coerceConfigValue('env_passthrough', 'PATH,AIDASH_TOKEN'), /敏感变量/);
  assert.throws(() => coerceConfigValue('harness_id', 'x'), /不支持运行时修改/);
  assert.throws(() => coerceConfigValue('nope', 'x'), /未知配置项/);
});

test('config set 白名单：需要重启的键直接拒绝', () => {
  assert.doesNotThrow(() => assertLiveKey('poll_interval_seconds'));
  assert.throws(
    () => assertLiveKey('harness_id'),
    (error) => error instanceof ConfigError && error.message.includes('需要重启'),
  );
  assert.throws(
    () => assertLiveKey('unknown_key'),
    (error) => error instanceof ConfigError && error.message.includes('未知配置项'),
  );
});

test('applyConfigPatch 走完整 schema 校验', () => {
  const config = parsedConfig();
  const next = applyConfigPatch(config, {
    poll_interval_seconds: 45,
    channels: ['chan-a'],
    gap_seconds: 0.5,
  });
  assert.equal(next.poll_interval_seconds, 45);
  assert.deepEqual(next.channels, ['chan-a']);
  assert.equal(next.gap_seconds, 0.5);
  assert.throws(() => applyConfigPatch(config, { harness_id: 'x' }), /需要重启/);
});

test('persistConfigPatch 只改目标键并保留未知字段', () => {
  const dir = tempDir();
  const configPath = path.join(dir, 'aidash-runner.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        aidash_url: 'http://127.0.0.1:8787/mcp',
        poll_interval_seconds: 30,
        gap_seconds: 2,
        note: '用户自己的备注',
        commands: [makeRule({ argv: ['node', '-v'], match: { tags: ['it'] } })],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const config = parseConfigObject(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    configPath,
    configDir: dir,
  });
  persistConfigPatch(config, { poll_interval_seconds: 55, channels: ['a'] });
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.poll_interval_seconds, 55);
  assert.deepEqual(saved.channels, ['a']);
  assert.equal(saved.note, '用户自己的备注');

  assert.throws(
    () => persistConfigPatch({ ...config, config_path: '' }, { poll_interval_seconds: 60 }),
    /没有配置文件/,
  );
});

test('configView 不含任何令牌字段', () => {
  const view = configView(parsedConfig());
  const text = JSON.stringify(view);
  assert.equal(text.includes('token"'), false);
  assert.equal(text.includes('control_token'), false);
  assert.equal(view.poll_interval_seconds, 30);
});
