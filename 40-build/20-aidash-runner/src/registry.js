import fs from 'node:fs';
import path from 'node:path';
import { HEALTH_CHECK_TIMEOUT_MS, INSTANCE_ID_PATTERN } from './constants.js';
import { ControlError } from './errors.js';
import { getControlHealth, isLoopbackControlUrl } from './control-client.js';
import { atomicWriteFileSync, ensureDirSync, isPidAlive } from './util.js';

/**
 * 本地实例注册表（不是中心 daemon）。
 *
 * 每个实例在 ~/.aidash/runner/instances/<id>.json 里留下“我是谁、PID 多少、
 * 控制面在哪、怎么校验控制令牌”。CLI 靠它找人；实例崩溃后文件会留在原地，
 * 所以读取端必须把“文件存在”与“实例存活”分开判断。
 *
 * 注意字段 control_token 是控制面的随机本机令牌，不是 AIDash 访问令牌。
 * MCP 令牌永远不落盘；控制令牌落盘才能让 `list/status/stop` 不需要重新输入凭据。
 */

export function instancesDir(dataDir) {
  return path.join(dataDir, 'instances');
}

export function registryFilePath(dataDir, instanceId) {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error(`非法实例 id：${instanceId}`);
  }
  return path.join(instancesDir(dataDir), `${instanceId}.json`);
}

export function buildRegistryEntry({
  instanceId,
  pid,
  mode,
  harnessId,
  configPath,
  controlUrl,
  controlToken,
  logFile,
  startedAt,
  version,
}) {
  return {
    instance_id: instanceId,
    pid,
    mode,
    harness_id: harnessId,
    config_path: configPath ?? '',
    control_url: controlUrl,
    control_token: controlToken,
    log_file: logFile ?? '',
    started_at: startedAt,
    version,
  };
}

/** 原子写；权限 0600。返回实际写入路径，便于日志与测试断言。 */
export function writeRegistryEntry(dataDir, entry) {
  const filePath = registryFilePath(dataDir, entry.instance_id);
  ensureDirSync(instancesDir(dataDir), 0o700);
  atomicWriteFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`, 0o600);
  return filePath;
}

export function readRegistryEntry(dataDir, instanceId) {
  let filePath;
  try {
    filePath = registryFilePath(dataDir, instanceId);
  } catch {
    return null;
  }
  return readEntryFile(filePath, instanceId);
}

/**
 * 删除实例文件。带上 pid 时只删除“同一个进程”的记录：
 * 旧进程收尾晚于新进程启动时，不能把新实例的 registry 删掉。
 */
export function removeRegistryEntry(dataDir, instanceId, { pid } = {}) {
  let filePath;
  try {
    filePath = registryFilePath(dataDir, instanceId);
  } catch {
    return false;
  }
  if (Number.isInteger(pid)) {
    const current = readEntryFile(filePath, instanceId);
    if (current && !current.invalid && current.pid !== pid) return false;
  }
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    return error && error.code === 'ENOENT' ? false : false;
  }
}

/** 列出所有 *.json；解析失败也返回条目（标记 invalid），让 list 能解释为什么坏。 */
export function listRegistryEntries(dataDir) {
  const dir = instancesDir(dataDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const fallbackId = name.slice(0, -'.json'.length);
    const entry = readEntryFile(path.join(dir, name), fallbackId);
    if (entry) entries.push(entry);
  }
  return entries;
}

function readEntryFile(filePath, fallbackId) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return invalidEntry(fallbackId, filePath, `无法读取 registry：${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidEntry(fallbackId, filePath, 'registry 不是合法 JSON（可能是写入中断）');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidEntry(fallbackId, filePath, 'registry 顶层不是对象');
  }
  const instanceId = typeof parsed.instance_id === 'string' ? parsed.instance_id : fallbackId;
  const problems = [];
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) problems.push('pid');
  if (typeof parsed.control_url !== 'string' || !parsed.control_url) problems.push('control_url');
  if (typeof parsed.control_token !== 'string' || !parsed.control_token) problems.push('control_token');
  if (typeof parsed.started_at !== 'string' || !parsed.started_at) problems.push('started_at');
  if (typeof parsed.harness_id !== 'string' || !parsed.harness_id) problems.push('harness_id');
  return {
    instance_id: instanceId,
    pid: Number.isInteger(parsed.pid) ? parsed.pid : null,
    mode: parsed.mode === 'background' ? 'background' : 'foreground',
    harness_id: typeof parsed.harness_id === 'string' ? parsed.harness_id : '',
    config_path: typeof parsed.config_path === 'string' ? parsed.config_path : '',
    control_url: typeof parsed.control_url === 'string' ? parsed.control_url : '',
    control_token: typeof parsed.control_token === 'string' ? parsed.control_token : '',
    log_file: typeof parsed.log_file === 'string' ? parsed.log_file : '',
    started_at: typeof parsed.started_at === 'string' ? parsed.started_at : '',
    version: typeof parsed.version === 'string' ? parsed.version : '',
    file_path: filePath,
    invalid: problems.length > 0 ? problems : null,
  };
}

function invalidEntry(instanceId, filePath, reason) {
  return {
    instance_id: instanceId,
    pid: null,
    mode: 'foreground',
    harness_id: '',
    config_path: '',
    control_url: '',
    control_token: '',
    log_file: '',
    started_at: '',
    version: '',
    file_path: filePath,
    invalid: [reason],
  };
}

/**
 * 存活判定必须同时满足：
 * 1. PID 存活（排除进程已退出）；
 * 2. 控制面 /health 可达（排除 PID 被复用后控制端口已关闭）；
 * 3. /health 返回的 instance_id/pid/harness_id/started_at 与 registry 一致
 *    （排除 PID 复用后恰好另一个进程占用了同一 PID，甚至同一端口）。
 *
 * 只看 PID 会把复用了旧 PID 的无关进程当成值守壳；只看端口会把暂未启动完的
 * 实例误判为存活。三者一起才足以支撑 stop/kill 这种破坏性操作。
 */
export async function inspectRegistryEntry(entry, { timeoutMs = HEALTH_CHECK_TIMEOUT_MS } = {}) {
  if (!entry) return { alive: false, stale_reason: 'registry-missing' };
  if (entry.invalid) {
    return { alive: false, stale_reason: `registry-invalid：${entry.invalid.join(', ')}` };
  }
  if (!isPidAlive(entry.pid)) return { alive: false, stale_reason: 'pid-not-running' };
  if (!isLoopbackControlUrl(entry.control_url)) {
    return { alive: false, stale_reason: 'control-url-not-loopback' };
  }
  let health;
  try {
    health = await getControlHealth(entry, { timeoutMs });
  } catch (error) {
    const message = error instanceof ControlError ? error.message : String(error);
    return { alive: false, stale_reason: `health-unreachable：${message}` };
  }
  const mismatches = [];
  if (health.instance_id !== entry.instance_id) mismatches.push('instance_id');
  if (health.pid !== entry.pid) mismatches.push('pid');
  if (health.harness_id !== entry.harness_id) mismatches.push('harness_id');
  if (health.started_at !== entry.started_at) mismatches.push('started_at');
  if (mismatches.length > 0) {
    return {
      alive: false,
      stale_reason: `fingerprint-mismatch：${mismatches.join(', ')}`,
    };
  }
  return { alive: true, stale_reason: null, health };
}

/** 批量检查；用于 list/CLI 目标解析。 */
export async function inspectAll(dataDir, { timeoutMs = HEALTH_CHECK_TIMEOUT_MS } = {}) {
  const entries = listRegistryEntries(dataDir);
  return Promise.all(
    entries.map(async (entry) => ({ entry, ...(await inspectRegistryEntry(entry, { timeoutMs })) })),
  );
}
