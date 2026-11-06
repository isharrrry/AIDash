import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ManagerStore } from '../src/store.js';
import { startManagerServer } from '../src/server.js';

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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

/** 模拟“不是管理台拉起、但端口上确实活着”的外部 AIDash。 */
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
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 静态页夹具：前端产物 web-dist 是构建产物（已 gitignore），测试不能依赖它存在。 */
function makeWebDist() {
  const dir = tempDir('am-api-webdist-');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
  return dir;
}

async function withServer(fn, { webDist = makeWebDist() } = {}) {
  const home = tempDir('am-api-');
  const root = tempDir('am-api-repo-');
  fs.mkdirSync(path.join(root, 'server', 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'dist', 'server', 'main.js'), '');
  const store = new ManagerStore({ home }).init();
  const started = await startManagerServer({ store, host: '127.0.0.1', port: 0, webDist });
  const call = async (pathname, { method = 'GET', body, token = true, cookie } = {}) => {
    const headers = { accept: 'application/json' };
    if (token) headers['x-aidash-manager-token'] = started.token;
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${started.url}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed, headers: response.headers, text };
  };
  try {
    await fn({ store, started, call, root });
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
}

test('未带令牌的 API 返回 401，静态页面可打开', async () => {
  await withServer(async ({ call, started }) => {
    assert.equal((await call('/api/state', { token: false })).status, 401);
    assert.equal((await call('/api/state')).status, 200);
    const index = await fetch(`${started.url}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<div id="root">/);
    const redirect = await fetch(`${started.url}/?token=${started.token}`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get('set-cookie') ?? '', /aidash_manager_token=/);
  });
});

test('web-dist 缺失时返回占位页而不是 404', async () => {
  const emptyDir = path.join(tempDir('am-api-nodist-'), 'absent');
  await withServer(async ({ started }) => {
    const index = await fetch(`${started.url}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Web 前端尚未构建/);
  }, { webDist: emptyDir });
});

test('端口探测：空闲端口可用，已占用端口返回 EADDRINUSE', async () => {
  await withServer(async ({ call }) => {
    const free = await freePort();
    const freeResult = await call(`/api/ports?host=127.0.0.1&port=${free}`);
    assert.equal(freeResult.status, 200);
    assert.equal(freeResult.body.data.available, true);

    const blockedPort = await freePort();
    const blocker = await startExternalHealth(blockedPort);
    try {
      const blocked = await call(`/api/ports?host=127.0.0.1&port=${blockedPort}`);
      assert.equal(blocked.status, 200);
      assert.equal(blocked.body.data.available, false);
      assert.equal(blocked.body.data.reason, 'EADDRINUSE');
    } finally {
      await blocker.close();
    }

    assert.equal((await call('/api/ports?port=0')).status, 400);
  });
});

test('创建、读取、更新、删除 AIDash 服务', async () => {
  await withServer(async ({ call, root }) => {
    const created = await call('/api/services', {
      method: 'POST',
      body: {
        type: 'aidash',
        name: '测试 AIDash',
        cwd: root,
        token: 'test-token-123',
        spec: { port: 8899, tokenSource: 'manager' },
      },
    });
    assert.equal(created.status, 201);
    const service = created.body.data;
    assert.equal(service.runtime.state, 'stopped');
    assert.equal(service.aidash.hasToken, true);
    assert.equal(service.aidash.serverEntry, path.join(root, 'server', 'dist', 'server', 'main.js'));

    const config = await call(`/api/services/${service.id}/config`);
    assert.equal(config.status, 200);
    assert.equal(config.body.data.mode, 'env');

    const saved = await call(`/api/services/${service.id}/config`, {
      method: 'PUT',
      body: { mode: 'file', config: { host: '127.0.0.1', port: 8898, db_path: path.join(root, 'data.db') } },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.config.file.raw.port, 8898);
    assert.equal(saved.body.data.service.runtime.port, 8898);

    const missing = await call('/api/services', {
      method: 'POST',
      body: { type: 'aidash', name: '缺令牌', cwd: root, spec: { tokenSource: 'manager' } },
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error.message, /TOKEN/);

    const removed = await call(`/api/services/${service.id}?force=true`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal((await call('/api/state')).body.data.services.length, 0);
  });
});

test('创建 runner：生成模板配置，重复配置路径需要显式复用', async () => {
  await withServer(async ({ call, root }) => {
    const configPath = path.join(root, 'runner.json');
    const payload = {
      type: 'runner',
      name: '测试 Runner',
      cwd: root,
      token: 'test-token-123',
      spec: {
        template: 'dsh',
        harnessId: 'dsh-test',
        configPath,
        dataDir: path.join(root, 'runner-data'),
        logFile: path.join(root, 'runner.log'),
        match: { matchAll: true },
      },
    };
    const created = await call('/api/services', { method: 'POST', body: payload });
    assert.equal(created.status, 201);
    const service = created.body.data;
    const config = await call(`/api/services/${service.id}/config`);
    assert.equal(config.status, 200);
    assert.equal(config.body.data.file.raw.commands[0].run.argv[0], 'dsh');
    assert.equal(config.body.data.file.raw.harness_id, 'dsh-test');
    assert.match(config.body.data.file.raw.commands[0].run.result_file, /dsh-result\.json$/);

    const applied = await call(`/api/services/${service.id}/config/template`, {
      method: 'POST',
      body: { templateKey: 'narnat' },
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.data.config.file.raw.commands[0].run.argv[0], 'narnat');
    assert.equal(applied.body.data.config.file.raw.harness_id, 'dsh-test');
    assert.equal(applied.body.data.config.file.raw.data_dir, path.join(root, 'runner-data'));

    const duplicate = await call('/api/services', {
      method: 'POST',
      body: {
        ...payload,
        name: '第二个',
        spec: { ...payload.spec, harnessId: 'dsh-test-2', dataDir: path.join(root, 'runner-data-2') },
      },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'CONFIG_EXISTS');

    const reuseConflict = await call('/api/services', {
      method: 'POST',
      body: {
        ...payload,
        name: '复用冲突',
        useExistingConfig: true,
        spec: {
          ...payload.spec,
          harnessId: 'dsh-test-3',
          configPath,
          dataDir: path.join(root, 'runner-data-3'),
        },
      },
    });
    assert.equal(reuseConflict.status, 409);
    assert.equal(reuseConflict.body.error.code, 'HARNESS_ID_CONFLICT');

    // data_dir 是 runner 的 registry/会话目录，两个服务共用会互相踩踏。
    const sharedDataDir = await call('/api/services', {
      method: 'POST',
      body: {
        ...payload,
        name: '共享数据目录',
        spec: {
          ...payload.spec,
          harnessId: 'dsh-test-4',
          configPath: path.join(root, 'shared-runner.json'),
          dataDir: path.join(root, 'runner-data'),
        },
      },
    });
    assert.equal(sharedDataDir.status, 409);
    assert.equal(sharedDataDir.body.error.code, 'DATA_DIR_CONFLICT');

    // 换一个已有配置来验证“复用现有配置”本身：harness_id 以文件为准。
    const adoptedPath = path.join(root, 'adopted-runner.json');
    fs.writeFileSync(
      adoptedPath,
      JSON.stringify({
        aidash_url: 'http://127.0.0.1:8787/mcp',
        token_env: 'AIDASH_TOKEN',
        harness_id: 'adopted-dsh',
        name: 'adopted',
        channels: [],
        data_dir: path.join(root, 'adopted-data'),
        commands: [
          {
            name: 'adopted',
            match: { match_all: true },
            run: { argv: ['dsh', '--profile', 'headless', '{task_file}', '{result_file}'], input: 'file' },
          },
        ],
      }),
    );
    const reused = await call('/api/services', {
      method: 'POST',
      body: {
        ...payload,
        name: '复用配置',
        useExistingConfig: true,
        spec: {
          ...payload.spec,
          harnessId: 'dsh-test-3',
          configPath: adoptedPath,
          dataDir: path.join(root, 'runner-data-4'),
        },
      },
    });
    assert.equal(reused.status, 201);
    assert.equal(reused.body.data.runner.harnessId, 'adopted-dsh');

    // 配置文件被手工删除后，另一个服务也不能静默接管同一路径（否则先建的服务
    // 下次启动会读到后建者的 harness_id/命令）。
    fs.rmSync(adoptedPath);
    const pathConflict = await call('/api/services', {
      method: 'POST',
      body: {
        ...payload,
        name: '路径冲突',
        spec: {
          ...payload.spec,
          harnessId: 'dsh-test-5',
          configPath: adoptedPath,
          dataDir: path.join(root, 'runner-data-5'),
        },
      },
    });
    assert.equal(pathConflict.status, 409);
    assert.equal(pathConflict.body.error.code, 'CONFIG_PATH_CONFLICT');

    const state = await call('/api/state');
    assert.equal(state.body.data.services.length, 2);
  });
});

test('外部登记：拒绝停止，但允许只移除记录且不触碰外部进程', async () => {
  await withServer(async ({ call, root }) => {
    const port = await freePort();
    const external = await startExternalHealth(port);
    try {
      const created = await call('/api/services', {
        method: 'POST',
        body: {
          type: 'aidash',
          name: '外部实例',
          cwd: root,
          token: 'test-token-123',
          spec: { host: '127.0.0.1', port, tokenSource: 'manager' },
        },
      });
      assert.equal(created.status, 201);
      const service = created.body.data;
      assert.equal(service.runtime.state, 'external');
      assert.equal(service.runtime.pid, null);

      const stopped = await call(`/api/services/${service.id}/stop`, { method: 'POST', body: {} });
      assert.equal(stopped.status, 409);
      assert.equal(stopped.body.error.code, 'EXTERNAL_PROCESS');

      // 删除外部登记不能走“先停止”的路径，否则记录永远删不掉。
      const removed = await call(`/api/services/${service.id}`, { method: 'DELETE' });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.equal(removed.body.data.removed, service.id);
      assert.equal(removed.body.data.external, true);
      assert.equal((await call('/api/state')).body.data.services.length, 0);

      // 外部进程必须还在响应。
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(health.status, 200);
    } finally {
      await external.close();
    }
  });
});

test('文件模式创建因重名失败时不留下配置文件', async () => {
  await withServer(async ({ call, root }) => {
    const firstPort = await freePort();
    const first = await call('/api/services', {
      method: 'POST',
      body: {
        type: 'aidash',
        name: '重名服务',
        cwd: root,
        token: 'test-token-123',
        spec: { host: '127.0.0.1', port: firstPort, tokenSource: 'manager' },
      },
    });
    assert.equal(first.status, 201);

    const configPath = path.join(root, 'dup-aidash.config.json');
    const second = await call('/api/services', {
      method: 'POST',
      body: {
        type: 'aidash',
        name: '重名服务',
        cwd: root,
        token: 'test-token-123',
        spec: {
          host: '127.0.0.1',
          port: await freePort(),
          tokenSource: 'manager',
          configMode: 'file',
          configPath,
        },
      },
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'SERVICE_NAME_CONFLICT');
    assert.equal(fs.existsSync(configPath), false, '创建失败不应留下配置文件');
  });
});
