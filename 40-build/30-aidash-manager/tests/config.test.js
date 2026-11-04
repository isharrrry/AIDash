import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AIDASH_CORE_FIELDS,
  mergeServiceIntoConfig,
  readAidashConfigFile,
  validateAidashConfig,
  writeAidashConfigFile,
} from '../src/aidash-config.js';
import {
  buildRunnerConfig,
  readRunnerConfigFile,
  validateRunnerConfig,
  writeRunnerConfigFile,
} from '../src/runner-config.js';
import { createService } from '../src/service.js';
import { ManagerStore } from '../src/store.js';

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('AIDash 配置：合法键通过，未知键与类型错误被拒绝', () => {
  assert.deepEqual(validateAidashConfig({ host: '127.0.0.1', port: 8787 }), []);
  const unknown = validateAidashConfig({ host: '127.0.0.1', prot: 8787 });
  assert.equal(unknown.length, 1);
  assert.match(unknown[0], /prot/);
  const badPort = validateAidashConfig({ port: 70000 });
  assert.ok(badPort.some((item) => /不能大于/.test(item)));
  const badLlm = validateAidashConfig({ llm: { api_key: 'x' } });
  assert.ok(badLlm.some((item) => /api_key/.test(item)));
});

test('AIDash 配置：token 不允许写进文件', () => {
  const dir = tempDir('am-cfg-');
  const file = path.join(dir, 'aidash.config.json');
  fs.writeFileSync(file, JSON.stringify({ token: 'secret' }));
  const view = readAidashConfigFile(file);
  assert.ok(view.errors.some((item) => /token/.test(item)));
});

test('AIDash 配置：写入前校验，非法文件不会落盘', () => {
  const dir = tempDir('am-cfg-');
  const file = path.join(dir, 'aidash.config.json');
  assert.throws(() => writeAidashConfigFile(file, { nope: 1 }), /校验未通过/);
  assert.equal(fs.existsSync(file), false);
  writeAidashConfigFile(file, { host: '127.0.0.1', port: 9000, db_path: './data.db' });
  const view = readAidashConfigFile(file);
  assert.deepEqual(view.errors, []);
  assert.equal(view.raw.port, 9000);
});

test('AIDash 常用字段覆盖核心键', () => {
  const keys = new Set(AIDASH_CORE_FIELDS.map((item) => item.key));
  for (const key of ['host', 'port', 'db_path', 'backup_dir', 'static_dir', 'log_level']) {
    assert.ok(keys.has(key), `缺少字段 ${key}`);
  }
  const merged = mergeServiceIntoConfig(
    {
      aidash: {
        host: '127.0.0.1',
        port: 8787,
        dbPath: 'D:/x/a.db',
        backupDir: 'D:/x/backups',
        staticDir: 'D:/x/web',
        logLevel: 'debug',
      },
    },
    { kb_root: 'D:/kb' },
  );
  assert.equal(merged.kb_root, 'D:/kb');
  assert.equal(merged.db_path, 'D:/x/a.db');
  assert.equal(merged.log_level, 'debug');
});

test('Runner 配置：match_all 规则与缺失条件', () => {
  const base = {
    aidash_url: 'http://127.0.0.1:8787/mcp',
    harness_id: 'claude-test',
    commands: [
      {
        name: 'x',
        match: { match_all: true },
        run: { argv: ['claude', '-p', '{task_file}', '{result_file}'], input: 'file' },
      },
    ],
  };
  const ok = validateRunnerConfig(base);
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.warnings.some((item) => /match_all/.test(item)));
  const bad = validateRunnerConfig({
    ...base,
    commands: [{ name: 'x', match: {}, run: { argv: ['x'] } }],
  });
  assert.ok(bad.errors.some((item) => /match_all=true/.test(item)));
  const missingArgv = validateRunnerConfig({ ...base, commands: [{ name: 'x', match: { match_all: true }, run: {} }] });
  assert.ok(missingArgv.errors.some((item) => /argv/.test(item)));
});

test('Runner 配置：生成、写盘、读回', () => {
  const dir = tempDir('am-runner-');
  const store = new ManagerStore({ home: tempDir('am-store-') }).init();
  const service = createService(
    {
      type: 'runner',
      name: 'runner-test',
      cwd: dir,
      spec: {
        template: 'codex',
        harnessId: 'codex-test',
        tokenSource: 'env',
        configPath: path.join(dir, 'runner.json'),
        dataDir: path.join(dir, 'data'),
        logFile: path.join(dir, 'runner.log'),
        match: { matchAll: true },
      },
    },
    { store },
  );
  const config = buildRunnerConfig(service);
  assert.equal(config.harness_id, 'codex-test');
  assert.equal(config.commands[0].run.argv[0], 'codex');
  // runner 会拒绝“argv 用了 {result_file} 却没配置 result_file”的规则。
  assert.match(config.commands[0].run.result_file, /codex-result\.json$/);
  writeRunnerConfigFile(service.runner.configPath, config);
  const read = readRunnerConfigFile(service.runner.configPath);
  assert.equal(read.exists, true);
  assert.deepEqual(read.errors, []);
  assert.equal(read.raw.capabilities[0], 'codex');
});
