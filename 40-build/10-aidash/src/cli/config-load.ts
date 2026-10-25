import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, errorMessage } from './errors.js';
import {
  DEFAULT_CONFIG_FILE,
  DEFAULT_MCP_ENDPOINT,
  normalizeEndpoint,
  type CommandRule,
  type LoadedWatchConfig,
  type WatchConfig,
} from './config.js';

/**
 * aidash-watch.json 解析与校验。
 *
 * 设计取舍：
 * - 一次性收集所有问题再报错（而不是遇到第一个就退出），用户改配置不用来回试；
 * - 命令规则必须显式声明匹配条件或 match_all=true，防止“少写一个字段就把所有任务都跑了”；
 * - 令牌没有配置项，只从 AIDASH_TOKEN 读；`token_env` 字段只做兼容告警，不生效。
 */

const SENSITIVE_ENV_KEYS = new Set(['AIDASH_TOKEN', 'AIDASH_LLM_API_KEY']);
const HARNESS_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
  issues: string[],
): string {
  const value = asString(record[key])?.trim();
  if (!value) {
    issues.push(`${label} 必填且必须是非空字符串`);
    return '';
  }
  if (value.length > maxLength) issues.push(`${label} 超过 ${maxLength} 字符`);
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
  fallback: number,
  min: number,
  max: number,
  issues: string[],
  integer = false,
): number {
  const value = record[key];
  if (value === undefined || value === null) return fallback;
  const parsed = asFiniteNumber(value);
  if (
    parsed === null ||
    parsed < min ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  ) {
    issues.push(`${label} 必须是 ${min}..${max} 之间的${integer ? '整数' : '数字'}`);
    return fallback;
  }
  return parsed;
}

function optionalStringArray(value: unknown, label: string, issues: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${label} 必须是字符串数组`);
    return [];
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      issues.push(`${label} 含非字符串或空值`);
      continue;
    }
    output.push(item.trim());
  }
  return output;
}

function parseRuleEnv(
  value: unknown,
  label: string,
  issues: string[],
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    issues.push(`${label} 必须是对象`);
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_ENV_KEYS.has(key.toUpperCase())) {
      issues.push(`${label}.${key} 不允许设置敏感环境变量`);
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      issues.push(`${label}.${key} 不是合法环境变量名`);
      continue;
    }
    if (typeof raw === 'string') env[key] = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') env[key] = String(raw);
    else issues.push(`${label}.${key} 必须是字符串、数字或布尔值`);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function parseCommandRule(
  value: unknown,
  index: number,
  configDir: string,
  defaultTimeout: number,
  issues: string[],
  warnings: string[],
): CommandRule | null {
  const label = `commands[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${label} 必须是对象`);
    return null;
  }
  const command = asString(value.command)?.trim();
  if (!command) {
    issues.push(`${label}.command 必填且必须是非空字符串`);
    return null;
  }
  const tags = optionalStringArray(value.tags, `${label}.tags`, issues);
  const titlePrefix = asString(value.title_prefix)?.trim() ?? '';
  const channelKey = asString(value.channel_key)?.trim() ?? '';
  const matchAll = value.match_all === true;
  if (!matchAll && tags.length === 0 && !titlePrefix && !channelKey) {
    issues.push(
      `${label} 至少需要 tags、title_prefix、channel_key 之一，或显式 match_all=true（防止误跑所有任务）`,
    );
  }
  const timeoutSeconds = optionalNumber(
    value,
    'timeout_seconds',
    `${label}.timeout_seconds`,
    defaultTimeout,
    1,
    86_400,
    issues,
    true,
  );
  const cwdRaw = asString(value.cwd)?.trim();
  const env = parseRuleEnv(value.env, `${label}.env`, issues);

  const knownKeys = new Set([
    'command',
    'tags',
    'title_prefix',
    'channel_key',
    'match_all',
    'timeout_seconds',
    'cwd',
    'env',
  ]);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) warnings.push(`${label} 含未知字段 ${key}，已忽略`);
  }

  return {
    command,
    tags,
    ...(titlePrefix ? { title_prefix: titlePrefix } : {}),
    ...(channelKey ? { channel_key: channelKey } : {}),
    ...(matchAll ? { match_all: true } : {}),
    timeout_seconds: timeoutSeconds,
    ...(cwdRaw ? { cwd: path.resolve(configDir, cwdRaw) } : {}),
    ...(env ? { env } : {}),
  };
}

/**
 * 读取配置。显式 --config 不存在 → 报错；默认文件不存在 → 返回 null，
 * 由 index 决定是否允许“只读 status”的安全默认。
 */
export function loadWatchConfig(explicitPath?: string): LoadedWatchConfig {
  const configPath = explicitPath
    ? path.resolve(process.cwd(), explicitPath)
    : path.resolve(process.cwd(), DEFAULT_CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    if (explicitPath) throw new ConfigError(`配置文件不存在：${configPath}`);
    return { config: null, warnings: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new ConfigError(`配置文件不是合法 JSON：${configPath}（${errorMessage(error)}）`);
  }
  if (!isRecord(raw)) {
    throw new ConfigError(`配置文件顶层必须是 JSON 对象：${configPath}`);
  }

  const issues: string[] = [];
  const warnings: string[] = [];
  const configDir = path.dirname(configPath);

  const harnessId = requiredString(raw, 'harness_id', 'harness_id', 64, issues);
  if (harnessId && !HARNESS_ID_PATTERN.test(harnessId)) {
    issues.push('harness_id 只能包含字母、数字、点、下划线、冒号、连字符');
  }
  const name = requiredString(raw, 'name', 'name', 128, issues);
  const channels = optionalStringArray(raw.channels, 'channels', issues);
  const capabilities = optionalStringArray(raw.capabilities, 'capabilities', issues);
  const hostRaw = asString(raw.host)?.trim() ?? '';
  if (hostRaw.length > 128) issues.push('host 超过 128 字符');

  const pollInterval = optionalNumber(
    raw,
    'poll_interval_seconds',
    'poll_interval_seconds',
    60,
    1,
    86_400,
    issues,
  );
  const leaseSeconds = optionalNumber(
    raw,
    'lease_seconds',
    'lease_seconds',
    900,
    1,
    86_400,
    issues,
    true,
  );
  const heartbeatInterval = optionalNumber(
    raw,
    'heartbeat_interval_seconds',
    'heartbeat_interval_seconds',
    30,
    1,
    3_600,
    issues,
    true,
  );
  const gapSeconds = optionalNumber(raw, 'gap_seconds', 'gap_seconds', 2, 0, 3_600, issues);
  const commandTimeout = optionalNumber(
    raw,
    'command_timeout_seconds',
    'command_timeout_seconds',
    1800,
    1,
    86_400,
    issues,
    true,
  );

  // 设计文档里的 concurrency 目前固定为 1：并发会改变租约与证据卡顺序，V2.0 不做。
  if (raw.concurrency !== undefined) {
    const concurrency = asFiniteNumber(raw.concurrency);
    if (concurrency !== 1) issues.push('concurrency 目前只支持 1（并发执行多个任务不在 V2.0 范围）');
  }

  // 兼容性提示：这些字段在 03/04 的设计稿里出现过，但本实现按用户确认的 CLI 契约走 commands 规则。
  const unsupported: Array<[string, string]> = [
    ['token_env', 'token_env 已忽略：令牌只从环境变量 AIDASH_TOKEN 读取'],
    ['harness', 'harness 字段未启用：请改用 commands 规则（command + tags/title_prefix/channel_key）'],
    ['tags', '顶层 tags 未启用：请在 commands[].tags 中声明匹配标签'],
    ['retry', 'retry 未启用：失败回报后由用户决定是否重试'],
    ['log_dir', 'log_dir 未启用：CLI 日志写 stderr，命令输出摘录写入状态卡'],
  ];
  for (const [key, message] of unsupported) {
    if (raw[key] !== undefined) warnings.push(message);
  }

  const knownTopLevel = new Set([
    'aidash_url',
    'harness_id',
    'name',
    'host',
    'capabilities',
    'channels',
    'poll_interval_seconds',
    'lease_seconds',
    'heartbeat_interval_seconds',
    'gap_seconds',
    'command_timeout_seconds',
    'concurrency',
    'commands',
    ...unsupported.map(([key]) => key),
  ]);
  for (const key of Object.keys(raw)) {
    if (!knownTopLevel.has(key)) warnings.push(`未知配置项 ${key}，已忽略`);
  }

  // 环境变量 > 配置文件 > 默认值。
  let endpointRaw = DEFAULT_MCP_ENDPOINT;
  const configUrl = asString(raw.aidash_url)?.trim();
  if (configUrl) endpointRaw = configUrl;
  const envUrl = process.env.AIDASH_URL?.trim();
  if (envUrl) {
    if (configUrl && envUrl !== configUrl) {
      warnings.push('AIDASH_URL 环境变量覆盖了配置文件里的 aidash_url');
    }
    endpointRaw = envUrl;
  }
  let endpoint = DEFAULT_MCP_ENDPOINT;
  try {
    endpoint = normalizeEndpoint(endpointRaw);
  } catch (error) {
    issues.push(errorMessage(error));
  }

  const commands: CommandRule[] = [];
  if (raw.commands !== undefined) {
    if (!Array.isArray(raw.commands)) {
      issues.push('commands 必须是数组');
    } else {
      raw.commands.forEach((item, index) => {
        const rule = parseCommandRule(
          item,
          index,
          configDir,
          commandTimeout,
          issues,
          warnings,
        );
        if (rule) commands.push(rule);
      });
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(`配置无效（${configPath}）：\n- ${issues.join('\n- ')}`);
  }

  const config: WatchConfig = {
    endpoint,
    harness_id: harnessId,
    name,
    host: hostRaw || null,
    capabilities,
    channels,
    poll_interval_seconds: pollInterval,
    lease_seconds: leaseSeconds,
    heartbeat_interval_seconds: heartbeatInterval,
    gap_seconds: gapSeconds,
    command_timeout_seconds: commandTimeout,
    commands,
    config_path: configPath,
    config_dir: configDir,
  };
  return { config, warnings };
}
