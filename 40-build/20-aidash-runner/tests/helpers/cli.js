import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../../src/exec.js';
import { inspectRegistryEntry, readRegistryEntry } from '../../src/registry.js';
import { isPidAlive, sleep } from '../../src/util.js';

/** 所有集成测试共用的 CLI 启动器。 */

export const BIN = fileURLToPath(new URL('../../bin/aidash-runner.mjs', import.meta.url));
export const DEFAULT_FAKE_TOKEN = 'fake-aidash-token-1234567890';

export function makeTempDir(prefix = 'aidash-runner-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 构造子进程环境：
 * - 清掉所有 AIDASH_*，避免开发机上真实令牌/配置泄漏进测试；
 * - USERPROFILE/HOME 指向临时目录，保证 os.homedir() 不会读到用户的 ~/.aidash；
 * - 默认塞一个明显的假令牌。
 */
export function makeEnv({ dataDir, home, token = DEFAULT_FAKE_TOKEN, env = {} } = {}) {
  const merged = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AIDASH_')) continue;
    merged[key] = value;
  }
  if (dataDir) merged.AIDASH_RUNNER_HOME = dataDir;
  if (home) {
    merged.USERPROFILE = home;
    merged.HOME = home;
  }
  if (token) merged.AIDASH_TOKEN = token;
  merged.NO_COLOR = '1';
  // Windows 下 Node 可能优先读 HOMEDRIVE+HOMEPATH；一起挪走。
  if (home) {
    merged.HOMEDRIVE = path.parse(home).root.replace(/\\$/, '');
    merged.HOMEPATH = home.slice(path.parse(home).root.length - 1);
  }
  return { ...merged, ...env };
}

export function spawnCli(args, { dataDir, home, cwd, env, token, timeoutMs = 60_000 } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: cwd ?? process.cwd(),
    env: makeEnv({ dataDir, home, token, env }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = {
    child,
    stdout: '',
    stderr: '',
    timedOut: false,
    exit: null,
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk;
  });

  const timer = setTimeout(() => {
    state.timedOut = true;
    void terminateProcessTree(child.pid, { force: true });
  }, timeoutMs);
  timer.unref?.();

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      state.exit = { code, signal };
      resolve(state.exit);
    });
  });

  return {
    child,
    get stdout() {
      return state.stdout;
    },
    get stderr() {
      return state.stderr;
    },
    get timedOut() {
      return state.timedOut;
    },
    get exit() {
      return state.exit;
    },
    exitPromise,
    async waitForExit(ms = timeoutMs) {
      return withTimeout(exitPromise, ms, '等待 CLI 退出超时');
    },
    dispose() {
      clearTimeout(timer);
      if (state.exit === null) void terminateProcessTree(child.pid, { force: true });
    },
  };
}

export async function runCli(args, options = {}) {
  const cli = spawnCli(args, options);
  const exit = await cli.waitForExit(options.timeoutMs ?? 60_000);
  return {
    code: exit.code,
    signal: exit.signal,
    stdout: cli.stdout,
    stderr: cli.stderr,
    timedOut: cli.timedOut,
    json: parseJsonEnvelope(cli.stdout),
  };
}

/** 取 stdout 里最后一个可解析的 JSON 信封；非 JSON 输出返回 null。 */
export function parseJsonEnvelope(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try {
      return JSON.parse(lines[index]);
    } catch {
      // 继续往前找：前台模式可能先打印启动信封、再打印错误信封。
    }
  }
  return null;
}

export async function waitFor(check, { timeoutMs = 20_000, intervalMs = 100, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `${label} 在 ${timeoutMs}ms 内未满足${lastError ? `（最后一次错误：${lastError.message}）` : ''}`,
  );
}

export async function waitForRegistry(dataDir, instanceId, { timeoutMs = 20_000 } = {}) {
  return waitFor(
    async () => {
      const entry = readRegistryEntry(dataDir, instanceId);
      if (!entry || entry.invalid) return null;
      const status = await inspectRegistryEntry(entry, { timeoutMs: 800 });
      return status.alive ? { entry, status } : null;
    },
    { timeoutMs, label: `实例 ${instanceId} 控制面就绪` },
  );
}

export async function waitForPidDead(pid, { timeoutMs = 10_000 } = {}) {
  return waitFor(() => !isPidAlive(pid), { timeoutMs, label: `pid ${pid} 退出` });
}

export function writeConfig(dir, config) {
  const filePath = path.join(dir, 'aidash-runner.json');
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

export function baseConfig(overrides = {}) {
  return {
    aidash_url: overrides.url ?? 'http://127.0.0.1:9/mcp',
    token_env: 'AIDASH_TOKEN',
    harness_id: 'it-runner',
    name: 'it-runner',
    channels: [],
    poll_interval_seconds: 3600,
    lease_seconds: 60,
    heartbeat_interval_seconds: 3600,
    gap_seconds: 0,
    command_timeout_seconds: 30,
    data_dir: '',
    log_file: '',
    env_passthrough: [
      'PATH',
      'HOME',
      'USERPROFILE',
      'SystemRoot',
      'ComSpec',
      'PATHEXT',
      'WINDIR',
      'TEMP',
      'TMP',
    ],
    commands: [],
  };
}

export function makeRule({ name = 'it-rule', tags = ['it'], argv, match = {}, run = {} } = {}) {
  return {
    name,
    match: {
      tags,
      ...match,
    },
    run: {
      argv,
      input: 'file',
      timeout_seconds: 20,
      env: {},
      env_passthrough: [],
      result_file: '',
      ...run,
    },
  };
}

export function nodeScript(script, ...args) {
  return [process.execPath, '-e', script, ...args];
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message}（${ms}ms）`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
