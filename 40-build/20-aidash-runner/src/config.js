import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError } from './errors.js';
import { HARNESS_ID_PATTERN, HOME_CONFIG_RELATIVE, DEFAULT_CONFIG_FILENAME } from './constants.js';
import { parsePositiveNumber } from './args.js';
import { parseConfigObject, normalizeEndpoint } from './config-parse.js';
import { resolvePath, sanitizeInstanceId } from './util.js';

/**
 * 配置查找与覆盖。
 *
 * 查找顺序是规格写死的：--config > AIDASH_RUNNER_CONFIG > ./aidash-runner.json >
 * ~/.aidash/runner.json。显式指定的路径不存在必须报错——静默退回默认配置会让用户
 * 以为“新配置已生效”，实际跑的是旧规则，这在自动化值守里非常危险。
 */

export function findConfigPath(flags, env = process.env, cwd = process.cwd()) {
  if (flags.config) {
    return { path: resolvePath(flags.config, cwd), source: '--config', required: true };
  }
  const envPath = env.AIDASH_RUNNER_CONFIG?.trim();
  if (envPath) {
    return { path: resolvePath(envPath, cwd), source: 'AIDASH_RUNNER_CONFIG', required: true };
  }
  const local = path.resolve(cwd, DEFAULT_CONFIG_FILENAME);
  if (fs.existsSync(local)) return { path: local, source: 'cwd', required: false };
  const home = path.join(os.homedir(), '.aidash', HOME_CONFIG_RELATIVE);
  if (fs.existsSync(home)) return { path: home, source: 'home', required: false };
  return { path: null, source: 'none', required: false };
}

export function readConfigFile(configPath, warnings = []) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`读取配置文件失败：${configPath}（${reason}）；请检查路径与权限`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`配置文件不是合法 JSON：${configPath}（${reason}）`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`配置文件顶层必须是 JSON 对象：${configPath}`);
  }
  return parseConfigObject(raw, {
    configPath,
    configDir: path.dirname(configPath),
    warnings,
  });
}

/**
 * 读取并应用 CLI 覆盖。没有配置文件且没有 --command 时也返回默认配置，
 * 由命令层决定是“允许只读”还是“给出 init/--command 提示并退出 2”。
 */
export function loadConfig(flags, options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const found = findConfigPath(flags, env, cwd);
  const warnings = [];
  let config;

  if (!found.path) {
    config = parseConfigObject({}, { configPath: '', configDir: cwd });
    config.config_path = '';
  } else {
    if (!fs.existsSync(found.path)) {
      if (found.required) {
        throw new ConfigError(
          `配置文件不存在：${found.path}（来源：${found.source}）；请检查路径，或运行 aidash-runner init 生成示例配置`,
        );
      }
      config = parseConfigObject({}, { configPath: '', configDir: cwd });
      config.config_path = '';
    } else {
      config = readConfigFile(found.path, warnings);
    }
  }

  const applied = applyOverrides(config, flags, cwd);
  return {
    config: applied,
    warnings,
    configPath: found.path,
    configSource: found.source,
    hasConfigFile: Boolean(found.path),
  };
}

/** CLI 覆盖 > 配置文件 > 默认值。这里不碰 token（token 有独立且更严格的来源规则）。 */
export function applyOverrides(config, flags, cwd = process.cwd()) {
  const next = { ...config, commands: config.commands.map((item) => ({ ...item })) };

  if (flags.url) next.endpoint = normalizeEndpoint(flags.url);
  if (flags.harnessId) {
    if (!HARNESS_ID_PATTERN.test(flags.harnessId)) {
      throw new ConfigError('--harness-id 只能包含字母、数字、点、下划线、冒号、连字符（1..64 字符）');
    }
    next.harness_id = flags.harnessId;
  }
  if (flags.name) next.name = flags.name;
  if (flags.poll !== undefined) {
    next.poll_interval_seconds = parsePositiveNumber(flags.poll, '--poll', { min: 1, max: 86_400 });
  }
  if (flags.lease !== undefined) {
    next.lease_seconds = parsePositiveNumber(flags.lease, '--lease', { min: 1, max: 86_400, integer: true });
  }
  if (flags.heartbeat !== undefined) {
    next.heartbeat_interval_seconds = parsePositiveNumber(flags.heartbeat, '--heartbeat', {
      min: 1,
      max: 3_600,
      integer: true,
    });
  }
  if (flags.gap !== undefined) {
    next.gap_seconds = parsePositiveNumber(flags.gap, '--gap', { min: 0, max: 3_600 });
  }
  if (flags.channel.length > 0) {
    // 显式 --channel 覆盖配置里的 channels，而不是叠加：
    // “我这次只想跑这个通道”时叠加会把旧通道也带回来，和用户意图相反。
    next.channels = [...flags.channel];
  }
  if (flags.logFile) next.log_file = resolvePath(flags.logFile, cwd);

  if (flags.command !== undefined) {
    // --command 是“快速跑一个默认规则”，因此替代配置文件里的 commands，
    // 而不是追加。追加会让用户无法预测到底哪条规则命中。
    next.commands = [
      {
        name: 'cli-command',
        match: {
          tags: [],
          title_prefix: '',
          channel_key: '',
          priority: [],
          kind: [],
          match_all: true,
        },
        run: {
          argv: [flags.command],
          cwd: flags.cwd ? resolvePath(flags.cwd, cwd) : null,
          input: 'file',
          stdin: 'task_json',
          timeout_seconds: next.command_timeout_seconds,
          env: {},
          env_passthrough: [],
          result_file: null,
          shell: true,
        },
      },
    ];
  } else if (flags.cwd) {
    // 只给 --cwd 时，把默认规则（配置里的第一条）的 cwd 改掉没有歧义；
    // 多条规则时不猜，要求用户在配置里写 run.cwd。
    if (next.commands.length === 1) next.commands[0].run.cwd = resolvePath(flags.cwd, cwd);
    else if (next.commands.length > 1) {
      throw new ConfigError('--cwd 只在仅有一条命令规则或配合 --command 时可用；多条规则请在配置里写 run.cwd');
    }
  }
  return next;
}

export function resolveDataDir(flags, config, env = process.env, cwd = process.cwd()) {
  const explicit = flags.dataDir?.trim();
  if (explicit) return resolvePath(explicit, cwd);
  const fromEnv = env.AIDASH_RUNNER_HOME?.trim();
  if (fromEnv) return resolvePath(fromEnv, cwd);
  if (config.data_dir) return config.data_dir;
  return path.join(os.homedir(), '.aidash', 'runner');
}

export function resolveLogFile(flags, config, dataDir, instanceId, cwd = process.cwd()) {
  if (flags.logFile) return resolvePath(flags.logFile, cwd);
  if (config.log_file) return config.log_file;
  return path.join(dataDir, 'logs', `${instanceId}.log`);
}

export function instanceIdOf(config) {
  return sanitizeInstanceId(config.harness_id);
}

function validateToken(token, source) {
  if (!token) throw new ConfigError(`${source} 为空；请提供有效的 AIDash 访问令牌`);
  if (/\s/.test(token)) {
    throw new ConfigError(`${source} 含空白字符，格式不合法；请检查是否多复制了换行`);
  }
  if (token.length > 4_096) {
    throw new ConfigError(`${source} 长度超过 4096，格式不合法`);
  }
  return token;
}

/**
 * 凭据顺序：AIDASH_TOKEN > --token/--key > --token-file > AIDASH_PASSPHRASE。
 *
 * 口令放在最后作为兜底：它主要给“只设口令”的服务端使用，不应盖过显式的
 * 自动化令牌。注意环境变量优先意味着“命令行显式传的令牌可能被忽略”，
 * 这里返回 warning，命令层会打印；否则用户会拿一个没被使用的令牌去排查 401。
 */
export function resolveToken(flags, env = process.env, fsApi = fs) {
  const warnings = [];
  if (flags.token && flags.key) {
    throw new ConfigError('--token 与 --key 是同一参数的两种写法，只能给一个');
  }
  const envToken = env.AIDASH_TOKEN?.trim();
  if (envToken) {
    if (flags.token || flags.key) {
      warnings.push('AIDASH_TOKEN 环境变量优先，--token/--key 已忽略');
    }
    return { token: validateToken(envToken, 'AIDASH_TOKEN'), source: 'env', warnings };
  }
  const cliToken = flags.token ?? flags.key;
  if (cliToken) {
    const token = validateToken(cliToken.trim(), '--token/--key');
    warnings.push('命令行令牌只保存在内存；建议改用 AIDASH_TOKEN 或 --token-file，避免出现在 shell 历史/进程列表');
    return { token, source: 'cli', warnings };
  }
  if (flags.tokenFile) {
    const filePath = resolvePath(flags.tokenFile, process.cwd());
    let raw;
    try {
      raw = fsApi.readFileSync(filePath, 'utf8');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`读取 --token-file 失败：${filePath}（${reason}）；请检查路径与权限`);
    }
    return { token: validateToken(raw.trim(), '--token-file'), source: 'file', warnings };
  }
  // 仅口令启动的服务端：把口令当 Bearer 凭据使用。口令只在内存里，仍会被脱敏。
  const envPassphrase = env.AIDASH_PASSPHRASE?.trim();
  if (envPassphrase) {
    warnings.push('AIDASH_PASSPHRASE 已弃用，正在作为 AIDASH_TOKEN 使用；建议改成 AIDASH_TOKEN');
    return { token: validateToken(envPassphrase, 'AIDASH_PASSPHRASE'), source: 'passphrase', warnings };
  }
  throw new ConfigError(
    '缺少访问凭据：请设置 AIDASH_TOKEN（推荐，可填短口令），或使用 --token-file <path>；AIDASH_PASSPHRASE 仅作弃用别名',
  );
}

/** 合并后的配置里若没有任何命令规则，值守壳永远不会认领任务，提前说清楚。 */
export function assertHasCommands(config, hint = '') {
  if (config.commands.length > 0) return;
  throw new ConfigError(
    `配置里没有 commands 规则，值守壳不会认领任何任务${hint}；` +
      '请运行 `aidash-runner init` 生成示例配置，或用 `--command <cmd>` 快速启动一条 match_all 规则',
  );
}
