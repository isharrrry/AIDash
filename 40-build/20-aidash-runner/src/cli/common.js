import {
  assertHasCommands,
  instanceIdOf,
  loadConfig,
  resolveDataDir,
  resolveLogFile,
  resolveToken,
} from '../config.js';
import { normalizeResumeEngine } from '../claude-session.js';
import { validateSetupFlags } from '../channel-setup.js';
import { ConfigError } from '../errors.js';
import { inspectRegistryEntry, readRegistryEntry } from '../registry.js';

/**
 * start / once / dry-run 共用的启动前准备。
 *
 * 缺配置且没有 --command 时必须在解析令牌之前就报“怎么启动”，否则用户会先看到
 * “缺少 AIDASH_TOKEN”，误以为只差一个令牌，实际连规则都没有。
 */
export function prepareRuntime(flags, { requireCommands = true, requireToken = true } = {}) {
  const loaded = loadConfig(flags);
  // loadConfig 返回的字段名是 configPath（同时 config.config_path 也可用）；
  // 这里不能读 loaded.config_path——写错会让“有配置文件”也报成“没找到配置”。
  if (!loaded.configPath && flags.command === undefined) {
    throw new ConfigError(
      '没有找到配置文件（依次查找 --config、AIDASH_RUNNER_CONFIG、./aidash-runner.json、' +
        '~/.aidash/runner.json），也没有 --command；' +
        '请运行 `aidash-runner init` 生成示例配置，或用 `--command <cmd>` 快速启动一条 match_all 规则',
    );
  }
  if (requireCommands) assertHasCommands(loaded.config);
  // 新参数在解析令牌之前校验：否则缺令牌会让用户误以为只差凭据。
  validateSetupFlags(flags);
  normalizeResumeEngine(flags.resume);

  let tokenInfo = { token: null, source: null, warnings: [] };
  if (requireToken) tokenInfo = resolveToken(flags);

  const config = loaded.config;
  const dataDir = resolveDataDir(flags, config);
  const instanceId = instanceIdOf(config);
  const logFile = resolveLogFile(flags, config, dataDir, instanceId, process.cwd());

  const warnings = [...loaded.warnings, ...tokenInfo.warnings];
  if (flags.command !== undefined) {
    // 用户很容易把 --command 当成“给 AI 的提示词”；它实际上是逐字执行的 shell
    // 命令，且匹配规则是 match_all（会作用于所有可认领任务）。启动时明确提示，
    // 避免任务被意外的命令跑掉。
    warnings.unshift(
      '--command 按 shell 命令执行；自然语言不会被 AI 解释，且 match_all 会作用于所有匹配任务',
    );
  }

  return {
    loaded,
    config,
    warnings,
    token: tokenInfo.token,
    tokenSource: tokenInfo.source,
    dataDir,
    instanceId,
    logFile,
    configPath: loaded.configPath,
  };
}

export function printWarnings(out, warnings) {
  for (const message of warnings ?? []) out.warn(message);
}

/** 后台启动前先确认同一实例没有在跑，避免父进程白等 15 秒。 */
export async function ensureNotRunning(dataDir, instanceId) {
  const entry = readRegistryEntry(dataDir, instanceId);
  if (!entry) return;
  const status = await inspectRegistryEntry(entry, { timeoutMs: 1_000 });
  if (status.alive && entry.pid !== process.pid) {
    throw new ConfigError(
      `实例 ${instanceId} 已在运行（pid ${entry.pid}，控制面 ${entry.control_url}）；` +
        '请先 `aidash-runner stop`，或换一个 harness_id / 配置文件',
    );
  }
}

export function tokenSourceLabel(source) {
  switch (source) {
    case 'env':
      return 'AIDASH_TOKEN';
    case 'cli':
      return '--token/--key（仅内存）';
    case 'file':
      return '--token-file';
    case 'passphrase':
      return 'AIDASH_PASSPHRASE（口令）';
    default:
      return '(无)';
  }
}
