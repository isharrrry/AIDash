import { ConfigError } from '../errors.js';
import {
  getControlStatus,
  requestControlConfig,
  requestControlReload,
} from '../control-client.js';
import {
  killInstance,
  resolveDataDirForDiscovery,
  resolveInstances,
  stopInstance,
} from '../instance.js';
import { printWarnings } from './common.js';

export async function stopCommand(flags, out, positionals) {
  if (positionals.length > 1) {
    throw new ConfigError('用法：aidash-runner stop [id] [--all] [--force]');
  }
  const dataDir = resolveDataDirForDiscovery(flags);
  const entries = await resolveInstances(dataDir, { id: positionals[0], all: flags.all });
  const results = [];

  for (const entry of entries) {
    // --force 先给 3 秒优雅收尾；普通 stop 给 15 秒（POSIX 终止进程树有 2s 宽限）。
    const graceful = await stopInstance(entry, { timeoutMs: flags.force ? 3_000 : 15_000 });
    let forced = false;
    if (!graceful.stopped && flags.force) {
      const killed = await killInstance(entry);
      forced = killed.stopped;
    }
    results.push({
      instance_id: entry.instance_id,
      pid: entry.pid,
      stopped: graceful.stopped || forced,
      request_sent: graceful.requested,
      forced,
    });
  }

  const failed = results.filter((item) => !item.stopped);
  const lines = results.map((item) =>
    item.stopped
      ? `实例 ${item.instance_id}（pid ${item.pid}）已停止${item.forced ? '（强制终止）' : '（优雅退出）'}`
      : `实例 ${item.instance_id}（pid ${item.pid}）仍未退出；可用 stop --force 或 kill`,
  );
  out.write({ stopped: failed.length === 0, instances: results }, lines.join('\n'));
  return failed.length === 0 ? 0 : 1;
}

export async function killCommand(flags, out, positionals) {
  if (positionals.length > 1) {
    throw new ConfigError('用法：aidash-runner kill [id] [--all]');
  }
  const dataDir = resolveDataDirForDiscovery(flags);
  const entries = await resolveInstances(dataDir, { id: positionals[0], all: flags.all });
  const results = [];
  for (const entry of entries) {
    const killed = await killInstance(entry);
    results.push({
      instance_id: entry.instance_id,
      pid: entry.pid,
      stopped: killed.stopped,
      child_pid: killed.child_pid,
    });
  }
  const failed = results.filter((item) => !item.stopped);
  const lines = results.map((item) =>
    item.stopped
      ? `实例 ${item.instance_id}（pid ${item.pid}）已强杀${item.child_pid ? `，harness pid ${item.child_pid}` : ''}`
      : `实例 ${item.instance_id}（pid ${item.pid}）未确认退出`,
  );
  out.write({ killed: failed.length === 0, instances: results }, lines.join('\n'));
  return failed.length === 0 ? 0 : 1;
}

export async function configCommand(flags, out, positionals) {
  const sub = positionals[0];
  if (!['get', 'set', 'reload'].includes(sub)) {
    throw new ConfigError(
      '用法：aidash-runner config get [id] | config set [id] <key> <value> [--persist] | config reload [id]',
    );
  }
  const rest = positionals.slice(1);
  let id = null;
  let key = null;
  let value = null;

  if (sub === 'get' || sub === 'reload') {
    if (rest.length > 1) {
      throw new ConfigError(`用法：aidash-runner config ${sub} [id]`);
    }
    id = rest[0] ?? null;
  } else {
    if (rest.length === 2) {
      [key, value] = rest;
    } else if (rest.length === 3) {
      [id, key, value] = rest;
    } else {
      throw new ConfigError(
        '用法：aidash-runner config set [id] <key> <value> [--persist]（value 为字符串；数组用逗号分隔或 JSON）',
      );
    }
    if (!key || value === undefined) {
      throw new ConfigError('config set 需要 <key> <value>');
    }
  }

  const dataDir = resolveDataDirForDiscovery(flags);
  const [entry] = await resolveInstances(dataDir, { id });

  if (sub === 'get') {
    if (flags.persist) throw new ConfigError('--persist 只用于 config set');
    const status = await getControlStatus(entry, { timeoutMs: 3_000 });
    const config = status.config ?? {};
    out.write(
      { instance_id: entry.instance_id, config },
      JSON.stringify(config, null, 2),
    );
    return 0;
  }

  if (sub === 'reload') {
    if (flags.persist) throw new ConfigError('--persist 只用于 config set');
    const result = await requestControlReload(entry, { timeoutMs: 10_000 });
    printWarnings(out, result?.warnings ?? []);
    const restart = result?.restart_required ?? [];
    const applied = result?.applied ?? [];
    const human = [
      `实例 ${entry.instance_id} 配置已重新加载`,
      `  运行时生效: ${applied.length > 0 ? applied.join(', ') : '(无变化)'}`,
      restart.length > 0 ? `  需重启后生效: ${restart.join(', ')}` : '  需重启后生效: (无)',
    ].join('\n');
    out.write(result, human);
    return 0;
  }

  const result = await requestControlConfig(entry, { [key]: value }, flags.persist === true, {
    timeoutMs: 10_000,
  });
  const human = [
    `实例 ${entry.instance_id} 配置已更新：${key}=${value}`,
    `  已持久化: ${flags.persist ? '是（原子写回配置文件）' : '否（仅当前进程）'}`,
  ].join('\n');
  out.write(result, human);
  return 0;
}
