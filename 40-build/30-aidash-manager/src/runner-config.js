import fs from 'node:fs';
import path from 'node:path';
import { ManagerError } from './errors.js';
import { getTemplate } from './templates.js';
import { atomicWriteFileSync, exists, isSensitiveEnvKey, resolvePath } from './util.js';

/**
 * Runner 配置的读写与校验。
 *
 * 这里不 import runner 的内部模块：管理台和 runner 是两个独立发布物，
 * 一旦跨包 import，runner 改一个私有函数就可能把管理台弄坏。校验规则
 * 按 aidash-runner/src/config-parse.js 的公开约束镜像一份，宁可多一条
 * “管理台先拦住”，也不要让用户保存后才在 `check` 里看到问题。
 */

export const RUNNER_TOP_KEYS = new Set([
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

export const RUNNER_ENV_PASSTHROUGH = Object.freeze([
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
  'TEMP',
  'TMP',
  'ProgramFiles',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'TERM',
]);

const NUMBER_RULES = {
  poll_interval_seconds: { min: 1, max: 86_400, integer: false },
  lease_seconds: { min: 1, max: 86_400, integer: true },
  heartbeat_interval_seconds: { min: 1, max: 3_600, integer: true },
  gap_seconds: { min: 0, max: 3_600, integer: false },
  command_timeout_seconds: { min: 1, max: 86_400, integer: true },
  concurrency: { min: 1, max: 64, integer: true },
};

export function buildTemplateRule(templateKey, spec) {
  const template = getTemplate(templateKey);
  if (!template) throw new ManagerError('TEMPLATE_UNKNOWN', `未知 harness 模板：${templateKey}`);
  return {
    name: `${templateKey}-task`,
    match: {
      tags: spec.match?.tags ?? [],
      title_prefix: spec.match?.titlePrefix ?? '',
      channel_key: spec.match?.channelKey ?? '',
      priority: spec.match?.priority ?? [],
      kind: spec.match?.kind ?? [],
      match_all: spec.match?.matchAll ?? true,
    },
    run: {
      argv: [...template.argv],
      cwd: spec.runCwd,
      input: 'file',
      stdin: 'task_json',
      timeout_seconds: spec.commandTimeoutSeconds ?? 1_800,
      env: {},
      env_passthrough: [],
      result_file: template.result_file,
      shell: false,
    },
  };
}

/** 新建服务或“重新应用模板”时使用的完整配置。 */
export function buildRunnerConfig(service, { templateKey } = {}) {
  const spec = service.runner;
  const key = templateKey ?? spec.template;
  const template = getTemplate(key);
  if (!template) throw new ManagerError('TEMPLATE_UNKNOWN', `未知 harness 模板：${key}`);
  return {
    aidash_url: spec.aidashUrl,
    token_env: spec.tokenEnv,
    harness_id: spec.harnessId,
    name: spec.runnerName || spec.harnessId,
    host: '',
    capabilities: template.capability ? [template.capability] : [],
    channels: [...(spec.channels ?? [])],
    poll_interval_seconds: spec.pollSeconds ?? 5,
    lease_seconds: spec.leaseSeconds ?? 900,
    heartbeat_interval_seconds: spec.heartbeatSeconds ?? 60,
    gap_seconds: spec.gapSeconds ?? 2,
    command_timeout_seconds: spec.commandTimeoutSeconds ?? 1_800,
    data_dir: spec.dataDir,
    log_file: spec.logFile,
    env_passthrough: [...RUNNER_ENV_PASSTHROUGH],
    commands: [buildTemplateRule(key, spec)],
  };
}

function pushIf(errors, condition, message) {
  if (condition) errors.push(message);
}

/**
 * 返回 { errors, warnings }。errors 会阻止保存；warnings 允许保存但会提示，
 * 例如 match_all=true 覆盖所有任务、commands 为空导致 runner 永不认领。
 */
export function validateRunnerConfig(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['配置顶层必须是 JSON 对象'], warnings };
  }
  for (const key of Object.keys(raw)) {
    if (!RUNNER_TOP_KEYS.has(key)) errors.push(`未知配置项：${key}`);
  }
  if (typeof raw.aidash_url !== 'string' || !raw.aidash_url.trim()) {
    errors.push('aidash_url 必填（例如 http://127.0.0.1:8787/mcp）');
  } else {
    try {
      const url = new URL(raw.aidash_url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') errors.push('aidash_url 只支持 http/https');
      if (url.username || url.password) errors.push('aidash_url 不能内嵌账号密码');
    } catch {
      errors.push(`aidash_url 不是合法 URL：${raw.aidash_url}`);
    }
  }
  if (typeof raw.harness_id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(raw.harness_id)) {
    errors.push('harness_id 只能包含字母、数字、点、下划线、冒号、连字符（1..64 字符）');
  }
  if (raw.token_env !== undefined && (typeof raw.token_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.token_env))) {
    errors.push('token_env 必须是合法的环境变量名');
  }
  for (const [key, rule] of Object.entries(NUMBER_RULES)) {
    if (raw[key] === undefined) continue;
    const value = raw[key];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < rule.min ||
      value > rule.max ||
      (rule.integer && !Number.isInteger(value))
    ) {
      errors.push(`${key} 必须是 ${rule.min}..${rule.max} 之间的${rule.integer ? '整数' : '数字'}`);
    }
  }
  if (raw.channels !== undefined) {
    if (!Array.isArray(raw.channels)) errors.push('channels 必须是字符串数组');
    else {
      raw.channels.forEach((item, index) => {
        if (typeof item !== 'string' || !item.trim()) errors.push(`channels[${index}] 必须是非空字符串`);
      });
    }
  }
  if (raw.env_passthrough !== undefined) {
    if (!Array.isArray(raw.env_passthrough)) errors.push('env_passthrough 必须是字符串数组');
    else {
      raw.env_passthrough.forEach((key) => {
        if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          errors.push(`env_passthrough 含非法变量名：${key}`);
        } else if (isSensitiveEnvKey(key)) {
          errors.push(`env_passthrough 不能放敏感变量 ${key}（runner 会忽略它）`);
        }
      });
    }
  }
  if (raw.data_dir !== undefined && typeof raw.data_dir !== 'string') errors.push('data_dir 必须是字符串');
  if (raw.log_file !== undefined && typeof raw.log_file !== 'string') errors.push('log_file 必须是字符串');
  if (raw.concurrency !== undefined && raw.concurrency !== 1) {
    errors.push('concurrency 目前只支持 1（并发执行多个任务不在 runner 范围内）');
  }

  if (raw.commands !== undefined && !Array.isArray(raw.commands)) {
    errors.push('commands 必须是数组');
  } else if (Array.isArray(raw.commands)) {
    if (raw.commands.length === 0) {
      warnings.push('commands 为空：runner 不会认领任何任务');
    }
    raw.commands.forEach((command, index) => {
      const label = `commands[${index}]`;
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        errors.push(`${label} 必须是对象`);
        return;
      }
      const match = command.match;
      if (!match || typeof match !== 'object' || Array.isArray(match)) {
        errors.push(`${label}.match 必须是对象`);
      } else {
        const hasSelector =
          (Array.isArray(match.tags) && match.tags.length > 0) ||
          Boolean(match.title_prefix) ||
          Boolean(match.channel_key) ||
          (Array.isArray(match.priority) && match.priority.length > 0) ||
          (Array.isArray(match.kind) && match.kind.length > 0);
        if (!hasSelector && match.match_all !== true) {
          errors.push(`${label}.match 没有匹配条件时必须显式写 match_all=true（防止误跑全部任务）`);
        }
      }
      const run = command.run;
      if (!run || typeof run !== 'object' || Array.isArray(run)) {
        errors.push(`${label}.run 必须是对象`);
        return;
      }
      if (!Array.isArray(run.argv) || run.argv.length === 0 || run.argv.some((item) => typeof item !== 'string' || !item)) {
        errors.push(`${label}.run.argv 必须是非空字符串数组`);
      }
      if (run.shell === true) warnings.push(`${label} 使用 shell:true；只应对可信任务内容使用`);
      if (run.input === 'none' && Array.isArray(run.argv) && run.argv.some((arg) => String(arg).includes('{task_file}'))) {
        errors.push(`${label}: input=none 时不能使用 {task_file}`);
      }
    });
  }
  if (raw.harness_id && Array.isArray(raw.commands)) {
    const all = raw.commands.some((command) => command?.match?.match_all === true);
    if (all) warnings.push('存在 match_all=true 的规则：通道内所有可认领任务都会被这个 runner 领走');
  }
  return { errors, warnings };
}

export function readRunnerConfigFile(filePath) {
  if (!exists(filePath)) return { exists: false, raw: null, text: '', errors: [], warnings: [] };
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ManagerError('CONFIG_READ_FAILED', `读取 runner 配置失败：${filePath}（${error.message}）`, {
      status: 400,
    });
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { exists: true, raw: null, text, errors: [`配置文件不是合法 JSON：${error.message}`], warnings: [] };
  }
  const result = validateRunnerConfig(raw);
  return { exists: true, raw, text, ...result };
}

export function writeRunnerConfigFile(filePath, raw) {
  const { errors, warnings } = validateRunnerConfig(raw);
  if (errors.length > 0) {
    throw new ManagerError('CONFIG_INVALID', 'runner 配置校验未通过', { details: { errors, warnings } });
  }
  atomicWriteFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 0o600);
  return { raw, warnings };
}

/** 配置文件保存后，把管理台用于状态/启动的镜像字段同步回服务定义。 */
export function applyRunnerConfigToService(service, raw) {
  const spec = service.runner;
  const configDir = path.dirname(spec.configPath);
  return {
    ...service,
    updatedAt: new Date().toISOString(),
    runner: {
      ...spec,
      harnessId: String(raw.harness_id ?? spec.harnessId),
      runnerName: String(raw.name ?? spec.runnerName),
      aidashUrl: String(raw.aidash_url ?? spec.aidashUrl),
      dataDir: resolvePath(String(raw.data_dir ?? spec.dataDir), configDir),
      logFile: resolvePath(String(raw.log_file ?? spec.logFile), configDir),
    },
  };
}

/** 表单常用字段；完整字段请用 JSON 编辑器。 */
export const RUNNER_CORE_FIELDS = [
  {
    group: '连接',
    key: 'aidash_url',
    label: 'AIDash MCP 地址',
    type: 'string',
    required: true,
    default: 'http://127.0.0.1:8787/mcp',
    hint: '指向某个 AIDash 实例的 /mcp 端点；本工具会自动补齐 /mcp。',
  },
  {
    group: '身份',
    key: 'harness_id',
    label: 'harness_id',
    type: 'string',
    required: true,
    hint: '服务端唯一执行者标识；同一个 AIDash 上不能重复。',
  },
  {
    group: '身份',
    key: 'name',
    label: '展示名',
    type: 'string',
    required: false,
  },
  {
    group: '任务过滤',
    key: 'channels',
    label: '通道过滤',
    type: 'array',
    hint: '留空表示全部通道；支持 * 与 prefix/*。',
  },
  {
    group: '节奏',
    key: 'poll_interval_seconds',
    label: '空闲轮询（秒）',
    type: 'integer',
    default: 5,
    min: 1,
    max: 86400,
  },
  {
    group: '节奏',
    key: 'lease_seconds',
    label: '任务租约（秒）',
    type: 'integer',
    default: 900,
    min: 1,
    max: 86400,
  },
  {
    group: '节奏',
    key: 'heartbeat_interval_seconds',
    label: '心跳间隔（秒）',
    type: 'integer',
    default: 60,
    min: 1,
    max: 3600,
  },
  {
    group: '节奏',
    key: 'gap_seconds',
    label: '任务间隔（秒）',
    type: 'number',
    default: 2,
    min: 0,
    max: 3600,
  },
  {
    group: '节奏',
    key: 'command_timeout_seconds',
    label: '命令超时（秒）',
    type: 'integer',
    default: 1800,
    min: 1,
    max: 86400,
  },
  {
    group: '存储',
    key: 'data_dir',
    label: '数据目录',
    type: 'string',
    hint: 'registry、任务临时文件、会话状态的存放目录；每个 runner 应独立。',
  },
  {
    group: '存储',
    key: 'log_file',
    label: '日志文件',
    type: 'string',
  },
];

export const DEFAULT_RUNNER_FIELD_VALUES = Object.fromEntries(
  RUNNER_CORE_FIELDS.filter((item) => item.default !== undefined).map((item) => [item.key, item.default]),
);
