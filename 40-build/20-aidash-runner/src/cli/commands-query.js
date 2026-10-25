import fs from 'node:fs';
import { parsePositiveNumber } from '../args.js';
import { BusinessError, ConfigError } from '../errors.js';
import { getControlStatus, requestControlPull } from '../control-client.js';
import {
  discoverInstances,
  resolveDataDirForDiscovery,
  resolveInstances,
  resolveInstancesForLogs,
} from '../instance.js';
import { isPidAlive, sleep } from '../util.js';
import { publicInstance, table } from './output.js';

export async function listCommand(flags, out) {
  const dataDir = resolveDataDirForDiscovery(flags);
  const items = await discoverInstances(dataDir, { timeoutMs: 800 });
  // 默认展示 stale（带原因），否则用户会以为记录“凭空消失”；
  // --all 额外展示连 JSON 都解析不了的 registry 文件。
  const visible = flags.all ? items : items.filter((item) => !item.invalid);
  const data = { data_dir: dataDir, instances: visible.map(publicInstance) };
  if (visible.length === 0) {
    out.write(data, `没有实例记录（数据目录：${dataDir}）`);
    return 0;
  }
  const rows = visible.map((item) => [
    item.instance_id,
    item.pid ?? '-',
    item.mode,
    item.alive ? 'alive' : 'stale',
    item.harness_id || '-',
    item.alive ? '' : item.stale_reason ?? '',
  ]);
  out.write(
    data,
    `${table(rows, ['实例', 'PID', '模式', '状态', 'HARNESS', '失效原因'])}\n数据目录: ${dataDir}`,
  );
  return 0;
}

export async function statusCommand(flags, out, positionals) {
  if (positionals.length > 1) throw new ConfigError('用法：aidash-runner status [id] [--json]');
  const dataDir = resolveDataDirForDiscovery(flags);
  const entries = flags.all
    ? (await discoverInstances(dataDir, { timeoutMs: 1_500 })).filter((item) => item.alive)
    : await resolveInstances(dataDir, { id: positionals[0] });

  if (entries.length === 0) {
    throw new BusinessError('NO_LIVE_INSTANCE', '没有存活实例');
  }

  const statuses = [];
  for (const entry of entries) {
    const status = await getControlStatus(entry, { timeoutMs: 3_000 });
    statuses.push({ ...status, instance_id: status.instance_id ?? entry.instance_id });
  }

  if (entries.length === 1 && !flags.all) {
    out.write(statuses[0], formatStatus(statuses[0]));
    return 0;
  }
  out.write({ instances: statuses }, statuses.map(formatStatus).join('\n\n'));
  return 0;
}

export async function pullCommand(flags, out, positionals) {
  if (positionals.length > 1) throw new ConfigError('用法：aidash-runner pull [id] [--wait]');
  const dataDir = resolveDataDirForDiscovery(flags);
  const [entry] = await resolveInstances(dataDir, { id: positionals[0] });

  let before = null;
  if (flags.wait) {
    before = await getControlStatus(entry, { timeoutMs: 3_000 }).catch(() => null);
  }
  const response = await requestControlPull(entry, { timeoutMs: 10_000 });

  let waited = null;
  if (flags.wait) {
    waited = await waitForPoll(entry, before, 60_000);
  }

  const data = {
    instance_id: entry.instance_id,
    triggered: response?.triggered !== false,
    queued: response?.queued === true,
    reason: response?.reason ?? null,
    waited: waited?.waited ?? false,
    busy: waited?.status?.busy ?? response?.status?.busy ?? null,
    last_poll_at: waited?.status?.last_poll_at ?? response?.status?.last_poll_at ?? null,
  };
  const human = data.queued
    ? `已请求实例 ${entry.instance_id} 拉取：当前任务执行中，已合并到下一轮`
    : `已触发实例 ${entry.instance_id} 立即拉取`;
  out.write(
    data,
    `${human}${flags.wait ? (data.waited ? '；下一轮拉取已完成' : '；等待超时，任务可能仍在执行') : ''}`,
  );
  return 0;
}

async function waitForPoll(entry, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const beforePoll = before?.last_poll_at ?? null;
  const beforeTaskTime = before?.last_task?.at ?? null;
  while (Date.now() < deadline) {
    await sleep(400);
    let status;
    try {
      status = await getControlStatus(entry, { timeoutMs: 2_000 });
    } catch {
      // 实例正好在退出：把“等不到”当成结束，避免 CLI 永久挂住。
      return { waited: false, status: null };
    }
    const pollChanged = status.last_poll_at !== beforePoll;
    const taskChanged = (status.last_task?.at ?? null) !== beforeTaskTime;
    if (pollChanged || taskChanged) return { waited: true, status };
  }
  try {
    return { waited: false, status: await getControlStatus(entry, { timeoutMs: 2_000 }) };
  } catch {
    return { waited: false, status: null };
  }
}

export async function logsCommand(flags, out, positionals) {
  if (positionals.length > 1) {
    throw new ConfigError('用法：aidash-runner logs [id] [-f] [--lines <n>]');
  }
  const lines = parsePositiveNumber(flags.lines, '--lines', {
    min: 1,
    max: 100_000,
    integer: true,
  }) ?? 200;
  const dataDir = resolveDataDirForDiscovery(flags);
  const [entry] = await resolveInstancesForLogs(dataDir, { id: positionals[0] });
  if (!entry.log_file) {
    throw new BusinessError('NO_LOG_FILE', `实例 ${entry.instance_id} 没有配置日志文件`);
  }
  if (!fs.existsSync(entry.log_file)) {
    throw new BusinessError('LOG_NOT_FOUND', `日志文件不存在：${entry.log_file}`);
  }
  if (flags.follow && flags.json) {
    throw new ConfigError('logs -f 不能与 --json 同用：跟随输出是连续流，不是单个 JSON 信封');
  }

  const tail = readLastLines(entry.log_file, lines);
  if (flags.json) {
    out.write({
      instance_id: entry.instance_id,
      log_file: entry.log_file,
      lines: tail.lines,
      truncated: tail.truncated,
    });
    return 0;
  }

  if (tail.lines.length > 0) process.stdout.write(`${tail.lines.join('\n')}\n`);
  if (!flags.follow || !entry.alive) return 0;
  const interrupted = await followFile(entry);
  return interrupted ? 130 : 0;
}

/**
 * 跟随追加内容；实例进程消失后补读一次再退出。
 * 定时器必须保持 ref：它是跟随期间让 CLI 不退出的事件源。
 */
function followFile(entry) {
  return new Promise((resolve) => {
    let position = 0;
    try {
      position = fs.statSync(entry.log_file).size;
    } catch {
      position = 0;
    }
    let interrupted = false;
    let deadTicks = 0;
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolve(interrupted);
    };
    const onSignal = () => {
      interrupted = true;
      finish();
    };

    const timer = setInterval(() => {
      let stat;
      try {
        stat = fs.statSync(entry.log_file);
      } catch {
        deadTicks += 1;
        if (deadTicks >= 2) finish();
        return;
      }
      if (stat.size < position) position = 0; // 日志被轮转/截断
      if (stat.size > position) {
        try {
          const length = stat.size - position;
          const fd = fs.openSync(entry.log_file, 'r');
          try {
            const buffer = Buffer.alloc(length);
            const read = fs.readSync(fd, buffer, 0, length, position);
            position += read;
            if (read > 0) process.stdout.write(buffer.subarray(0, read));
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          // 单次读失败下一轮重试；不要因此退出跟随。
        }
      }
      if (!isPidAlive(entry.pid)) {
        deadTicks += 1;
        if (deadTicks >= 3) finish();
      } else {
        deadTicks = 0;
      }
    }, 300);

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

function readLastLines(filePath, count) {
  const stat = fs.statSync(filePath);
  const budget = Math.min(
    stat.size,
    Math.max(64 * 1024, Math.min(5 * 1024 * 1024, count * 512)),
  );
  const start = stat.size - budget;
  const fd = fs.openSync(filePath, 'r');
  let text;
  try {
    const buffer = Buffer.alloc(budget);
    const read = fs.readSync(fd, buffer, 0, budget, start);
    text = buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (start > 0) {
    // 从文件中间开始时，第一行大概率是半截。
    const firstBreak = text.indexOf('\n');
    text = firstBreak >= 0 ? text.slice(firstBreak + 1) : text;
  }
  const all = text.split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  return {
    lines: all.slice(Math.max(0, all.length - count)),
    truncated: start > 0 && all.length > count,
  };
}

function formatStatus(status) {
  const lines = [
    `实例 ${status.instance_id}（pid ${status.pid}，${status.mode}，${status.version ?? ''}）`,
    `  连接/注册: ${status.connected ? 'connected' : 'offline'} / ${status.registered ? 'registered' : 'unregistered'}`,
    `  状态: ${status.busy ? 'busy' : 'idle'}；启动 ${status.started_at}`,
    `  控制面: ${status.control_url}`,
    `  日志: ${status.log_file || '(无)'}`,
    `  配置: harness_id=${status.config?.harness_id} poll=${status.config?.poll_interval_seconds}s lease=${status.config?.lease_seconds}s heartbeat=${status.config?.heartbeat_interval_seconds}s gap=${status.config?.gap_seconds}s`,
    `  通道: ${(status.config?.channels ?? []).join(', ') || '(全部)'}`,
    `  最近拉取: ${status.last_poll_at ?? '(尚未)'}；pending ${status.last_poll?.pending ?? '-'}，计划 ${status.last_poll?.planned?.length ?? 0}，跳过 ${status.last_poll?.skipped?.length ?? 0}`,
    status.last_task
      ? `  最近任务: ${status.last_task.task_id} → ${status.last_task.outcome}（${status.last_task.at}）`
      : '  最近任务: (无)',
    status.busy && status.current_task
      ? `  当前任务: ${status.current_task.task_id} ${status.current_task.title ?? ''}${status.current_task.pid ? `（pid ${status.current_task.pid}）` : ''}`
      : '  当前任务: (无)',
    status.last_error
      ? `  最近错误: ${status.last_error.at} [${status.last_error.kind}] ${status.last_error.message}`
      : '  最近错误: (无)',
    `  统计: 完成 ${status.stats?.completed ?? 0}，失败 ${status.stats?.failed ?? 0}，blocked ${status.stats?.blocked ?? 0}，释放 ${status.stats?.released ?? 0}，错误 ${status.stats?.errors ?? 0}`,
  ];
  if (status.stop_requested) lines.push(`  停止中: ${status.stop_requested}`);
  return lines.join('\n');
}
