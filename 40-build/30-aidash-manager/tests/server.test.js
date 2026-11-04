import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ManagerStore } from '../src/store.js';
import { formatHostForUrl, startManagerServer } from '../src/server.js';

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
 * 端口占用用的 blocker：只监听不响应。测试结束显式 destroy 连接，
 * 否则 close() 会等一个永远不会来的 FIN（见 process.test.js 的说明）。
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
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function closeServer(started) {
  started.server.closeAllConnections?.();
  await new Promise((resolve) => started.server.close(resolve));
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('formatHostForUrl：通配地址换成回环，IPv6 加方括号', () => {
  assert.equal(formatHostForUrl('0.0.0.0'), '127.0.0.1');
  assert.equal(formatHostForUrl('::'), '127.0.0.1');
  assert.equal(formatHostForUrl('::1'), '[::1]');
  assert.equal(formatHostForUrl('127.0.0.1'), '127.0.0.1');
  assert.equal(formatHostForUrl('localhost'), 'localhost');
});

test('端口回退：占用时向后找，strictPort 时直接报错', async () => {
  const store = new ManagerStore({ home: tempDir('am-srv-port-') }).init();
  const port = await freePort();
  const blocker = await startBlocker(port);
  try {
    const started = await startManagerServer({ store, host: '127.0.0.1', port, strictPort: false });
    try {
      assert.notEqual(started.port, port);
      assert.ok(started.port > port, `应换到后面的端口，实际 ${started.port}`);
      assert.equal(started.url, `http://127.0.0.1:${started.port}`);
      assert.equal((await fetch(`${started.url}/healthz`)).status, 200);
      assert.equal(store.readWebRuntime().port, started.port);
    } finally {
      await closeServer(started);
    }

    await assert.rejects(
      startManagerServer({ store, host: '127.0.0.1', port, strictPort: true }),
      (error) => {
        assert.equal(error.name, 'ManagerError');
        assert.equal(error.code, 'LISTEN_FAILED');
        assert.match(error.message, /EADDRINUSE/);
        return true;
      },
    );
  } finally {
    await blocker.close();
  }
});

test('通配监听地址：bind 所有网卡，提示 URL 仍是可连接的 127.0.0.1', async () => {
  const store = new ManagerStore({ home: tempDir('am-srv-host-') }).init();
  const started = await startManagerServer({ store, host: '0.0.0.0', port: 0 });
  try {
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(store.readWebRuntime().url, started.url);
    assert.equal((await fetch(`${started.url}/healthz`)).status, 200);
  } finally {
    await closeServer(started);
  }
});

test('鉴权链路：?token= 换 HttpOnly Cookie 后 API 可访问；无/错令牌 401', async () => {
  const store = new ManagerStore({ home: tempDir('am-srv-auth-') }).init();
  const started = await startManagerServer({ store, host: '127.0.0.1', port: 0 });
  try {
    const token = store.webToken();
    const redirect = await fetch(`${started.url}/?token=${token}`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/');
    const setCookie = redirect.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /aidash_manager_token=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Max-Age=604800/);
    const cookie = setCookie.split(';')[0];

    assert.equal((await fetch(`${started.url}/api/state`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${started.url}/api/state`)).status, 401);
    assert.equal(
      (await fetch(`${started.url}/api/state`, { headers: { 'x-aidash-manager-token': 'wrong-token' } })).status,
      401,
    );
    assert.equal((await fetch(`${started.url}/?token=wrong-token`, { redirect: 'manual' })).status, 401);
    // 页面壳本身允许打开（前端会在 API 401 时显示令牌输入框）。
    assert.equal((await fetch(`${started.url}/`)).status, 200);
  } finally {
    await closeServer(started);
  }
});
