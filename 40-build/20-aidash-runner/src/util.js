import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 边界类型守卫：配置文件与服务端响应都是不可信 JSON，先收窄再使用。 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value) {
  return isRecord(value) ? value : null;
}

export function asString(value) {
  return typeof value === 'string' ? value : null;
}

export function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

export function asFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function randomId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 可被 AbortSignal 提前唤醒的 sleep；返回值只表示“睡完或被取消”。 */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** 指数退避 + ±20% jitter，上限 60s。jitter 防止多个实例在同一秒一起重连。 */
export function backoffDelayMs(attempt) {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

export function expandHome(raw) {
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

export function resolvePath(raw, baseDir = process.cwd()) {
  const expanded = expandHome(raw);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

export function ensureDirSync(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

/**
 * 原子写：同目录临时文件 + fsync + rename。
 *
 * 为什么不能直接 writeFileSync：registry 与持久化配置会被另一个进程同时读。
 * 写到一半崩溃会留下半截 JSON，读取方要么解析失败，要么把旧值当成新值。
 * 同目录是为了让 rename 落在同一文件系统（跨盘 rename 不具原子性）。
 *
 * Windows 上目标文件存在时 rename 偶发 EPERM/EEXIST（杀毒软件持有句柄），
 * 此时退化为“删除后重命名”；窗口极小，且读取端有 JSON 解析容错。
 */
export function atomicWriteFileSync(filePath, data, mode = 0o600) {
  const dir = path.dirname(filePath);
  ensureDirSync(dir, 0o700);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomId(6)}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, data, { encoding: 'utf8' });
    try {
      fs.fsyncSync(fd);
    } catch {
      // 某些文件系统不支持 fsync；不影响 rename 的原子性。
    }
    fs.closeSync(fd);
    fd = null;
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      // Windows 上 chmod 只影响只读位；权限主要靠目录 ACL。
    }
    try {
      fs.renameSync(tmp, filePath);
    } catch (error) {
      if (error && ['EPERM', 'EEXIST', 'EACCES'].includes(error.code)) {
        fs.rmSync(filePath, { force: true });
        fs.renameSync(tmp, filePath);
      } else {
        throw error;
      }
    }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 忽略：下面还要清临时文件。
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 忽略：临时文件残留比覆盖目标文件安全。
    }
    throw error;
  }
}

/**
 * 实例 id 直接复用 harness_id：服务端本来就把 harness_id 当唯一执行者标识，
 * 两个实例用同一 harness_id 会互相覆盖注册，本身就不该并存。
 * 只做一次安全整形，防止 `../` 之类的路径穿越写坏 registry 目录。
 */
export function sanitizeInstanceId(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .replace(/^[.]+$/, '-');
  return cleaned.slice(0, 80) || 'aidash-runner';
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但无权限发信号；对“是否存活”来说仍算活着。
    return error && error.code === 'EPERM';
  }
}

export function parseIsoMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m${rest ? `${rest}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
}

export function isoNow() {
  return new Date().toISOString();
}
