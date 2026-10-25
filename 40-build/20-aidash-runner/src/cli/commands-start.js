import fs from 'node:fs';
import { ConfigError, errorMessage } from '../errors.js';
import { resolveToken } from '../config.js';
import { startDaemon } from '../daemon.js';
import { previewPendingTasks, runDryRun } from '../preview.js';
import { runOnce, runService } from '../runner.js';
import { ensureNotRunning, prepareRuntime, printWarnings } from './common.js';

/** `start`：前台常驻，或派生后台子进程后由父进程立即返回。 */
export async function startCommand(flags, out) {
  const prepared = prepareRuntime(flags);
  printWarnings(out, prepared.warnings);

  const confirmationExit = await confirmCommandScope(prepared, flags, out);
  if (confirmationExit !== null) return confirmationExit;

  if (flags.daemon) {
    await ensureNotRunning(prepared.dataDir, prepared.instanceId);
    const result = await startDaemon({
      config: prepared.config,
      token: prepared.token,
      dataDir: prepared.dataDir,
      instanceId: prepared.instanceId,
      logFile: prepared.logFile,
      flags,
    });
    const data = {
      instance_id: result.instance_id,
      pid: result.pid,
      mode: result.mode,
      control_url: result.control_url,
      log_file: result.log_file,
      config_path: prepared.config.config_path,
    };
    out.write(
      data,
      [
        'aidash-runner 已在后台启动',
        `  实例: ${data.instance_id}`,
        `  PID: ${data.pid}`,
        `  控制面: ${data.control_url}`,
        `  日志: ${data.log_file}`,
        `  停止: aidash-runner stop ${data.instance_id}`,
      ].join('\n'),
    );
    return 0;
  }

  const result = await runService({
    config: prepared.config,
    token: prepared.token,
    dataDir: prepared.dataDir,
    mode: 'foreground',
    logFile: prepared.logFile,
    flags,
    onReady: ({ entry }) => {
      const data = {
        instance_id: entry.instance_id,
        pid: entry.pid,
        mode: 'foreground',
        control_url: entry.control_url,
        log_file: entry.log_file,
        config_path: entry.config_path,
        started_at: entry.started_at,
      };
      out.write(
        data,
        [
          'aidash-runner 已启动（前台）',
          `  实例: ${data.instance_id}`,
          `  PID: ${data.pid}`,
          `  控制面: ${data.control_url}`,
          `  日志: ${data.log_file}`,
          `  停止: aidash-runner stop ${data.instance_id}（或 Ctrl+C）`,
        ].join('\n'),
      );
    },
  });

  if (result.error) {
    out.error(result.error);
    return result.exitCode;
  }
  return result.exitCode;
}

/**
 * `__run`：后台子进程入口（内部命令）。
 * 参数文件读完立即删除；令牌只从环境变量 AIDASH_TOKEN 读取。
 */
export async function runInternal(flags, out) {
  const optionsFile = process.env.AIDASH_RUNNER_CHILD_OPTIONS_FILE;
  if (!optionsFile) {
    throw new ConfigError('__run 是 aidash-runner 内部命令，不能直接运行；请使用 start --daemon');
  }
  let options;
  try {
    options = JSON.parse(fs.readFileSync(optionsFile, 'utf8'));
  } catch (error) {
    throw new ConfigError(`读取后台启动参数失败：${errorMessage(error)}`);
  } finally {
    try {
      fs.rmSync(optionsFile, { force: true });
    } catch {
      // 参数文件不含令牌；删除失败不影响启动。
    }
  }

  if (!options || typeof options !== 'object' || !options.config || typeof options.config !== 'object') {
    throw new ConfigError('后台启动参数缺少 config');
  }
  if (typeof options.dataDir !== 'string' || !options.dataDir) {
    throw new ConfigError('后台启动参数缺少 dataDir');
  }

  try {
    const tokenInfo = resolveToken({});
    const result = await runService({
      config: options.config,
      token: tokenInfo.token,
      dataDir: options.dataDir,
      mode: 'background',
      logFile: options.logFile ?? null,
      flags: options.flags ?? {},
      cwd: options.cwd ?? process.cwd(),
    });
    if (result.error) {
      out.error(result.error);
      return result.exitCode;
    }
    return result.exitCode;
  } catch (error) {
    // 子进程 stderr 已被父进程丢弃；把启动错误补进日志，父进程失败时能带出来。
    appendStartupError(options.logFile, error);
    throw error;
  }
}

/** `once`：最多执行一个任务；不写 registry、不提供控制面。 */
export async function onceCommand(flags, out) {
  const prepared = prepareRuntime(flags);
  printWarnings(out, prepared.warnings);

  const confirmationExit = await confirmCommandScope(prepared, flags, out);
  if (confirmationExit !== null) return confirmationExit;

  const result = await runOnce({
    config: prepared.config,
    token: prepared.token,
    dataDir: prepared.dataDir,
    // 默认不写共享日志：once 不是实例，混进常驻实例日志会干扰排障。
    logFile: flags.logFile ? prepared.logFile : null,
    flags,
  });

  const last = result.last_task;
  const human = [
    `once 完成：pending ${result.pending}，计划 ${result.planned.length}，跳过 ${result.skipped.length}`,
    result.executed && last ? `  任务 ${last.task_id} → ${last.outcome}${last.card_id ? `（证据卡 ${last.card_id}）` : ''}` : '  未认领任务',
    ...(result.skipped.length > 0
      ? result.skipped.slice(0, 10).map((item) => `  跳过 ${item.task_id}：${item.reasons.join('；')}`)
      : []),
    ...(result.interrupted ? ['  收到停止信号，命令已在安全边界终止'] : []),
  ].join('\n');
  out.write(result, human);
  return 0;
}

/** `dry-run`：只读预览，不注册、不认领。 */
export async function dryRunCommand(flags, out) {
  const prepared = prepareRuntime(flags);
  printWarnings(out, prepared.warnings);
  if (flags.ensureChannel || flags.createTask !== undefined) {
    out.warn(
      'dry-run 不执行 channel.upsert / task.create（零副作用）；清单只包含当前已存在的 pending 任务',
    );
  }
  const result = await runDryRun({ config: prepared.config, token: prepared.token });

  const lines = [
    `dry-run：pending ${result.pending} 个，将执行 ${result.planned.length} 个，跳过 ${result.skipped.length} 个（不会认领、不会执行）`,
  ];
  for (const item of result.planned) {
    lines.push(
      `  计划 ${item.task_id} [${item.priority}] ${item.title}`,
      `       通道 ${item.channel_key}；规则 ${item.rule}；命令 ${item.argv.join(' ')}${item.cwd ? `（cwd ${item.cwd}）` : ''}`,
    );
  }
  for (const item of result.skipped) {
    lines.push(`  跳过 ${item.task_id}：${item.reasons.join('；')}`);
  }
  out.write(result, lines.join('\n'));
  return 0;
}

/**
 * `--command` 的执行前确认。
 *
 * 为什么需要：`--command` 会创建 match_all 规则并替换配置文件里的 commands，
 * 一条写错的 shell 命令会作用于队列里的所有 pending 任务。先列出“当前会被
 * 匹配到的任务”，只有用户显式加 `--yes` 才允许 start/once 继续。
 *
 * - 只在匹配任务数 > 0 时拦截；空队列没有必要多一步；
 * - 未带 `--yes`：只读列表（不注册、不认领、不执行），打印清单后退出 0；
 * - `dry-run` 不走这里，行为完全不变；
 * - 这里只打印“预览时”的清单；从预览到加 `--yes` 重跑之间任务队列可能变化，
 *   这是人工确认模型的固有窗口，不假装它是一份不可变快照。
 */
async function confirmCommandScope(prepared, flags, out) {
  if (flags.command === undefined || flags.yes === true) return null;

  const preview = await previewPendingTasks({ config: prepared.config, token: prepared.token });
  if (preview.planned.length === 0) return null;

  const planned = preview.planned.map(({ task, rule }) => ({
    task_id: task.id,
    title: task.title,
    channel_key: task.channel_key,
    priority: task.priority,
    due_at: task.due_at ?? null,
    assignee: task.assignee ?? null,
    rule: rule.name,
  }));
  const data = {
    requires_confirmation: true,
    reason: '--command 会创建 match_all 规则，先确认本次会匹配到的 pending 任务',
    pending: preview.pending,
    matched: planned.length,
    planned,
  };

  out.warn(
    `--command 匹配 ${planned.length} 个 pending 任务；未带 --yes，只打印清单，未认领、未执行`,
  );
  const lines = [
    `--command 将匹配 ${planned.length} 个 pending 任务（pending 总数 ${preview.pending}）；`,
    '当前仅预览：没有注册实例、没有认领、没有执行任何任务。',
  ];
  for (const item of planned) {
    lines.push(
      `  任务 ${item.task_id} [${item.priority}] ${item.title}（通道 ${item.channel_key}）`,
    );
  }
  lines.push(
    '核对命令与任务范围后，在命令末尾加 --yes 重新运行；本次退出码 0。',
    '提示：--command 按 shell 命令逐字执行，不是自然语言提示词；match_all 会作用于所有匹配任务。',
  );
  out.write(data, lines.join('\n'));
  return 0;
}

function appendStartupError(logFile, error) {
  if (!logFile) return;
  try {
    fs.appendFileSync(
      logFile,
      `[${new Date().toISOString()}] ERROR 后台实例启动失败：${errorMessage(error)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // 日志写不了时只能依赖父进程的通用提示。
  }
}
