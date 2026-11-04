import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ManagerStore } from '../src/store.js';
import { aidashLayoutCandidates } from '../src/constants.js';
import { createServiceWithFiles } from '../src/api.js';
import { buildRunnerStartArgs, getAidashRuntime, startAidash, stopAidash } from '../src/process.js';
import { createService } from '../src/service.js';

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

/**
 * 端口占用用的 blocker：只接受 TCP 连接，不读请求也不响应。
 *
 * 这种不读数据的 socket 收不到对端 FIN（Node 的暂停流不会去读），
 * 因此 server.close() 的 callback 会一直等下去。测试结束时必须显式
 * destroy 全部连接（closeAllConnections 作为兜底），这正是本用例曾经的挂起点。
 */
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
    server,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const FAKE_CONFIG_SERVER = `
const fs = require('node:fs');
const http = require('node:http');
const cfg = JSON.parse(fs.readFileSync(process.env.AIDASH_CONFIG, 'utf8'));
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, db_path: cfg.db_path, static_dir: cfg.static_dir }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
server.listen(Number(cfg.port), cfg.host || '127.0.0.1');
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
`;

const FAKE_SERVER = `
const http = require('node:http');
const port = Number(process.env.AIDASH_PORT);
const host = process.env.AIDASH_HOST || '127.0.0.1';
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, db_path: process.env.AIDASH_DB_PATH }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
server.listen(port, host);
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
`;

test('AIDash 服务：启动、健康检查、停止', async () => {
  const root = tempDir('am-proc-repo-');
  fs.mkdirSync(path.join(root, 'server', 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'dist', 'server', 'main.js'), FAKE_SERVER);
  const home = tempDir('am-proc-store-');
  const data = tempDir('am-proc-data-');
  const store = new ManagerStore({ home }).init();
  const port = await freePort();
  const service = await createServiceWithFiles(store, {
    type: 'aidash',
    name: '进程测试',
    cwd: root,
    token: 'test-token-123',
    spec: {
      host: '127.0.0.1',
      port,
      tokenSource: 'manager',
      dbPath: path.join(data, 'a.db'),
      backupDir: path.join(data, 'backups'),
      staticDir: path.join(root, 'web'),
    },
  });
  assert.equal((await getAidashRuntime(store, service)).state, 'stopped');
  try {
    const runtime = await startAidash(store, service);
    assert.equal(runtime.state, 'running');
    assert.ok(runtime.pid > 0);
    assert.equal(runtime.port, port);
    const stopped = await stopAidash(store, service, { force: true });
    assert.equal(stopped.already_stopped, false);
    assert.equal((await getAidashRuntime(store, service)).state, 'stopped');
  } finally {
    await stopAidash(store, service, { force: true }).catch(() => {});
  }
});

test('数据目录启动 AIDash：程序来自管理台（AIDASH_APP_DIR），数据落在数据目录', async () => {
  const programRoot = tempDir('am-proc-program-');
  fs.mkdirSync(path.join(programRoot, 'server', 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(programRoot, 'server', 'dist', 'server', 'main.js'), FAKE_SERVER);
  fs.mkdirSync(path.join(programRoot, 'server', 'dist', 'web'), { recursive: true });
  const dataDir = tempDir('am-proc-datadir-');
  const store = new ManagerStore({ home: tempDir('am-proc-store-data-') }).init();
  const port = await freePort();
  const previous = process.env.AIDASH_APP_DIR;
  process.env.AIDASH_APP_DIR = programRoot;
  let service;
  try {
    service = await createServiceWithFiles(store, {
      type: 'aidash',
      name: '数据目录服务',
      cwd: dataDir,
      token: 'test-token-123',
      spec: { host: '127.0.0.1', port, tokenSource: 'manager' },
    });
    assert.equal(service.aidash.serverEntry, path.join(programRoot, 'server', 'dist', 'server', 'main.js'));
    assert.equal(service.aidash.dbPath, path.join(dataDir, 'data', 'aidash.db'));
    assert.equal(service.aidash.programSource, 'env');
    const runtime = await startAidash(store, service);
    assert.equal(runtime.state, 'running');
    assert.equal(runtime.health.db_path, path.join(dataDir, 'data', 'aidash.db'));
    await stopAidash(store, service, { force: true });
  } finally {
    if (previous === undefined) delete process.env.AIDASH_APP_DIR;
    else process.env.AIDASH_APP_DIR = previous;
    if (service) await stopAidash(store, service, { force: true }).catch(() => {});
  }
});

test('启动旧记录时修复配置文件里旧版本写入的猜测路径', async () => {
  const programRoot = tempDir('am-proc-program2-');
  fs.mkdirSync(path.join(programRoot, 'server', 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(programRoot, 'server', 'dist', 'server', 'main.js'), FAKE_CONFIG_SERVER);
  fs.mkdirSync(path.join(programRoot, 'server', 'dist', 'web'), { recursive: true });
  fs.mkdirSync(path.join(programRoot, '00-platform', 'config', 'schema'), { recursive: true });
  fs.writeFileSync(path.join(programRoot, '00-platform', 'config', 'schema', 'aidash-config.schema.json'), '{}');
  const dataDir = tempDir('am-proc-datadir2-');
  const store = new ManagerStore({ home: tempDir('am-proc-store-data2-') }).init();
  const port = await freePort();
  const guessed = aidashLayoutCandidates(dataDir)[1];
  const configPath = path.join(dataDir, 'aidash.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      host: '127.0.0.1',
      port,
      db_path: guessed.dbPath,
      backup_dir: guessed.backupDir,
      static_dir: guessed.staticDir,
      log_level: 'info',
    }),
  );
  const service = createService(
    {
      type: 'aidash',
      name: '旧记录',
      cwd: dataDir,
      spec: {
        host: '127.0.0.1',
        port,
        tokenSource: 'manager',
        configMode: 'file',
        configPath,
        appDir: programRoot,
        serverEntry: guessed.serverEntry,
        dbPath: guessed.dbPath,
        backupDir: guessed.backupDir,
        staticDir: guessed.staticDir,
        layoutMatched: false,
      },
    },
    { store },
  );
  store.addService(service);
  store.setSecret(service.id, 'test-token-123');
  try {
    const runtime = await startAidash(store, service);
    assert.equal(runtime.state, 'running');
    const repaired = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(repaired.static_dir, path.join(programRoot, 'server', 'dist', 'web'));
    assert.equal(repaired.db_path, path.join(dataDir, 'data', 'aidash.db'));
    assert.equal(repaired.backup_dir, path.join(dataDir, 'backups'));
  } finally {
    await stopAidash(store, service, { force: true }).catch(() => {});
  }
});

test('端口被占用时不启动 AIDash', async () => {
  const root = tempDir('am-proc-repo2-');
  fs.mkdirSync(path.join(root, 'server', 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'dist', 'server', 'main.js'), FAKE_SERVER);
  const store = new ManagerStore({ home: tempDir('am-proc-store2-') }).init();
  const port = await freePort();
  const blocker = await startBlocker(port);
  try {
    const service = await createServiceWithFiles(store, {
      type: 'aidash',
      name: '端口冲突',
      cwd: root,
      token: 'test-token-123',
      spec: { host: '127.0.0.1', port, tokenSource: 'manager' },
    });
    const error = await startAidash(store, service).then(
      () => assert.fail('端口被占用时不应启动成功'),
      (err) => err,
    );
    assert.equal(error.name, 'ManagerError');
    assert.equal(error.code, 'PORT_IN_USE');
    assert.equal(error.status, 409);
    assert.match(error.message, new RegExp(`端口 127\\.0\\.0\\.1:${port} 已被占用`));
    assert.match(error.message, /EADDRINUSE/);
    // 端口检查在拉起进程之前完成：不能留下 PID 状态，更不能起子进程。
    assert.equal(store.readRunState(service.id), null);
  } finally {
    await blocker.close();
  }
});

test('健康探测对不响应的端口有超时上界，不会挂起', async () => {
  const root = tempDir('am-proc-repo3-');
  fs.mkdirSync(path.join(root, 'server', 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'dist', 'server', 'main.js'), FAKE_SERVER);
  const store = new ManagerStore({ home: tempDir('am-proc-store3-') }).init();
  const port = await freePort();
  const blocker = await startBlocker(port);
  try {
    const service = await createServiceWithFiles(store, {
      type: 'aidash',
      name: '探测超时',
      cwd: root,
      token: 'test-token-123',
      spec: { host: '127.0.0.1', port, tokenSource: 'manager' },
    });
    const startedAt = Date.now();
    const runtime = await getAidashRuntime(store, service);
    const elapsed = Date.now() - startedAt;
    assert.equal(runtime.state, 'stopped');
    assert.equal(runtime.alive, false);
    assert.ok(runtime.health.error, '探测失败时应给出错误原因');
    assert.ok(elapsed < 5_000, `健康探测应在超时预算内返回，实际耗时 ${elapsed}ms`);
  } finally {
    await blocker.close();
  }
});

test('runner 启动参数包含创建/复用通道（--ensure-channel / --channel-title）', () => {
  const service = {
    runner: {
      configPath: 'C:/work/runner.json',
      ensureChannel: 'devhost/demo/d2611',
      channelTitle: '演示通道',
    },
  };
  const args = buildRunnerStartArgs(service, { dataDir: 'C:/work/data' }, {
    command: process.execPath,
    args_prefix: ['C:/runner/aidash-runner.mjs'],
  });
  assert.deepEqual(args, [
    'C:/runner/aidash-runner.mjs',
    'start',
    '--daemon',
    '--config',
    'C:/work/runner.json',
    '--data-dir',
    'C:/work/data',
    '--ensure-channel',
    'devhost/demo/d2611',
    '--channel-title',
    '演示通道',
  ]);

  // 未配置创建通道时不能凭空加参数：现有 runner 的启动行为必须保持不变。
  const plain = buildRunnerStartArgs(
    { runner: { configPath: 'C:/work/runner.json' } },
    { dataDir: 'C:/work/data' },
    { args_prefix: ['C:/runner/aidash-runner.mjs'] },
  );
  assert.equal(plain.includes('--ensure-channel'), false);
  assert.equal(plain.includes('--channel-title'), false);
});
