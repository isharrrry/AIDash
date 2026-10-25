import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_READY_TIMEOUT_MS } from './constants.js';
import { ConfigError } from './errors.js';
import { terminateProcessTree } from './exec.js';
import {
  inspectRegistryEntry,
  readRegistryEntry,
  removeRegistryEntry,
} from './registry.js';
import { atomicWriteFileSync, ensureDirSync, randomId, sleep } from './util.js';

/**
 * 后台模式。
 *
 * 父进程只做三件事：校验参数、拉起一个 detached 子进程、等它的控制面 /health
 * 就绪后把 id/pid/日志路径打印出来。真正干活的是子进程，父进程退出不影响它。
 *
 * 为什么用 `__run` 而不是再调一次 `start --daemon`：
 * 子进程若走同一个 start 分支，会在缺少 --daemon 判断时再次 fork，形成递归；
 * 内部命令把“后台子进程”和“用户输入”彻底分开。
 *
 * 令牌不走 argv（会出现在 ps / shell 历史），而是通过子进程环境变量 AIDASH_TOKEN
 * 传给子进程；其它启动参数写进 0600 临时文件，读完即删，避免 Windows 环境变量
 * 长度上限和命令行泄露。
 */

export function resolveBinPath() {
  return fileURLToPath(new URL('../bin/aidash-runner.mjs', import.meta.url));
}

export async function startDaemon({
  config,
  token,
  dataDir,
  instanceId,
  logFile,
  flags = {},
}) {
  const childFlags = {
    ...flags,
    daemon: false,
    json: false,
    help: false,
    version: false,
    token: undefined,
    key: undefined,
    tokenFile: undefined,
  };
  const options = {
    mode: 'background',
    config,
    dataDir,
    instanceId,
    logFile,
    flags: childFlags,
    cwd: process.cwd(),
  };

  ensureDirSync(path.join(dataDir, 'tmp'), 0o700);
  const optionsFile = path.join(dataDir, 'tmp', `child-${process.pid}-${randomId(8)}.json`);
  atomicWriteFileSync(optionsFile, `${JSON.stringify(options)}\n`, 0o600);

  const env = { ...process.env };
  delete env.AIDASH_RUNNER_CHILD_OPTIONS;
  delete env.AIDASH_RUNNER_CHILD_OPTIONS_FILE;
  delete env.AIDASH_RUNNER_CONFIG;
  // 子进程只需要解析令牌；令牌值来自父进程已确定的来源（env/--token/--token-file）。
  env.AIDASH_TOKEN = token;
  env.AIDASH_RUNNER_CHILD_OPTIONS_FILE = optionsFile;

  let child;
  try {
    child = spawn(process.execPath, [resolveBinPath(), '__run'], {
      cwd: process.cwd(),
      env,
      detached: true,
      windowsHide: true,
      // 子进程自己写日志文件；父进程退出后管道会断，不能用 pipe。
      stdio: 'ignore',
    });
  } catch (error) {
    cleanupFile(optionsFile);
    throw new ConfigError(`启动后台进程失败：${error instanceof Error ? error.message : String(error)}`);
  }

  let exitInfo = null;
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  child.once('error', (error) => {
    exitInfo = { code: null, signal: null, error: error.message };
  });
  child.unref();

  try {
    const entry = await waitForReady({ dataDir, instanceId, pid: child.pid, isExited: () => exitInfo });
    cleanupFile(optionsFile);
    return {
      entry,
      pid: child.pid,
      instance_id: instanceId,
      mode: 'background',
      log_file: logFile,
      control_url: entry.control_url,
    };
  } catch (error) {
    cleanupFile(optionsFile);
    // 子进程可能已经写了一半 registry；先杀再按 PID 精确删除。
    await terminateProcessTree(child.pid, { force: true }).catch(() => undefined);
    await sleep(200);
    removeRegistryEntry(dataDir, instanceId, { pid: child.pid });
    const reason = error instanceof Error ? error.message : String(error);
    const tail = readLogTail(logFile);
    throw new ConfigError(
      `后台实例启动失败：${reason}${tail ? `\n最近日志（${logFile}）：\n${tail}` : ''}`,
    );
  }
}

async function waitForReady({ dataDir, instanceId, pid, isExited }) {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exited = isExited();
    if (exited) {
      throw new Error(
        `子进程提前退出（code=${exited.code ?? 'null'}, signal=${exited.signal ?? 'null'}${
          exited.error ? `, ${exited.error}` : ''
        }）`,
      );
    }
    const entry = readRegistryEntry(dataDir, instanceId);
    // 只认本次 child 的 PID：同一实例 id 可能留着上次的 stale 记录。
    if (entry && entry.pid === pid) {
      const status = await inspectRegistryEntry(entry, { timeoutMs: 800 });
      if (status.alive) return entry;
    }
    await sleep(100);
  }
  throw new Error(`等待控制面就绪超时（${DAEMON_READY_TIMEOUT_MS}ms）`);
}

function cleanupFile(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // 临时文件残留 0600，不含令牌；失败不掩盖真正的启动错误。
  }
}

function readLogTail(filePath, maxBytes = 4_000) {
  if (!filePath) return '';
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
