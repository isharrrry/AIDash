import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ManagerStore } from '../src/store.js';
import { stopAidash } from '../src/process.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(TESTS_DIR, '..');
const BIN = path.join(PACKAGE_ROOT, 'bin', 'aidash-manager.mjs');
const SIGNAL_FIXTURE = path.join(TESTS_DIR, 'fixtures', 'manager-web-signal.mjs');

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startBlocker(port) {
  const server = net.createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const liveChildren = new Set();
function track(child) {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

function startCli(args) {
  const child = track(spawn(process.execPath, [BIN, ...args], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }));
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, stdout: state.stdout, stderr: state.stderr }));
  });
  return { child, state, exited };
}

/**
 * printJson 输出的是多行美化 JSON，不能按行解析；等 stdout 收成一个完整对象
 * 再整体 parse。解析失败说明 JSON 还没收完，继续等下一个 chunk。
 */
function waitForEnvelope(child, state, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      child.removeListener('exit', onExit);
      fn(value);
    };
    const onExit = (code) => {
      finish(reject, new Error(`管理台进程提前退出（code=${code}）：${state.stdout}${state.stderr}`));
    };
    const timer = setInterval(() => {
      const text = state.stdout.trim();
      if (text.startsWith('{') && text.endsWith('}')) {
        try {
          finish(resolve, JSON.parse(text));
          return;
        } catch {
          // 还没收完或者不是我们要的信封，继续等。
        }
      }
      if (Date.now() - startedAt > timeoutMs) {
        finish(reject, new Error(`等待启动 JSON 超时：${state.stdout}${state.stderr}`));
      }
    }, 50);
    child.once('exit', onExit);
  });
}

/** 带超时的等待；必须清掉计时器，否则 unref 之前的定时器会把测试进程吊住。 */
async function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function killAndWait(child, exited, timeoutMs = 5_000) {
  if (child.exitCode === null) child.kill();
  await withTimeout(exited, timeoutMs, '子进程退出超时');
}

async function waitForHealth(url, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 还没监听，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待 ${url} 就绪超时`);
}

test.after(() => {
  // 测试失败时也要收掉子进程，否则它们的 stdout 管道会吊住测试进程。
  for (const child of liveChildren) {
    try {
      child.kill();
    } catch {
      // 已经退出。
    }
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('无参启动：默认 web、打印带 token 的地址并写 runtime', async () => {
  const home = tempDir('am-cli-start-');
  const port = await freePort();
  const { child, state, exited } = startCli([
    '--home',
    home,
    '--port',
    String(port),
    '--no-open',
    '--json',
  ]);
  try {
    const envelope = await waitForEnvelope(child, state);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.port, port);
    assert.equal(envelope.data.url, `http://127.0.0.1:${port}`);
    assert.equal(envelope.data.host, '127.0.0.1');
    assert.equal(envelope.data.home, path.resolve(home));
    assert.equal(envelope.data.opened, false);

    const token = fs.readFileSync(path.join(home, 'web-token'), 'utf8').trim();
    const accessUrl = new URL(envelope.data.access_url);
    assert.equal(accessUrl.pathname, '/');
    assert.equal(accessUrl.searchParams.get('token'), token);
    assert.match(envelope.data.access_url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?token=[A-Za-z0-9]+$`));

    const runtime = JSON.parse(fs.readFileSync(path.join(home, 'web-runtime.json'), 'utf8'));
    assert.equal(runtime.port, port);
    assert.equal(runtime.url, envelope.data.url);
    assert.equal(runtime.pid, child.pid);

    assert.equal((await fetch(`${envelope.data.url}/healthz`)).status, 200);
  } finally {
    await killAndWait(child, exited);
  }
});

test('显式 --port 冲突：直接报错，不静默换端口', async () => {
  const home = tempDir('am-cli-conflict-');
  const port = await freePort();
  const blocker = await startBlocker(port);
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, 'web', '--home', home, '--port', String(port), '--no-open', '--json'],
      { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    assert.equal(result.status, 1, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'LISTEN_FAILED');
    assert.match(envelope.error.message, new RegExp(`:${port}`));
    // 严格失败不能留下 runtime 记录。
    assert.equal(fs.existsSync(path.join(home, 'web-runtime.json')), false);
  } finally {
    await blocker.close();
  }
});

async function startExternalHealth(port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'ok', version: 'external-test' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

test('CLI remove：外部实例只移除登记，不停止外部进程', async () => {
  const home = tempDir('am-cli-external-');
  const root = tempDir('am-cli-external-root-');
  const port = await freePort();
  const external = await startExternalHealth(port);
  try {
    // 必须用异步 spawn：spawnSync 会阻塞测试进程的事件循环，假外部服务就无法应答健康探测。
    const addRun = startCli(['add', 'aidash', '--name', '外部 CLI', '--cwd', root, '--port', String(port), '--token', 'test-token-123', '--home', home, '--json']);
    const added = await withTimeout(addRun.exited, 20_000, 'add 超时');
    assert.equal(added.code, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).ok, true);

    const removeRun = startCli(['remove', '外部 CLI', '--home', home, '--json']);
    const removed = await withTimeout(removeRun.exited, 20_000, 'remove 超时');
    assert.equal(removed.code, 0, removed.stderr);
    const envelope = JSON.parse(removed.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.external, true);
    // 记录删除后外部服务仍在响应。
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  } finally {
    await external.close();
  }
});

test('--version/version/--help 的 JSON 信封与 README 一致', () => {
  const version = JSON.parse(
    spawnSync(process.execPath, [BIN, '--version', '--json'], { encoding: 'utf8' }).stdout,
  );
  assert.match(version.data.version, /^\d+\.\d+\.\d+$/);

  const versionCommand = JSON.parse(
    spawnSync(process.execPath, [BIN, 'version', '--json'], { encoding: 'utf8' }).stdout,
  );
  assert.equal(versionCommand.ok, true);
  assert.equal(versionCommand.data.version, version.data.version);

  const help = JSON.parse(
    spawnSync(process.execPath, [BIN, '--help', '--json'], { encoding: 'utf8' }).stdout,
  );
  assert.equal(help.ok, true);
  assert.equal(help.data.version, version.data.version);
  assert.match(help.data.help, /aidash-manager/);
  assert.match(help.data.help, /--strict-port/);
  assert.match(help.data.help, /--follow\|-f/);

  // 根 README 用 `logs <id> -f`；-f 必须是 --follow 的别名，而不是未知参数。
  const home = tempDir('am-cli-alias-');
  const logs = spawnSync(
    process.execPath,
    [BIN, 'logs', 'missing-service', '-f', '--home', home, '--json'],
    { encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(logs.status, 1, logs.stderr);
  assert.equal(JSON.parse(logs.stdout).error.code, 'SERVICE_NOT_FOUND');
});

const FAKE_SERVER = `
const http = require('node:http');
const port = Number(process.env.AIDASH_PORT);
const host = process.env.AIDASH_HOST || '127.0.0.1';
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
server.listen(port, host);
`;

test('模拟 Ctrl+C 退出：清理 runtime，已拉起的服务继续运行', async () => {
  const home = tempDir('am-cli-exit-home-');
  const root = tempDir('am-cli-exit-repo-');
  fs.mkdirSync(path.join(root, 'server', 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'dist', 'server', 'main.js'), FAKE_SERVER);

  const servicePort = await freePort();
  const webPort = await freePort();

  const fixture = track(spawn(process.execPath, [SIGNAL_FIXTURE, home, String(webPort)], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }));
  const fixtureState = { stdout: '', stderr: '' };
  fixture.stdout.on('data', (chunk) => {
    fixtureState.stdout += chunk;
  });
  fixture.stderr.on('data', (chunk) => {
    fixtureState.stderr += chunk;
  });
  const fixtureExited = new Promise((resolve) => {
    fixture.once('exit', (code, signal) => resolve({ code, signal }));
  });

  let store;
  let service;
  try {
    await waitForHealth(`http://127.0.0.1:${webPort}/healthz`);
    const token = fs.readFileSync(path.join(home, 'web-token'), 'utf8').trim();
    const headers = { 'x-aidash-manager-token': token, 'content-type': 'application/json' };

    const created = await fetch(`http://127.0.0.1:${webPort}/api/services`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'aidash',
        name: '退出测试',
        cwd: root,
        token: 'test-token-123',
        spec: { host: '127.0.0.1', port: servicePort, tokenSource: 'manager' },
      }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    service = JSON.parse(createdText).data;

    const started = await fetch(`http://127.0.0.1:${webPort}/api/services/${service.id}/start`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const startedText = await started.text();
    assert.equal(started.status, 200, startedText);
    const servicePid = JSON.parse(startedText).data.runtime.pid;
    assert.ok(servicePid > 0);
    assert.equal((await fetch(`http://127.0.0.1:${servicePort}/healthz`)).status, 200);

    // 通知夹具模拟 Ctrl+C。
    fs.writeFileSync(path.join(home, 'shutdown'), '');
    const result = await withTimeout(fixtureExited, 20_000, '夹具退出超时');
    assert.equal(result.code, 0, fixtureState.stderr);

    // 管理台自己的 runtime 记录被清理，但服务记录与 PID 都保留，服务进程还在。
    assert.equal(fs.existsSync(path.join(home, 'web-runtime.json')), false);
    const persisted = new ManagerStore({ home }).init();
    assert.ok(persisted.getService(service.id), '服务记录应持久化');
    assert.equal(persisted.readRunState(service.id)?.pid, servicePid);
    assert.equal((await fetch(`http://127.0.0.1:${servicePort}/healthz`)).status, 200);
  } finally {
    if (fixture.exitCode === null) fixture.kill();
    store = new ManagerStore({ home }).init();
    if (service) {
      const current = store.getService(service.id);
      if (current) await stopAidash(store, current, { force: true }).catch(() => {});
    }
  }
});

test('CLI add runner：相对 --cwd 不重复拼接 run_cwd，--data-dir 是 runner 数据目录', () => {
  const home = tempDir('am-cli-runner-home-');
  const root = tempDir('am-cli-runner-root-');
  const dataDir = path.join(root, 'runner-data');
  const configPath = path.join(root, 'runner.json');
  // 相对路径是合法用法：run_cwd 留空时应落在服务工作目录，而不是 <cwd>/<cwd>。
  const relativeRoot = path.relative(PACKAGE_ROOT, root);
  const result = spawnSync(
    process.execPath,
    [
      BIN,
      'add',
      'runner',
      '--home',
      home,
      '--name',
      '相对路径 Runner',
      '--cwd',
      relativeRoot,
      '--template',
      'claude',
      '--harness-id',
      'relative-test',
      '--config-path',
      configPath,
      '--data-dir',
      dataDir,
      '--ensure-channel',
      'devhost/demo/d2611',
      '--channel-title',
      '演示通道',
      '--token-source',
      'env',
      '--json',
    ],
    { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, result.stdout);

  // --data-dir 不能再被当成管理台 home：管理台状态仍在 --home 下。
  assert.equal(fs.existsSync(path.join(home, 'manager.json')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'manager.json')), false);

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.data_dir, dataDir);
  assert.equal(config.commands[0].run.cwd, path.resolve(root));

  const persisted = new ManagerStore({ home }).init();
  const service = persisted.listServices()[0];
  assert.equal(service.runner.dataDir, dataDir);
  assert.equal(service.runner.runCwd, path.resolve(root));
  // 创建/复用通道是启动参数，不属于 runner 配置文件；必须保存在服务定义里。
  assert.equal(service.runner.ensureChannel, 'devhost/demo/d2611');
  assert.equal(service.runner.channelTitle, '演示通道');
  assert.equal(config.ensure_channel, undefined);
});
