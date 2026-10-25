import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from './errors.js';
import { isSensitiveEnvKey, parseConfigObject } from './config-parse.js';
import { atomicWriteFileSync } from './util.js';

/**
 * 运行时配置白名单。
 *
 * 为什么“允许改”比“改得快”重要：
 * - poll/channels/gap 这类只影响下一轮循环，改了立刻生效且可回滚；
 * - harness_id/aidash_url/data_dir/log_file 影响注册、连接、文件位置，
 *   热改会让控制面、registry、子进程环境各说各话，必须重启。
 *
 * config set 遇到需要重启的键直接报错，不写文件、不假装生效。
 */
export const LIVE_CONFIG_KEYS = new Set([
  'poll_interval_seconds',
  'lease_seconds',
  'heartbeat_interval_seconds',
  'gap_seconds',
  'channels',
  'env_passthrough',
]);

export const RESTART_CONFIG_KEYS = new Set([
  'aidash_url',
  'token_env',
  'harness_id',
  'name',
  'host',
  'capabilities',
  'data_dir',
  'log_file',
  'commands',
  'command_timeout_seconds',
  'concurrency',
]);

const NUMBER_KEYS = {
  poll_interval_seconds: { min: 1, max: 86_400, integer: false },
  lease_seconds: { min: 1, max: 86_400, integer: true },
  heartbeat_interval_seconds: { min: 1, max: 3_600, integer: true },
  gap_seconds: { min: 0, max: 3_600, integer: false },
  command_timeout_seconds: { min: 1, max: 86_400, integer: true },
};

const ARRAY_KEYS = new Set(['channels', 'env_passthrough', 'capabilities']);

/**
 * 把 CLI 的字符串值转成配置需要的类型。
 * 数组同时支持 JSON 与逗号分隔：脚本里 `--json` 传数组更自然，手敲时逗号更省事。
 */
export function coerceConfigValue(key, raw) {
  if (NUMBER_KEYS[key]) {
    const spec = NUMBER_KEYS[key];
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (
      !Number.isFinite(value) ||
      value < spec.min ||
      value > spec.max ||
      (spec.integer && !Number.isInteger(value))
    ) {
      throw new ConfigError(
        `${key} 必须是 ${spec.min}..${spec.max} 之间的${spec.integer ? '整数' : '数字'}（收到 ${raw}）`,
      );
    }
    return value;
  }

  if (ARRAY_KEYS.has(key)) {
    let list;
    if (Array.isArray(raw)) {
      list = raw;
    } else {
      const text = String(raw).trim();
      if (!text) {
        list = [];
      } else if (text.startsWith('[')) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new ConfigError(`${key} 的 JSON 数组格式不合法：${text}`);
        }
        if (!Array.isArray(parsed)) throw new ConfigError(`${key} 必须是数组`);
        list = parsed;
      } else {
        list = text.split(',').map((item) => item.trim());
      }
    }
    const output = [];
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new ConfigError(`${key} 的每一项都必须是非空字符串`);
      }
      output.push(item.trim());
    }
    if (key === 'env_passthrough') {
      for (const item of output) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) {
          throw new ConfigError(`env_passthrough 含非法环境变量名：${item}`);
        }
        if (isSensitiveEnvKey(item)) {
          throw new ConfigError(
            `env_passthrough 不能放敏感变量 ${item}：白名单只放行普通变量，令牌请走 AIDASH_TOKEN`,
          );
        }
      }
    }
    return output;
  }

  // 区分“需要重启”和“根本不认识”：前者用户改配置文件即可，后者通常是拼写错误。
  if (RESTART_CONFIG_KEYS.has(key)) {
    throw new ConfigError(`${key} 不支持运行时修改；请修改配置文件后重启实例`);
  }
  throw new ConfigError(`未知配置项 ${key}；config set 只允许白名单键`);
}

export function assertLiveKey(key) {
  if (LIVE_CONFIG_KEYS.has(key)) return;
  if (RESTART_CONFIG_KEYS.has(key)) {
    throw new ConfigError(
      `${key} 需要重启实例才能生效；请修改配置文件后重启，或使用其它实例。` +
        '（config set 只支持 poll_interval_seconds/lease_seconds/heartbeat_interval_seconds/gap_seconds/channels/env_passthrough）',
    );
  }
  throw new ConfigError(`未知配置项 ${key}；config set 只允许白名单键`);
}

/**
 * 用现有有效配置 + patch 重新走一遍 schema 校验。
 *
 * 不直接改内存对象：一次 patch 可能让多个字段互相影响（例如 channels 清空、
 * webhook URL 等），统一经 parseConfigObject 校验才能保证“运行时配置”和
 * “重启后从文件读到的配置”是同一套规则。
 */
export function applyConfigPatch(config, patch) {
  const overrides = {};
  for (const [key, raw] of Object.entries(patch)) {
    assertLiveKey(key);
    overrides[key] = coerceConfigValue(key, raw);
  }
  const raw = configToRaw(config, overrides);
  return parseConfigObject(raw, {
    configPath: config.config_path,
    configDir: config.config_dir,
    warnings: [],
  });
}

/** 持久化：只改 raw 文件里的目标键，保留注释以外的未知字段（JSON 无注释）。 */
export function persistConfigPatch(config, patch) {
  if (!config.config_path) {
    throw new ConfigError('当前实例没有配置文件（可能来自 --command），无法 --persist；请先 init 或用 --config 指定文件');
  }
  let rawText;
  try {
    rawText = fs.readFileSync(config.config_path, 'utf8');
  } catch (error) {
    throw new ConfigError(`读取配置文件失败：${config.config_path}（${error.message}）`);
  }
  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new ConfigError(`配置文件不是合法 JSON：${config.config_path}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`配置文件顶层必须是对象：${config.config_path}`);
  }
  for (const [key, value] of Object.entries(patch)) {
    assertLiveKey(key);
    raw[key] = value;
  }
  // 写之前先按完整 schema 校验，避免把错误配置落盘；重启时才爆出来。
  parseConfigObject(raw, {
    configPath: config.config_path,
    configDir: path.dirname(config.config_path),
  });
  atomicWriteFileSync(config.config_path, `${JSON.stringify(raw, null, 2)}\n`, 0o600);
}

/**
 * 有效配置 → 接近原始文件的形状，用于重新校验。
 * 路径此时已是绝对路径，parseConfigObject 对绝对路径不会再拼接 configDir。
 */
export function configToRaw(config, overrides = {}) {
  return {
    aidash_url: config.endpoint,
    token_env: config.token_env,
    harness_id: config.harness_id,
    name: config.name,
    host: config.host ?? undefined,
    capabilities: config.capabilities,
    channels: overrides.channels ?? config.channels,
    poll_interval_seconds: overrides.poll_interval_seconds ?? config.poll_interval_seconds,
    lease_seconds: overrides.lease_seconds ?? config.lease_seconds,
    heartbeat_interval_seconds:
      overrides.heartbeat_interval_seconds ?? config.heartbeat_interval_seconds,
    gap_seconds: overrides.gap_seconds ?? config.gap_seconds,
    command_timeout_seconds: overrides.command_timeout_seconds ?? config.command_timeout_seconds,
    data_dir: config.data_dir || undefined,
    log_file: config.log_file || undefined,
    env_passthrough: overrides.env_passthrough ?? config.env_passthrough,
    commands: config.commands.map((rule) => ({
      name: rule.name,
      match: {
        tags: rule.match.tags,
        title_prefix: rule.match.title_prefix,
        channel_key: rule.match.channel_key,
        priority: rule.match.priority,
        kind: rule.match.kind,
        match_all: rule.match.match_all,
      },
      run: {
        argv: rule.run.argv,
        cwd: rule.run.cwd ?? undefined,
        input: rule.run.input,
        stdin: rule.run.stdin,
        timeout_seconds: rule.run.timeout_seconds,
        env: rule.run.env,
        env_passthrough: rule.run.env_passthrough,
        result_file: rule.run.result_file ?? undefined,
        shell: rule.run.shell,
      },
    })),
  };
}

/** 可安全展示的配置视图：没有任何令牌字段。 */
export function configView(config) {
  return {
    config_path: config.config_path,
    aidash_url: config.endpoint,
    token_env: config.token_env,
    harness_id: config.harness_id,
    name: config.name,
    host: config.host,
    capabilities: config.capabilities,
    channels: config.channels,
    poll_interval_seconds: config.poll_interval_seconds,
    lease_seconds: config.lease_seconds,
    heartbeat_interval_seconds: config.heartbeat_interval_seconds,
    gap_seconds: config.gap_seconds,
    command_timeout_seconds: config.command_timeout_seconds,
    data_dir: config.data_dir,
    log_file: config.log_file,
    env_passthrough: config.env_passthrough,
    commands: config.commands,
  };
}
