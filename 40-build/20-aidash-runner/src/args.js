import { ConfigError } from './errors.js';

/**
 * 参数解析只做“词法层”：把 argv 拆成命令、位置参数、已知开关。
 *
 * 为什么不给每个子命令各写一套解析：默认值与别名（--token/--key、-f/--follow）
 * 一旦分散，最容易出现“start 认识 --poll，once 不认识”的漂移。
 * 命令自己的位置参数个数与语义留给 handlers 校验。
 */

export const COMMANDS = new Set([
  'help',
  'start',
  'once',
  'dry-run',
  'list',
  'status',
  'stop',
  'kill',
  'pull',
  'config',
  'logs',
  'init',
  'check',
  '__run',
]);

const BOOLEAN_FLAGS = new Map([
  ['--help', 'help'],
  ['-h', 'help'],
  ['--version', 'version'],
  ['-v', 'version'],
  ['--json', 'json'],
  ['--daemon', 'daemon'],
  ['--no-prefix', 'noPrefix'],
  ['--all', 'all'],
  ['--force', 'force'],
  ['--wait', 'wait'],
  ['--persist', 'persist'],
  ['--follow', 'follow'],
  ['-f', 'follow'],
  ['--yes', 'yes'],
]);

const VALUE_FLAGS = new Map([
  ['--config', 'config'],
  ['--data-dir', 'dataDir'],
  ['--harness-id', 'harnessId'],
  ['--name', 'name'],
  ['--url', 'url'],
  ['--token', 'token'],
  ['--key', 'key'],
  ['--token-file', 'tokenFile'],
  ['--poll', 'poll'],
  ['--lease', 'lease'],
  ['--heartbeat', 'heartbeat'],
  ['--gap', 'gap'],
  ['--channel', 'channel'],
  ['--command', 'command'],
  ['--preset', 'preset'],
  ['--ensure-channel', 'ensureChannel'],
  ['--channel-title', 'channelTitle'],
  ['--create-task', 'createTask'],
  ['--task-description', 'taskDescription'],
  ['--resume', 'resume'],
  ['--cwd', 'cwd'],
  ['--log-file', 'logFile'],
  ['--lines', 'lines'],
]);

function emptyFlags() {
  return {
    help: false,
    version: false,
    json: false,
    daemon: false,
    noPrefix: false,
    all: false,
    force: false,
    wait: false,
    persist: false,
    follow: false,
    yes: false,
    config: undefined,
    dataDir: undefined,
    harnessId: undefined,
    name: undefined,
    url: undefined,
    token: undefined,
    key: undefined,
    tokenFile: undefined,
    poll: undefined,
    lease: undefined,
    heartbeat: undefined,
    gap: undefined,
    channel: [],
    command: undefined,
    preset: undefined,
    ensureChannel: undefined,
    channelTitle: undefined,
    createTask: undefined,
    taskDescription: undefined,
    resume: undefined,
    cwd: undefined,
    logFile: undefined,
    lines: undefined,
  };
}

export function parseArgv(argv) {
  const flags = emptyFlags();
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      const key = VALUE_FLAGS.get(name);
      if (!key) {
        throw new ConfigError(`未知参数：${name}（运行 aidash-runner --help 查看可用参数）`);
      }
      assignValue(flags, key, value);
      continue;
    }

    const boolKey = BOOLEAN_FLAGS.get(arg);
    if (boolKey) {
      flags[boolKey] = true;
      continue;
    }

    const valueKey = VALUE_FLAGS.get(arg);
    if (valueKey) {
      const value = argv[index + 1];
      // 下一个 token 若是已知开关，说明用户漏写了值（典型：`--poll --json`）。
      // 不把它吞成值，否则 --json 会静默失效，脚本拿不到 JSON 错误信封。
      if (value === undefined || BOOLEAN_FLAGS.has(value) || VALUE_FLAGS.has(value)) {
        throw new ConfigError(`${arg} 需要一个值（例如 ${arg} <value>）`);
      }
      assignValue(flags, valueKey, value);
      index += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new ConfigError(`未知参数：${arg}（运行 aidash-runner --help 查看可用参数）`);
    }
    positionals.push(arg);
  }

  const command = positionals.shift();
  if (command === undefined) return { command: 'help', positionals, flags };
  if (!COMMANDS.has(command)) {
    throw new ConfigError(
      `未知命令：${command}（可用：start / once / dry-run / list / status / stop / kill / pull / config / logs / init / check）`,
    );
  }
  return { command, positionals, flags };
}

function assignValue(flags, key, value) {
  if (key === 'channel') {
    const pattern = value.trim();
    if (!pattern) throw new ConfigError('--channel 不能为空；要匹配全部通道请省略该参数');
    flags.channel.push(pattern);
    return;
  }
  if (value === '') throw new ConfigError(`参数值不能为空：--${kebab(key)}`);
  flags[key] = value;
}

function kebab(key) {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/** 数值参数统一在这里转，错误信息带具体参数名，避免用户在配置里猜。 */
export function parsePositiveNumber(raw, label, { min = 0, max = 86_400, integer = false } = {}) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ConfigError(
      `${label} 必须是 ${min}..${max} 之间的${integer ? '整数' : '数字'}（收到 ${raw}）`,
    );
  }
  return value;
}
