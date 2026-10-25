import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BusinessError } from './errors.js';
import { getControlStatus, requestControlStop } from './control-client.js';
import { findConfigPath } from './config.js';
import { terminateProcessTree } from './exec.js';
import {
  inspectRegistryEntry,
  listRegistryEntries,
  removeRegistryEntry,
} from './registry.js';
import { isPidAlive, resolvePath, sleep } from './util.js';

/**
 * 实例发现与目标解析。
 *
 * 所有本地控制命令共享同一条规则：只有一个存活实例时可以省略 id；
 * 多个时必须显式指定，避免“我以为在停 A，实际停了 B”。stale 记录永远不参与
 * 自动选择——它看起来像实例，但发不出停止请求。
 */

/** list 用：把 registry 与实时健康检查合并成一个可展示对象。 */
export async function discoverInstances(dataDir, { timeoutMs = 1_200 } = {}) {
  const entries = listRegistryEntries(dataDir);
  const inspected = await Promise.all(
    entries.map(async (entry) => {
      const result = await inspectRegistryEntry(entry, { timeoutMs });
      return { ...entry, ...result, data_dir: dataDir };
    }),
  );
  return inspected;
}

export async function resolveInstances(dataDir, { id, all = false, timeoutMs = 2_000 } = {}) {
  const entries = await discoverInstances(dataDir, { timeoutMs });

  if (id) {
    const match = entries.find((entry) => entry.instance_id === id);
    if (!match) {
      throw new BusinessError(
        'INSTANCE_NOT_FOUND',
        `没有实例 ${id} 的注册记录；当前已知：${describeIds(entries)}`,
      );
    }
    if (!match.alive) {
      throw new BusinessError(
        'INSTANCE_STALE',
        `实例 ${id} 的记录已失效（${match.stale_reason}）；` +
          `用 list --all 查看，或 delete ${path.basename(match.file_path ?? '')} 后重新启动`,
      );
    }
    return [match];
  }

  const alive = entries.filter((entry) => entry.alive);
  if (all) {
    if (alive.length === 0) {
      throw new BusinessError('NO_LIVE_INSTANCE', '没有存活实例；用 `aidash-runner list --all` 查看失效记录');
    }
    return alive;
  }
  if (alive.length === 0) {
    throw new BusinessError(
      'NO_LIVE_INSTANCE',
      `没有存活实例；用 \`aidash-runner list --all\` 查看 ${entries.length} 条失效记录，或先 start`,
    );
  }
  if (alive.length > 1) {
    throw new BusinessError(
      'MULTIPLE_INSTANCES',
      `当前有 ${alive.length} 个存活实例，请指定 id：${describeIds(alive)}`,
    );
  }
  return alive;
}

/** logs 专用：允许对已停止但仍有日志文件的记录执行一次查看。 */
export async function resolveInstancesForLogs(dataDir, { id, timeoutMs = 1_200 } = {}) {
  const entries = await discoverInstances(dataDir, { timeoutMs });
  if (id) {
    const match = entries.find((entry) => entry.instance_id === id);
    if (!match) {
      throw new BusinessError(
        'INSTANCE_NOT_FOUND',
        `没有实例 ${id} 的注册记录；当前已知：${describeIds(entries)}`,
      );
    }
    return [match];
  }
  const alive = entries.filter((entry) => entry.alive);
  if (alive.length === 1) return alive;
  if (alive.length > 1) {
    throw new BusinessError(
      'MULTIPLE_INSTANCES',
      `当前有 ${alive.length} 个存活实例，请指定 id：${describeIds(alive)}`,
    );
  }
  if (entries.length === 1) return entries;
  if (entries.length === 0) {
    throw new BusinessError('NO_INSTANCE', '没有任何实例记录；先运行 aidash-runner start');
  }
  throw new BusinessError(
    'MULTIPLE_INSTANCES',
    `没有存活实例，但有多条失效记录；请指定 id：${describeIds(entries)}`,
  );
}

/**
 * 优雅停止：先 POST /stop，再等进程退出。
 * 超时后返回 stopped=false；是否升级为强杀由调用方（stop --force）决定。
 */
export async function stopInstance(entry, { timeoutMs = 15_000 } = {}) {
  let requested = false;
  try {
    await requestControlStop(entry, { timeoutMs: 3_000 });
    requested = true;
  } catch (error) {
    // 控制面已经不可达通常意味着进程正在退出；下面统一用 PID 判定。
    requested = false;
    void error;
  }

  const stopped = await waitForStopped(entry, timeoutMs);
  if (stopped) {
    removeRegistryEntry(entry.data_dir ?? '', entry.instance_id, { pid: entry.pid });
  }
  return { requested, stopped };
}

/**
 * 强制终止：
 * 1. 先尽量从 /status 拿到当前 harness 子进程 PID（POSIX 下它是独立进程组，
 *    只杀 runner 会留下孤儿）；
 * 2. 先杀 runner，再杀子进程；
 * 3. 确认 PID 死亡后才删 registry，避免把刚重启的新实例记录误删。
 *
 * 顺序为什么是“runner 先死”：kill 的语义是直接强杀，不应产生任何回报。
 * 若先杀 harness，runner 会看到子进程“异常退出”，在它自己被杀掉之前
 * 还有时间发一张 failed 证据卡并 fail 任务——用户要的是终止，不是伪造一条失败记录。
 * Windows 的 taskkill /T 本身会覆盖子进程；POSIX 子进程在独立进程组里，
 * 因此 runner 死后仍要显式再杀一次 child，避免孤儿进程。
 */
export async function killInstance(entry) {
  let childPid = null;
  try {
    const status = await getControlStatus(entry, { timeoutMs: 1_500 });
    const pid = status?.current_task?.pid;
    if (Number.isInteger(pid) && pid > 0 && pid !== entry.pid) childPid = pid;
  } catch {
    // runner 已死或控制面不可达：只剩 registry 里的 PID 可处理。
  }

  await terminateProcessTree(entry.pid, { force: true });
  if (childPid) await terminateProcessTree(childPid, { force: true });

  const dead = await waitForPidDead(entry.pid, 5_000);
  if (dead) removeRegistryEntry(entry.data_dir ?? '', entry.instance_id, { pid: entry.pid });
  return { child_pid: childPid, stopped: dead };
}

async function waitForStopped(entry, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(entry.pid)) return true;
    if (!(await isControlReachable(entry))) return true;
    await sleep(200);
  }
  return !isPidAlive(entry.pid);
}

async function isControlReachable(entry) {
  try {
    await getControlStatus(entry, { timeoutMs: 800 });
    return true;
  } catch {
    return false;
  }
}

async function waitForPidDead(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

function describeIds(entries) {
  if (entries.length === 0) return '(无)';
  return entries
    .map((entry) => `${entry.instance_id}${entry.alive ? '' : '(stale)'}`)
    .join(', ');
}

/**
 * 发现类命令（list/status/stop/...）的数据目录解析。
 *
 * 刻意不调用 loadConfig：配置文件写错不应该导致“连哪个实例都查不了”。
 * 只需要 data_dir 一个字段；JSON 读不出来就回退默认目录，真正的配置错误
 * 留给 start/check 报。
 */
export function resolveDataDirForDiscovery(flags, env = process.env, cwd = process.cwd()) {
  if (flags.dataDir?.trim()) return resolvePath(flags.dataDir.trim(), cwd);
  const fromEnv = env.AIDASH_RUNNER_HOME?.trim();
  if (fromEnv) return resolvePath(fromEnv, cwd);
  const found = findConfigPath(flags, env, cwd);
  if (found.path && fs.existsSync(found.path)) {
    try {
      const raw = JSON.parse(fs.readFileSync(found.path, 'utf8'));
      if (raw && typeof raw === 'object' && typeof raw.data_dir === 'string' && raw.data_dir.trim()) {
        return resolvePath(raw.data_dir.trim(), path.dirname(found.path));
      }
    } catch {
      // 配置坏了不影响找实例；start/check 会给出具体错误。
    }
  }
  return path.join(os.homedir(), '.aidash', 'runner');
}

