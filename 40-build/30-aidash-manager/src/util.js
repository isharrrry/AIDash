import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 路径、进程与文件的小工具。放在一处，避免每个模块各写一版 Windows 兼容。 */

export function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 支持 `~` 与相对路径；相对路径以 base 为基准。 */
export function resolvePath(raw, base = process.cwd()) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let value = raw.trim();
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(2));
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

export function ensureDirSync(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

/**
 * 原子写：先写同目录临时文件，再 rename。
 *
 * Windows 上目标文件被杀毒/索引占用时 rename 可能短暂 EPERM，重试几次；
 * 这是本机工具最常见的失败模式，不值得让用户看到一次随机保存失败。
 */
export function atomicWriteFileSync(filePath, data, mode = 0o600) {
  const dir = path.dirname(filePath);
  ensureDirSync(dir, 0o700);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, { encoding: 'utf8', mode });
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (error && error.code !== 'EPERM' && error.code !== 'EBUSY' && error.code !== 'EACCES') break;
      const until = Date.now() + 30;
      while (Date.now() < until) {
        // 同步小睡：这里在启动/保存路径上，重试窗口只有几十毫秒。
      }
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // 清理失败不影响主错误。
  }
  throw lastError;
}

export function readJsonFile(filePath, fallback = null) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
  return JSON.parse(text);
}

export function writeJsonFile(filePath, value, mode = 0o600) {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function newServiceId() {
  return `svc_${crypto.randomBytes(6).toString('hex')}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但当前用户无权限发信号；对“是否存活”仍算活着。
    return Boolean(error && error.code === 'EPERM');
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到 fn 返回真值；超时返回 null，不抛错，交给调用方决定提示。 */
export async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

export function runProcess(command, args, options = {}) {
  const { cwd, env, timeoutMs = 20_000, input, shell = false } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killTree(child.pid, { force: true }).catch(() => {});
      finish({ code: null, signal: 'TIMEOUT', stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });
    child.on('error', (error) => finish({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, error }));
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * 结束进程树。
 *
 * Windows 上 Node 的 child.kill 只结束直接子进程，服务端再拉起的 harness/worker
 * 会变成孤儿；taskkill /T 是唯一稳定的整树方式。POSIX 用负 PID 结束进程组，
 * 因此服务启动时必须 detached + 独立进程组。
 */
export function killTree(pid, { force = true } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ ok: false, reason: 'invalid-pid' });
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    return new Promise((resolve) => {
      const child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => resolve({ ok: false, reason: 'taskkill-failed' }));
      child.on('close', (code) => resolve({ ok: code === 0, reason: code === 0 ? null : `taskkill-${code}` }));
    });
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    return Promise.resolve({ ok: true });
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      return Promise.resolve({ ok: true });
    } catch (error) {
      return Promise.resolve({ ok: false, reason: error.code ?? 'kill-failed' });
    }
  }
}

export function tailLines(text, lines) {
  if (!text) return { lines: [], truncated: false };
  const all = text.split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const truncated = all.length > lines;
  return { lines: truncated ? all.slice(-lines) : all, truncated };
}

/** 只读文件尾部，避免把几百 MB 日志整个读进内存。 */
export function readFileTail(filePath, maxBytes = 512 * 1024) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { text: '', size: 0 };
    throw error;
  }
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    // 从中间截断时，第一行大概率不完整；丢掉它，避免把半行当成异常。
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    return { text, size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 时`;
}

export function isSensitiveEnvKey(key) {
  const upper = String(key).toUpperCase();
  if (upper === 'AIDASH_TOKEN' || upper === 'AIDASH_LLM_API_KEY') return true;
  return ['_TOKEN', '_SECRET', '_KEY', '_PASSWORD'].some((suffix) => upper.endsWith(suffix));
}

export function normalizeUrlString(raw, { allowPath = true } = {}) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!allowPath) return url.origin;
  return url.toString();
}

export function hostForUrl(host) {
  if (!host) return '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

export function truncate(text, max = 500) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
