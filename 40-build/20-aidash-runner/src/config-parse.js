import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_ENV_PASSTHROUGH,
  DEFAULT_GAP_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_MCP_ENDPOINT,
  DEFAULT_POLL_SECONDS,
  FORBIDDEN_ENV_KEYS,
  HARNESS_ID_PATTERN,
  SENSITIVE_ENV_SUFFIX,
  defaultHarnessId,
  defaultInstanceName,
} from './constants.js';
import { ConfigError } from './errors.js';
import { isRecord, resolvePath } from './util.js';

/**
 * 配置 schema。一次收集所有问题再报错：用户改配置不该来回试十次。
 *
 * 最重要的安全校验是“无条件规则必须 match_all=true”：
 * 少写一个 tags 就把所有 pending 任务拉起来跑，是这类工具最危险的默认行为。
 */

const TOP_LEVEL_KEYS = new Set([
  'aidash_url',
  'token_env',
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
  'data_dir',
  'log_file',
  'env_passthrough',
  'commands',
  'concurrency',
]);

const MATCH_KEYS = new Set([
  'tags',
  'title_prefix',
  'channel_key',
  'priority',
  'kind',
  'match_all',
]);

const RUN_KEYS = new Set([
  'argv',
  'cwd',
  'input',
  'stdin',
  'timeout_seconds',
  'env',
  'env_passthrough',
  'result_file',
  'shell',
]);

export function isSensitiveEnvKey(key) {
  const upper = String(key).toUpperCase();
  if (FORBIDDEN_ENV_KEYS.includes(upper)) return true;
  return SENSITIVE_ENV_SUFFIX.some((suffix) => upper.endsWith(suffix));
}

export function normalizeEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`aidash_url 不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('aidash_url 只支持 http/https');
  }
  if (url.username || url.password) {
    throw new ConfigError('aidash_url 不能内嵌账号密码；令牌只从 AIDASH_TOKEN/--token-file 读取');
  }
  url.hash = '';
  url.search = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/mcp')) pathname = `${pathname}/mcp`;
  url.pathname = pathname;
  return url.toString();
}

export function defaultConfig() {
  return {
    endpoint: DEFAULT_MCP_ENDPOINT,
    token_env: 'AIDASH_TOKEN',
    harness_id: defaultHarnessId(),
    name: defaultInstanceName(),
    host: null,
    capabilities: [],
    channels: [],
    poll_interval_seconds: DEFAULT_POLL_SECONDS,
    lease_seconds: DEFAULT_LEASE_SECONDS,
    heartbeat_interval_seconds: DEFAULT_HEARTBEAT_SECONDS,
    gap_seconds: DEFAULT_GAP_SECONDS,
    command_timeout_seconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
    data_dir: '',
    log_file: '',
    env_passthrough: [...DEFAULT_ENV_PASSTHROUGH],
    commands: [],
    config_path: '',
    config_dir: process.cwd(),
  };
}

function stringField(record, key, label, maxLength, issues, fallback = '') {
  const value = record[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    issues.push(`${label} 必须是字符串`);
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) issues.push(`${label} 超过 ${maxLength} 字符`);
  return trimmed;
}

function numberField(record, key, label, fallback, min, max, issues, integer = false) {
  const value = record[key];
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    issues.push(`${label} 必须是 ${min}..${max} 之间的${integer ? '整数' : '数字'}`);
    return fallback;
  }
  return value;
}

function stringArrayField(record, key, label, issues) {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${label} 必须是字符串数组`);
    return [];
  }
  const output = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      issues.push(`${label}[${index}] 必须是非空字符串`);
      return;
    }
    output.push(item.trim());
  });
  return output;
}

function parseEnvMap(value, label, issues, warnings) {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    issues.push(`${label} 必须是对象`);
    return {};
  }
  const env = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      issues.push(`${label}.${key} 不是合法环境变量名`);
      continue;
    }
    if (isSensitiveEnvKey(key)) {
      issues.push(`${label}.${key} 是敏感变量名，不允许在配置里设置（令牌只从环境/--token-file 读取）`);
      continue;
    }
    if (typeof raw === 'string') env[key] = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') env[key] = String(raw);
    else issues.push(`${label}.${key} 必须是字符串、数字或布尔值`);
  }
  if (Object.keys(env).length === 0) return {};
  // 这里不警告“空对象”，用户显式写 {} 是正常意图。
  void warnings;
  return env;
}

function parsePassthrough(value, label, issues, warnings) {
  const raw = stringArrayField(value === undefined ? {} : { [label]: value }, label, issues);
  const output = [];
  for (const key of raw) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      issues.push(`${label} 含非法变量名：${key}`);
      continue;
    }
    if (isSensitiveEnvKey(key)) {
      warnings.push(`${label} 里的敏感变量 ${key} 已被忽略（白名单不会放行令牌/密钥）`);
      continue;
    }
    output.push(key);
  }
  return output;
}

function parseMatch(value, label, issues, warnings) {
  const raw = value === undefined || value === null ? {} : value;
  if (!isRecord(raw)) {
    issues.push(`${label} 必须是对象`);
    return { match_all: false, tags: [], priority: [], kind: [] };
  }
  for (const key of Object.keys(raw)) {
    if (!MATCH_KEYS.has(key)) warnings.push(`${label} 含未知字段 ${key}，已忽略`);
  }
  const tags = stringArrayField(raw, 'tags', `${label}.tags`, issues);
  const titlePrefix = stringField(raw, 'title_prefix', `${label}.title_prefix`, 200, issues);
  const channelKey = stringField(raw, 'channel_key', `${label}.channel_key`, 500, issues);
  const priority = normalizeEnumList(raw.priority, `${label}.priority`, ['P0', 'P1', 'P2', 'P3'], issues);
  const kind = normalizeEnumList(raw.kind, `${label}.kind`, ['task', 'suggestion'], issues);
  const matchAll = raw.match_all === true;
  if (raw.match_all !== undefined && typeof raw.match_all !== 'boolean') {
    issues.push(`${label}.match_all 必须是布尔值`);
  }
  const hasSelector =
    tags.length > 0 || Boolean(titlePrefix) || Boolean(channelKey) || priority.length > 0 || kind.length > 0;
  if (!hasSelector && !matchAll) {
    issues.push(
      `${label} 没有任何匹配条件时必须显式写 match_all=true（防止少写一个字段就把所有任务都跑了）`,
    );
  }
  return {
    tags,
    title_prefix: titlePrefix,
    channel_key: channelKey,
    priority,
    kind,
    match_all: matchAll,
  };
}

function normalizeEnumList(value, label, allowed, issues) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  const output = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) {
      issues.push(`${label} 必须是字符串或字符串数组`);
      continue;
    }
    const normalized = item.trim();
    if (!allowed.includes(normalized)) {
      issues.push(`${label} 只能是 ${allowed.join('/')}（收到 ${normalized}）`);
      continue;
    }
    output.push(normalized);
  }
  return output;
}

function parseRun(value, label, configDir, defaultTimeout, issues, warnings) {
  if (!isRecord(value)) {
    issues.push(`${label} 必须是对象`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!RUN_KEYS.has(key)) warnings.push(`${label} 含未知字段 ${key}，已忽略`);
  }

  const argvRaw = value.argv;
  if (!Array.isArray(argvRaw) || argvRaw.length === 0) {
    issues.push(`${label}.argv 必须是非空字符串数组（默认不走 shell）`);
  }
  const argv = [];
  if (Array.isArray(argvRaw)) {
    argvRaw.forEach((item, index) => {
      if (typeof item !== 'string' || item.length === 0) {
        issues.push(`${label}.argv[${index}] 必须是非空字符串`);
        return;
      }
      if (item.includes('\u0000')) {
        issues.push(`${label}.argv[${index}] 含 NUL 字符`);
        return;
      }
      argv.push(item);
    });
  }

  const input = stringField(value, 'input', `${label}.input`, 16, issues, 'file') || 'file';
  if (!['file', 'stdin', 'none'].includes(input)) {
    issues.push(`${label}.input 只能是 file/stdin/none`);
  }
  const stdin = stringField(value, 'stdin', `${label}.stdin`, 16, issues, 'task_json') || 'task_json';
  if (!['task_json', 'task_md'].includes(stdin)) {
    issues.push(`${label}.stdin 只能是 task_json/task_md`);
  }
  if (input === 'none' && argv.some((item) => item.includes('{task_file}') || item.includes('{task_md_file}'))) {
    issues.push(`${label}: input=none 时不能使用 {task_file}/{task_md_file} 占位符`);
  }

  const shell = value.shell === true;
  if (value.shell !== undefined && typeof value.shell !== 'boolean') {
    issues.push(`${label}.shell 必须是布尔值`);
  }
  if (shell) warnings.push(`${label}.shell=true：命令按 shell 字符串执行，注意注入面与引号规则`);

  const cwdRaw = stringField(value, 'cwd', `${label}.cwd`, 500, issues);
  const resultRaw = stringField(value, 'result_file', `${label}.result_file`, 500, issues);
  const env = parseEnvMap(value.env, `${label}.env`, issues, warnings);
  const passthrough = value.env_passthrough === undefined
    ? []
    : parsePassthrough(value.env_passthrough, `${label}.env_passthrough`, issues, warnings);

  return {
    argv,
    cwd: cwdRaw ? resolvePath(cwdRaw, configDir) : null,
    input,
    stdin,
    timeout_seconds: numberField(
      value,
      'timeout_seconds',
      `${label}.timeout_seconds`,
      defaultTimeout,
      1,
      86_400,
      issues,
      true,
    ),
    env,
    env_passthrough: passthrough,
    result_file: resultRaw ? resolvePath(resultRaw, configDir) : null,
    shell,
  };
}

function parseCommand(value, index, configDir, defaultTimeout, issues, warnings) {
  const label = `commands[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${label} 必须是对象`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!['name', 'match', 'run'].includes(key)) warnings.push(`${label} 含未知字段 ${key}，已忽略`);
  }
  const name = stringField(value, 'name', `${label}.name`, 64, issues, `command-${index + 1}`);
  const match = parseMatch(value.match, `${label}.match`, issues, warnings);
  const run = parseRun(value.run, `${label}.run`, configDir, defaultTimeout, issues, warnings);
  if (!run) return null;
  return { name, match, run };
}

/**
 * 解析一个配置对象（不含 CLI 覆盖）。configPath 只用于定位相对路径与报错。
 */
export function parseConfigObject(rawInput, options = {}) {
  const configPath = options.configPath ?? '';
  const configDir = configPath ? options.configDir ?? process.cwd() : process.cwd();
  const issues = [];
  // 直接使用调用方传入的数组（readConfigFile/loadConfig 依赖它把警告带出去）；
  // 复制一份会让“未知字段/敏感 passthrough”等警告静默消失。
  const warnings = options.warnings ?? [];

  if (!isRecord(rawInput)) throw new ConfigError('配置顶层必须是 JSON 对象');

  for (const key of Object.keys(rawInput)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`未知配置项 ${key}，已忽略`);
  }
  // 顶层出现 token/密码类键时直接拒绝：用户可能以为“配置里写一次省事”，
  // 但配置文件会被备份、截图、提交 git，令牌一旦落盘就只能轮换。
  for (const key of Object.keys(rawInput)) {
    if (/token|secret|password|api_?key/i.test(key) && key !== 'token_env') {
      issues.push(`配置项 ${key} 看起来是凭据；令牌只能来自 AIDASH_TOKEN/--token-file，不能写进配置文件`);
    }
  }

  let endpoint = DEFAULT_MCP_ENDPOINT;
  const urlRaw = stringField(rawInput, 'aidash_url', 'aidash_url', 2_000, issues);
  if (urlRaw) {
    try {
      endpoint = normalizeEndpoint(urlRaw);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  const tokenEnv = stringField(rawInput, 'token_env', 'token_env', 100, issues, 'AIDASH_TOKEN') || 'AIDASH_TOKEN';
  if (tokenEnv !== 'AIDASH_TOKEN') {
    warnings.push('token_env 仅作说明：runner 仍按 AIDASH_TOKEN > --token/--key > --token-file 读取');
  }

  const harnessId = stringField(rawInput, 'harness_id', 'harness_id', 64, issues, defaultHarnessId()) || defaultHarnessId();
  if (!HARNESS_ID_PATTERN.test(harnessId)) {
    issues.push('harness_id 只能包含字母、数字、点、下划线、冒号、连字符（1..64 字符）');
  }
  const name = stringField(rawInput, 'name', 'name', 128, issues, defaultInstanceName()) || defaultInstanceName();
  const host = stringField(rawInput, 'host', 'host', 128, issues) || null;
  const capabilities = stringArrayField(rawInput, 'capabilities', 'capabilities', issues);
  const channels = stringArrayField(rawInput, 'channels', 'channels', issues);
  if (rawInput.concurrency !== undefined && rawInput.concurrency !== 1) {
    issues.push('concurrency 目前只支持 1（并发执行多个任务不在本包范围）');
  }

  const poll = numberField(rawInput, 'poll_interval_seconds', 'poll_interval_seconds', DEFAULT_POLL_SECONDS, 1, 86_400, issues);
  const lease = numberField(rawInput, 'lease_seconds', 'lease_seconds', DEFAULT_LEASE_SECONDS, 1, 86_400, issues, true);
  const heartbeat = numberField(
    rawInput,
    'heartbeat_interval_seconds',
    'heartbeat_interval_seconds',
    DEFAULT_HEARTBEAT_SECONDS,
    1,
    3_600,
    issues,
    true,
  );
  const gap = numberField(rawInput, 'gap_seconds', 'gap_seconds', DEFAULT_GAP_SECONDS, 0, 3_600, issues);
  const commandTimeout = numberField(
    rawInput,
    'command_timeout_seconds',
    'command_timeout_seconds',
    DEFAULT_COMMAND_TIMEOUT_SECONDS,
    1,
    86_400,
    issues,
    true,
  );

  const dataDirRaw = stringField(rawInput, 'data_dir', 'data_dir', 1_000, issues);
  const logFileRaw = stringField(rawInput, 'log_file', 'log_file', 1_000, issues);
  const passthrough = rawInput.env_passthrough === undefined
    ? [...DEFAULT_ENV_PASSTHROUGH]
    : parsePassthrough(rawInput.env_passthrough, 'env_passthrough', issues, warnings);

  const commands = [];
  if (rawInput.commands !== undefined && rawInput.commands !== null) {
    if (!Array.isArray(rawInput.commands)) {
      issues.push('commands 必须是数组');
    } else {
      rawInput.commands.forEach((item, index) => {
        const command = parseCommand(item, index, configDir, commandTimeout, issues, warnings);
        if (command) commands.push(command);
      });
    }
  }
  const names = new Set();
  for (const command of commands) {
    if (names.has(command.name)) warnings.push(`commands 名称重复：${command.name}（按配置顺序取第一条命中）`);
    names.add(command.name);
  }

  if (issues.length > 0) {
    const where = configPath ? `（${configPath}）` : '';
    throw new ConfigError(`配置无效${where}：\n- ${issues.join('\n- ')}`);
  }

  return {
    endpoint,
    token_env: tokenEnv,
    harness_id: harnessId,
    name,
    host,
    capabilities,
    channels,
    poll_interval_seconds: poll,
    lease_seconds: lease,
    heartbeat_interval_seconds: heartbeat,
    gap_seconds: gap,
    command_timeout_seconds: commandTimeout,
    data_dir: dataDirRaw ? resolvePath(dataDirRaw, configDir) : '',
    log_file: logFileRaw ? resolvePath(logFileRaw, configDir) : '',
    env_passthrough: passthrough,
    commands,
    config_path: configPath,
    config_dir: configDir,
  };
}
