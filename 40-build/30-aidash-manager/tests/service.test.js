import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManagerStore } from '../src/store.js';
import { aidashLayoutCandidates } from '../src/constants.js';
import {
  assertRunnerConfigPathUnused,
  createService,
  findAidashProgram,
  normalizeAidashSpec,
  normalizeRunnerSpec,
  sanitizeInstanceId,
  updateService,
} from '../src/service.js';

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeRepo() {
  const root = tempDir('am-repo-');
  fs.mkdirSync(path.join(root, 'server', 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'dist', 'server', 'main.js'), '');
  fs.mkdirSync(path.join(root, 'server', 'dist', 'web'), { recursive: true });
  return root;
}

function newStore() {
  return new ManagerStore({ home: tempDir('am-store-') }).init();
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('AIDash 默认布局按部署目录探测', () => {
  const root = fakeRepo();
  const store = newStore();
  const service = createService(
    {
      type: 'aidash',
      name: '本地服务',
      cwd: root,
      spec: { port: '8899', tokenSource: 'env' },
    },
    { store },
  );
  assert.equal(service.aidash.serverEntry, path.join(root, 'server', 'dist', 'server', 'main.js'));
  assert.equal(service.aidash.staticDir, path.join(root, 'server', 'dist', 'web'));
  assert.equal(service.aidash.port, 8899);
  assert.equal(service.aidash.configMode, 'env');
  assert.equal(service.aidash.configPath, path.join(root, 'aidash.config.json'));
});

function fakeProgram() {
  const root = tempDir('am-program-');
  fs.mkdirSync(path.join(root, 'server', 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'dist', 'server', 'main.js'), '');
  fs.mkdirSync(path.join(root, 'server', 'dist', 'web'), { recursive: true });
  return root;
}

test('只有数据目录时，程序由管理台提供（AIDASH_APP_DIR），数据落在工作目录', () => {
  const programRoot = fakeProgram();
  const dataDir = tempDir('am-data-');
  const store = newStore();
  const previous = process.env.AIDASH_APP_DIR;
  process.env.AIDASH_APP_DIR = programRoot;
  try {
    const service = createService(
      { type: 'aidash', name: '纯数据服务', cwd: dataDir, spec: { port: '8899', tokenSource: 'env' } },
      { store },
    );
    assert.equal(service.aidash.serverEntry, path.join(programRoot, 'server', 'dist', 'server', 'main.js'));
    assert.equal(service.aidash.staticDir, path.join(programRoot, 'server', 'dist', 'web'));
    assert.equal(service.aidash.appDir, programRoot);
    assert.equal(service.aidash.programSource, 'env');
    assert.equal(service.aidash.programMatched, true);
    // 数据（库/备份/配置）在服务工作目录；程序目录不会被当成数据目录。
    assert.equal(service.aidash.dbPath, path.join(dataDir, 'data', 'aidash.db'));
    assert.equal(service.aidash.backupDir, path.join(dataDir, 'backups'));
    assert.equal(service.aidash.configPath, path.join(dataDir, 'aidash.config.json'));
    assert.equal(service.aidash.layoutMatched, false);
  } finally {
    if (previous === undefined) delete process.env.AIDASH_APP_DIR;
    else process.env.AIDASH_APP_DIR = previous;
  }
});

test('已登记服务的程序可被新的数据目录复用', () => {
  const programRoot = fakeRepo();
  const dataDir = tempDir('am-data-reuse-');
  const store = newStore();
  const first = createService(
    { type: 'aidash', name: '已有程序', cwd: programRoot, spec: { tokenSource: 'env' } },
    { store },
  );
  store.addService(first);
  const found = findAidashProgram({ cwd: dataDir, store, searchManager: false });
  assert.equal(found.serverEntry, path.join(programRoot, 'server', 'dist', 'server', 'main.js'));
  assert.equal(found.source, 'service:已有程序');
});

test('旧版猜在数据目录里的 source 路径会被丢弃并重新解析', () => {
  const programRoot = fakeProgram();
  const dataDir = tempDir('am-data-legacy-');
  const store = newStore();
  const guessed = aidashLayoutCandidates(dataDir)[1];
  const previous = process.env.AIDASH_APP_DIR;
  process.env.AIDASH_APP_DIR = programRoot;
  try {
    const service = createService(
      {
        type: 'aidash',
        name: '修复旧记录',
        cwd: dataDir,
        spec: {
          tokenSource: 'env',
          configMode: 'file',
          serverEntry: guessed.serverEntry,
          dbPath: guessed.dbPath,
          backupDir: guessed.backupDir,
          staticDir: guessed.staticDir,
          layoutMatched: false,
        },
      },
      { store },
    );
    assert.equal(service.aidash.serverEntry, path.join(programRoot, 'server', 'dist', 'server', 'main.js'));
    assert.equal(service.aidash.staticDir, path.join(programRoot, 'server', 'dist', 'web'));
    assert.equal(service.aidash.dbPath, path.join(dataDir, 'data', 'aidash.db'));
    assert.equal(service.aidash.backupDir, path.join(dataDir, 'backups'));
  } finally {
    if (previous === undefined) delete process.env.AIDASH_APP_DIR;
    else process.env.AIDASH_APP_DIR = previous;
  }
});

test('名称必填且不能重名', () => {
  const root = fakeRepo();
  const store = newStore();
  assert.throws(() => createService({ type: 'aidash', name: '  ', cwd: root, spec: {} }, { store }), /名称必填/);
  const first = createService({ type: 'aidash', name: '同名', cwd: root, spec: { tokenSource: 'env' } }, { store });
  store.addService(first);
  const second = createService({ type: 'aidash', name: '同名', cwd: root, spec: { tokenSource: 'env' } }, { store });
  assert.throws(() => store.addService(second), /名称已存在/);
});

test('Runner 默认配置路径与数据目录按服务隔离', () => {
  const root = fakeRepo();
  const store = newStore();
  const service = createService(
    {
      type: 'runner',
      name: 'Claude 值守',
      cwd: root,
      spec: { template: 'claude', harnessId: 'claude-test', tokenSource: 'env', match: { matchAll: true } },
    },
    { store },
  );
  assert.equal(service.runner.configPath, path.join(root, 'aidash-runner.claude-test.json'));
  assert.ok(service.runner.dataDir.startsWith(store.serviceDir(service.id)));
  assert.equal(service.runner.template, 'claude');
  assert.equal(service.runner.matchAll, undefined);
  assert.equal(service.runner.match.matchAll, true);
});

test('harness_id 与端口范围被校验', () => {
  const root = fakeRepo();
  const store = newStore();
  assert.throws(
    () =>
      createService(
        { type: 'runner', name: 'r', cwd: root, spec: { template: 'claude', harnessId: '含 空格', tokenSource: 'env' } },
        { store },
      ),
    /harness_id/,
  );
  assert.throws(
    () => normalizeAidashSpec({ port: 70000 }, { cwd: root }),
    /端口/,
  );
});

test('局部更新保留未提交的字段', () => {
  const root = fakeRepo();
  const store = newStore();
  const service = createService(
    { type: 'aidash', name: '更新测试', cwd: root, spec: { port: 8899, tokenSource: 'env', host: '127.0.0.1' } },
    { store },
  );
  const updated = updateService(service, { spec: { port: 8898 } }, { store });
  assert.equal(updated.aidash.port, 8898);
  assert.equal(updated.aidash.host, '127.0.0.1');
});

test('runner 未勾选 match_all 时必须至少一个匹配条件', () => {
  const root = fakeRepo();
  const store = newStore();
  assert.throws(
    () => normalizeRunnerSpec({ match: { matchAll: false } }, { cwd: root, store, serviceId: 'svc_x' }),
    /匹配条件/,
  );
});

test('runner 的 data_dir 必须与已有服务隔离', () => {
  const root = fakeRepo();
  const store = newStore();
  const first = createService(
    {
      type: 'runner',
      name: '第一个',
      cwd: root,
      spec: {
        template: 'claude',
        harnessId: 'claude-first',
        tokenSource: 'env',
        configPath: path.join(root, 'first.json'),
        dataDir: path.join(root, 'shared-data'),
      },
    },
    { store },
  );
  store.addService(first);
  assert.throws(
    () =>
      createService(
        {
          type: 'runner',
          name: '第二个',
          cwd: root,
          spec: {
            template: 'claude',
            harnessId: 'claude-second',
            tokenSource: 'env',
            configPath: path.join(root, 'second.json'),
            dataDir: path.join(root, 'shared-data'),
          },
        },
        { store },
      ),
    /数据目录已被服务.*第一个.*使用/,
  );
});

test('runner 配置文件路径不能与已有服务重复（即使文件被删）', () => {
  const root = fakeRepo();
  const store = newStore();
  const first = createService(
    {
      type: 'runner',
      name: '第一个',
      cwd: root,
      spec: {
        template: 'claude',
        harnessId: 'claude-first',
        tokenSource: 'env',
        configPath: path.join(root, 'shared-runner.json'),
      },
    },
    { store },
  );
  store.addService(first);
  assert.throws(
    () => assertRunnerConfigPathUnused(store, path.join(root, 'shared-runner.json'), 'another-id'),
    /配置文件已被服务.*第一个.*使用/,
  );
  // 自己改自己的配置路径不算冲突。
  assert.doesNotThrow(() =>
    assertRunnerConfigPathUnused(store, path.join(root, 'shared-runner.json'), first.id),
  );
});

test('instance id 与 runner 的清洗规则一致', () => {
  assert.equal(sanitizeInstanceId('a b/c'), 'a-b-c');
  assert.equal(sanitizeInstanceId('...'), '-');
});

test('runner 创建/复用通道：精确 key 与标题被保存并校验', () => {
  const root = fakeRepo();
  const store = newStore();
  const service = createService(
    {
      type: 'runner',
      name: '通道 Runner',
      cwd: root,
      spec: {
        template: 'claude',
        harnessId: 'claude-channel',
        tokenSource: 'env',
        channels: ['devhost/demo/d2611'],
        ensureChannel: 'devhost/demo/d2611',
        channelTitle: '演示通道',
      },
    },
    { store },
  );
  assert.equal(service.runner.ensureChannel, 'devhost/demo/d2611');
  assert.equal(service.runner.channelTitle, '演示通道');

  // 通道 key 与 runner 自身的规则一致：不允许空白等字符。
  assert.throws(
    () =>
      normalizeRunnerSpec(
        { ensureChannel: 'bad key', tokenSource: 'env' },
        { cwd: root, store, serviceId: 'svc_x' },
      ),
    /ASCII/,
  );
  // 标题不能单独存在：否则启动时既不会建通道，也没地方用标题。
  assert.throws(
    () =>
      normalizeRunnerSpec(
        { channelTitle: '只有一个标题', tokenSource: 'env' },
        { cwd: root, store, serviceId: 'svc_x' },
      ),
    /必须配合/,
  );

  // 局部更新（例如在配置页只改令牌）不能把通道字段清掉。
  const updated = updateService(service, { spec: { tokenEnv: 'AIDASH_TOKEN' } }, { store });
  assert.equal(updated.runner.ensureChannel, 'devhost/demo/d2611');
  assert.equal(updated.runner.channelTitle, '演示通道');
});
