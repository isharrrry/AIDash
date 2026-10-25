import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStatusConfig, readToken, type WatchConfig } from './config.js';
import { loadWatchConfig } from './config-load.js';
import { CliError, ConfigError, errorMessage } from './errors.js';
import { createLogger, readLogLevel, redact, truncate } from './log.js';
import type { Logger } from './log.js';
import { isTaskAssignableTo, matchesChannelFilter, selectCommandRule } from './match.js';
import { AidashMcpClient } from './mcp-client.js';
import { parseDigest, type TaskItem } from './mcp-parse.js';
import { listTasks, runWatch, type RunMode } from './runner.js';

/**
 * aidash-watch 入口：参数解析与命令分发。
 *
 * 退出码（按本次任务约定，覆盖 04 §7.2 的旧表述）：
 * - 0：正常结束（含 Ctrl+C 优雅停止）；
 * - 1：业务错误（服务端拒绝、证据缺失、任务回报失败等）；
 * - 2：配置/认证/传输错误（令牌缺失、401、配置非法、连不上 MCP）。
 *
 * status / dry-run 是只读命令：不注册、不心跳、不认领、不建卡、不改任务。
 * 这样用户可以在不惊动值守流程的情况下先看“会发生什么”。
 */

const CLI_VERSION = '2.0.0';
const MAX_TASKS_PRINTED = 20;

type CommandName = 'run' | 'once' | 'status' | 'dry-run' | 'help';

interface ParsedArgs {
  command: CommandName;
  configPath?: string;
  help: boolean;
  version: boolean;
}

const HELP = `aidash-watch ${CLI_VERSION} — AIDash V2.0 值守壳（纯 MCP 客户端）

用法：
  aidash-watch run [--config <file>]      常驻：注册、心跳、轮询、认领、执行、回报
  aidash-watch once [--config <file>]     只跑一轮（最多一个任务）
  aidash-watch status [--config <file>]   只读：打印摘要与任务，不写库
  aidash-watch dry-run [--config <file>]  只读：列出将认领的任务与命令，不执行
  aidash-watch --version
  aidash-watch --help

环境变量：
  AIDASH_URL              MCP 端点，默认 http://127.0.0.1:8787/mcp
  AIDASH_TOKEN            必需；只从环境变量读取，绝不打印
  AIDASH_WATCH_LOG_LEVEL  debug|info|warn|error，默认 info

退出码：
  0 正常；1 业务错误；2 配置/认证/传输错误
`;

export function parseArgs(argv: string[]): ParsedArgs {
  let command: CommandName | null = null;
  let configPath: string | undefined;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      version = true;
      continue;
    }
    if (arg === '--config') {
      const value = argv[index + 1];
      if (!value) throw new ConfigError('--config 需要一个文件路径');
      configPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (!value) throw new ConfigError('--config 需要一个文件路径');
      configPath = value;
      continue;
    }
    if (arg.startsWith('-')) throw new ConfigError(`未知参数：${arg}`);
    if (command !== null) throw new ConfigError(`只能指定一个命令：${command} / ${arg}`);
    if (arg === 'run' || arg === 'once' || arg === 'status' || arg === 'dry-run') {
      command = arg;
      continue;
    }
    throw new ConfigError(`未知命令：${arg}（可用：run / once / status / dry-run）`);
  }

  return {
    command: command ?? 'help',
    ...(configPath ? { configPath } : {}),
    help,
    version,
  };
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.version) {
    writeOut(`aidash-watch ${CLI_VERSION}`);
    return 0;
  }
  if (parsed.help || parsed.command === 'help') {
    writeOut(HELP.trimEnd());
    return 0;
  }

  const logger = createLogger(readLogLevel());
  const token = readToken();
  const loaded = loadWatchConfig(parsed.configPath);
  for (const warning of loaded.warnings) logger.warn(warning);

  let config: WatchConfig;
  if (loaded.config) {
    config = loaded.config;
  } else {
    // 安全默认：没有配置就只允许看，不允许认领/执行。
    if (parsed.command !== 'status') {
      throw new ConfigError(
        '未找到 aidash-watch.json：未加载配置时只允许 status，不会认领或执行任何命令',
      );
    }
    config = defaultStatusConfig();
    logger.warn('未找到配置文件，使用只读 status 默认配置');
  }

  if (
    (parsed.command === 'run' || parsed.command === 'once') &&
    config.commands.length === 0
  ) {
    // 没有命令规则时永远不会认领任务；提前说清楚，避免用户以为值守壳“卡住了”。
    logger.warn('配置中没有 commands 规则：值守壳不会认领或执行任何任务');
  }

  logger.debug(`命令=${parsed.command} 端点=${config.endpoint} harness=${config.harness_id}`);
  const client = new AidashMcpClient({
    endpoint: config.endpoint,
    token,
    clientVersion: CLI_VERSION,
  });

  try {
    await client.connect();
    switch (parsed.command) {
      case 'status':
        await printStatus(client, config);
        return 0;
      case 'dry-run':
        await printDryRun(client, config);
        return 0;
      case 'run':
      case 'once':
        return await runWithSignals(client, config, logger, parsed.command);
      default:
        throw new ConfigError(`未知命令：${parsed.command}`);
    }
  } finally {
    await client.close();
  }
}

async function runWithSignals(
  client: AidashMcpClient,
  config: WatchConfig,
  logger: Logger,
  mode: RunMode,
): Promise<number> {
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupted) return;
    interrupted = true;
    logger.warn(`收到 ${signal}，准备优雅停止（再按一次强制退出）`);
    controller.abort();
  };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');

  // process.once：第一次信号由我们接管；第二次走 Node 默认行为，进程立即结束。
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await runWatch({ client, config, logger, signal: controller.signal }, mode);
    return 0;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

async function printStatus(client: AidashMcpClient, config: WatchConfig): Promise<void> {
  const digestRaw = await client.call<unknown>('digest.get', {}, { timeoutMs: 20_000 });
  const digest = parseDigest(digestRaw);
  const pending = await listTasks(client, { status: 'pending' });
  const mine = await listTasks(client, { assignee: config.harness_id });

  writeOut('AIDash 值守状态');
  writeOut(`  端点        ${config.endpoint}`);
  writeOut(`  harness     ${config.harness_id}（${config.name}）`);
  if (config.config_path) writeOut(`  配置        ${config.config_path}`);
  writeOut(`  待决策      ${digest.pending_decisions}`);
  writeOut(`  P0 / P1 卡  ${digest.p0_cards} / ${digest.p1_cards}`);
  writeOut(`  活跃通道    ${digest.channels_active}`);
  writeOut(`  待认领任务  ${pending.length}`);
  writeOut(`  我的任务    ${mine.length}`);

  const counts = countByStatus(mine);
  if (counts.size > 0) {
    const summary = [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(' ');
    writeOut(`  我的状态    ${summary}`);
  }
  if (pending.length === 0) {
    writeOut('  暂无可认领任务');
    return;
  }
  writeOut(`  可认领任务（最多显示 ${MAX_TASKS_PRINTED} 个）：`);
  for (const task of pending.slice(0, MAX_TASKS_PRINTED)) {
    writeOut(`    - ${task.id} [${task.status}] ${task.title}（${task.channel_key}）`);
  }
}

async function printDryRun(client: AidashMcpClient, config: WatchConfig): Promise<void> {
  const pending = await listTasks(client, { status: 'pending' });
  writeOut(`dry-run：待认领任务 ${pending.length} 个；不会认领、不会启动进程。`);
  if (config.commands.length === 0) {
    writeOut('配置中没有 commands 规则：所有任务都会被跳过。');
  }

  let planned = 0;
  for (const task of pending) {
    const reasons = skipReasons(task, config);
    const rule = reasons.length === 0 ? selectCommandRule(task, config.commands) : null;
    if (rule) {
      planned += 1;
      writeOut(
        `  [将认领] ${task.id} ${task.title} -> ${truncate(redact(rule.command), 160)}`,
      );
      continue;
    }
    const why = reasons.length > 0 ? reasons.join('；') : '没有匹配的 command 规则';
    writeOut(`  [跳过]   ${task.id} ${task.title}：${why}`);
  }
  writeOut(`命中 ${planned} 个任务。`);
}

function skipReasons(task: TaskItem, config: WatchConfig): string[] {
  const reasons: string[] = [];
  if (!isTaskAssignableTo(task, config.harness_id)) {
    reasons.push(`assignee=${task.assignee ?? '空'} 不是 ${config.harness_id}`);
  }
  if (!matchesChannelFilter(task.channel_key, config.channels)) {
    reasons.push(`通道 ${task.channel_key} 不在 channels 内`);
  }
  return reasons;
}

function countByStatus(tasks: TaskItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  return counts;
}

function writeOut(line: string): void {
  // stdout 也会带用户数据（任务标题、通道名）；统一脱敏，避免令牌被间接回显。
  process.stdout.write(`${redact(line)}\n`);
}

/**
 * 只有“被当作脚本执行”时才跑入口；被测试 import 时不要自动联网。
 * esbuild 产物同样走这个判断：argv[1] 就是 dist/cli/aidash-watch.mjs。
 */
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const logger = createLogger(readLogLevel());
    if (error instanceof CliError) {
      logger.error(`${error.code}: ${error.message}`);
      process.exitCode = error.exitCode;
    } else {
      logger.error(`未预期错误：${errorMessage(error)}`);
      if (process.env.AIDASH_WATCH_DEBUG === '1' && error instanceof Error && error.stack) {
        logger.debug(error.stack);
      }
      process.exitCode = 2;
    }
  }
}
