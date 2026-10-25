import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ENV_PASSTHROUGH,
  DEFAULT_MCP_ENDPOINT,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_GAP_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_POLL_SECONDS,
  defaultHarnessId,
  defaultInstanceName,
} from '../constants.js';
import { ConfigError } from '../errors.js';
import {
  findConfigPath,
  instanceIdOf,
  loadConfig,
  resolveDataDir,
  resolveLogFile,
  resolveToken,
} from '../config.js';
import { inspectRegistryEntry, readRegistryEntry } from '../registry.js';
import { atomicWriteFileSync, ensureDirSync, randomId, resolvePath } from '../util.js';
import { tokenSourceLabel } from './common.js';

/** `init`：生成一份“规则被标签圈住”的示例配置，避免默认认领所有任务。 */
export async function initCommand(flags, out) {
  const target = flags.config
    ? resolvePath(flags.config, process.cwd())
    : path.resolve(process.cwd(), 'aidash-runner.json');
  const exists = fs.existsSync(target);
  if (exists && !flags.force) {
    throw new ConfigError(`配置文件已存在：${target}；如需覆盖请加 --force（会丢失原文件）`);
  }
  ensureDirSync(path.dirname(target), 0o700);
  const config = buildInitConfig(flags);
  atomicWriteFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 0o600);

  const data = { path: target, created: true, overwritten: exists };
  const lines = [
    `已生成配置：${target}`,
    flags.command
      ? '已按 --command 生成 match_all 规则：会认领所有可认领任务，首次 start 会先要求 --yes。'
      : '示例规则只匹配 tags 含 aidash-runner-demo 的任务，不会认领普通任务。',
    '',
    '下一步：',
    '  1. 设置 AIDASH_TOKEN（可以是一句短口令；或 --token-file；不要写进配置）',
    `  2. aidash-runner check --config "${target}"`,
    '  3. 首次接入（建通道 + 首条任务，后台运行）：',
    `     aidash-runner start --daemon --config "${target}" --ensure-channel devhost/myproj/topic --channel-title "我的话题" --create-task "首条任务"`,
    '  4. 之后回到同一通道（只复用，不重复建任务）：',
    `     aidash-runner start --daemon --config "${target}" --ensure-channel devhost/myproj/topic`,
    '  5. 查看与停止：list / status / logs -f / stop',
  ];
  out.write(data, lines.join('\n'));
  return 0;
}

function buildInitConfig(flags = {}) {
  if (flags.command && flags.preset) {
    throw new ConfigError('--command 与 --preset 只能给一个：前者是 shell 字符串，后者是跨平台 argv 预设');
  }
  const demoRule = {
    name: 'demo-echo',
    match: {
      tags: ['aidash-runner-demo'],
      match_all: false,
    },
    run: {
      argv: [
        'node',
        '-e',
        'console.log("aidash-runner 示例任务", process.argv[1])',
        '{task_file}',
      ],
      cwd: flags.cwd ? resolvePath(flags.cwd, process.cwd()) : null,
      input: 'file',
      timeout_seconds: 300,
      env: {},
      env_passthrough: [],
      result_file: '',
    },
  };
  const presetRule = flags.preset ? buildPresetRule(flags.preset, flags.cwd) : null;
  const commandRule = flags.command
    ? {
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
          cwd: flags.cwd ? resolvePath(flags.cwd, process.cwd()) : null,
          input: 'file',
          stdin: 'task_json',
          timeout_seconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
          env: {},
          env_passthrough: [],
          result_file: null,
          shell: true,
        },
      }
    : null;

  return {
    aidash_url: DEFAULT_MCP_ENDPOINT,
    token_env: 'AIDASH_TOKEN',
    harness_id: defaultHarnessId(),
    name: defaultInstanceName(),
    poll_interval_seconds: DEFAULT_POLL_SECONDS,
    lease_seconds: DEFAULT_LEASE_SECONDS,
    heartbeat_interval_seconds: DEFAULT_HEARTBEAT_SECONDS,
    gap_seconds: DEFAULT_GAP_SECONDS,
    command_timeout_seconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
    data_dir: '',
    log_file: '',
    env_passthrough: [...DEFAULT_ENV_PASSTHROUGH],
    commands: [commandRule ?? presetRule ?? demoRule],
  };
}

/**
 * 跨平台预设：argv 数组直传，不经过 shell。
 *
 * Windows cmd 对 `--command "claude ... -p \"...\""` 的双引号转义非常容易出错；
 * 预设把参数拆成数组，用户不需要在命令行里处理任何引号。
 */
function buildPresetRule(preset, cwdFlag) {
  if (preset !== 'claude') {
    throw new ConfigError(`未知 preset：${preset}；当前支持 claude`);
  }
  return {
    name: 'claude-task',
    match: {
      tags: [],
      title_prefix: '',
      channel_key: '',
      priority: [],
      kind: [],
      match_all: true,
    },
    run: {
      argv: [
        'claude',
        '--dangerously-skip-permissions',
        '-p',
        'Read and execute the task file: {task_file}. When finished, write claude-result.json with fields summary, detail_md, result.',
      ],
      cwd: cwdFlag ? resolvePath(cwdFlag, process.cwd()) : '.',
      input: 'file',
      stdin: 'task_json',
      timeout_seconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
      env: {},
      env_passthrough: [],
      result_file: 'claude-result.json',
      shell: false,
    },
  };
}

/** `check`：不联网，回答“这份配置能否支撑 start / once”。 */
export async function checkCommand(flags, out) {
  const loaded = loadConfig(flags);
  const config = loaded.config;
  const issues = [];
  const warnings = [...loaded.warnings];

  if (!loaded.configPath) {
    const looked = findConfigPath(flags);
    issues.push(
      `没有找到配置文件（查找顺序：--config > AIDASH_RUNNER_CONFIG > ./aidash-runner.json > ~/.aidash/runner.json；当前解析到 ${looked.source}）` +
        '；可运行 aidash-runner init 生成示例',
    );
  }
  if (config.commands.length === 0) {
    issues.push('commands 为空：值守壳不会认领任何任务；请配置规则或使用 --command');
  }

  let tokenSource = null;
  try {
    tokenSource = resolveToken(flags).source;
  } catch (error) {
    warnings.push(
      `令牌不可用：${error instanceof Error ? error.message : String(error)}；` +
        '配置本身有效，但 start / once / dry-run 会因缺少令牌失败',
    );
  }

  const dataDir = resolveDataDir(flags, config);
  checkWritableDir(dataDir, '数据目录', issues);
  const logFile = resolveLogFile(flags, config, dataDir, instanceIdOf(config));
  if (logFile) checkWritableDir(path.dirname(logFile), '日志目录', issues);

  config.commands.forEach((rule, index) => {
    const label = `commands[${index}] ${rule.name}`;
    if (rule.run.cwd && !fs.existsSync(rule.run.cwd)) {
      warnings.push(`${label} 的 run.cwd 不存在：${rule.run.cwd}（任务启动时会 spawn 失败）`);
    }
    if (rule.run.shell) {
      warnings.push(`${label} 使用 shell:true；只应对可信任务内容使用`);
    }
    if (rule.match.match_all) {
      warnings.push(
        `${label} 的 match_all=true：通道内所有未被别人指派的任务都会被认领；` +
          '建议至少加 tags/priority 收窄范围',
      );
    }
    if (rule.run.input === 'none' && rule.run.argv.some((arg) => arg.includes('{task_file}'))) {
      issues.push(`${label}: input=none 时不能使用 {task_file}`);
    }
  });

  // 同名实例正在运行时 start 会拒绝；check 只警告，不替用户停实例。
  const instanceId = instanceIdOf(config);
  const entry = readRegistryEntry(dataDir, instanceId);
  if (entry) {
    const status = await inspectRegistryEntry(entry, { timeoutMs: 800 });
    if (status.alive) {
      warnings.push(
        `实例 ${instanceId} 正在运行（pid ${entry.pid}）；同一 harness_id 不能重复启动`,
      );
    }
  }

  const ok = issues.length === 0;
  const data = {
    ok,
    config_path: loaded.configPath ?? '',
    aidash_url: config.endpoint,
    harness_id: config.harness_id,
    commands: config.commands.length,
    token_source: tokenSource,
    data_dir: dataDir,
    log_file: logFile,
    warnings,
    issues,
  };
  const lines = [
    ok ? '配置检查通过' : `配置检查发现 ${issues.length} 个问题`,
    `  配置文件: ${loaded.configPath ?? '(未找到)'}`,
    `  MCP 地址: ${config.endpoint}`,
    `  harness_id: ${config.harness_id}`,
    `  命令规则: ${config.commands.length}`,
    `  令牌来源: ${tokenSourceLabel(tokenSource)}`,
    `  数据目录: ${dataDir}`,
    `  日志文件: ${logFile}`,
    ...issues.map((item) => `  [问题] ${item}`),
    ...warnings.map((item) => `  [警告] ${item}`),
  ];
  out.write(data, lines.join('\n'));
  return ok ? 0 : 2;
}

function checkWritableDir(dir, label, issues) {
  try {
    ensureDirSync(dir, 0o700);
    const probe = path.join(dir, `.aidash-runner-check-${process.pid}-${randomId(4)}`);
    fs.writeFileSync(probe, 'ok', { encoding: 'utf8', mode: 0o600 });
    fs.rmSync(probe, { force: true });
  } catch (error) {
    issues.push(`${label}不可写：${dir}（${error instanceof Error ? error.message : String(error)}）`);
  }
}
