import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, VERSION } from '../constants.js';
import { ManagerError, errorMessage } from '../errors.js';
import { ManagerStore } from '../store.js';
import { templateSummaries } from '../templates.js';
import {
  applyConfigToService,
  readAidashConfigFile,
  writeAidashConfigFile,
} from '../aidash-config.js';
import {
  applyRunnerConfigToService,
  readRunnerConfigFile,
  writeRunnerConfigFile,
} from '../runner-config.js';
import {
  detectRunnerEntry,
  effectiveAidashSettings,
  effectiveRunnerSettings,
  publicService,
} from '../service.js';
import {
  getServiceErrors,
  getServiceLogs,
  getServiceRuntime,
  restartService,
  serviceWebUrl,
  startAidash,
  startRunner,
  stopAidash,
  stopRunner,
} from '../process.js';
import { openBrowser, startManagerServer } from '../server.js';
import { createServiceWithFiles, listServiceSummaries } from '../api.js';
import { formatDuration, isPidAlive as isProcessAlive, resolvePath, sleep } from '../util.js';

const BOOLEAN_FLAGS = new Set([
  'help',
  'version',
  'json',
  'no-open',
  'strict-port',
  'follow',
  'force',
  'use-existing-config',
  'no-match-all',
  'match-all',
]);

const VALUE_FLAGS = new Set([
  'home',
  'data-dir',
  'port',
  'host',
  'web-host',
  'name',
  'cwd',
  'token',
  'token-file',
  'token-env',
  'token-source',
  'template',
  'url',
  'harness-id',
  'channels',
  'ensure-channel',
  'channel-title',
  'runner-entry',
  'config-path',
  'config-mode',
  'app-dir',
  'server-entry',
  'db-path',
  'backup-dir',
  'static-dir',
  'data-dir-runner',
  'log-file',
  'run-cwd',
  'tags',
  'title-prefix',
  'channel-key',
  'priority',
  'kind',
  'poll',
  'lease',
  'heartbeat',
  'gap',
  'command-timeout',
  'lines',
  'source',
]);

const COMMANDS = new Set([
  'web',
  'serve',
  'list',
  'ls',
  'status',
  'start',
  'stop',
  'restart',
  'remove',
  'rm',
  'logs',
  'config',
  'add',
  'templates',
  'open',
  'help',
  'version',
]);

const HELP = `aidash-manager ${VERSION} — AIDash 服务与 runner 的本地管理台

用法：
  aidash-manager                       启动管理台 Web，并自动打开浏览器
  aidash-manager web [--port 4280] [--web-host 127.0.0.1] [--no-open]
  aidash-manager list                  列出服务与运行状态
  aidash-manager status [id|name]      查看单个服务详情
  aidash-manager start <id|name>       启动服务
  aidash-manager stop <id|name>        停止服务
  aidash-manager restart <id|name>     重启服务
  aidash-manager remove <id|name> [--force]   删除服务（不删除配置文件；external 只移除记录）
  aidash-manager logs <id|name> [--lines 200] [--follow|-f] [--source auto|manager|runner]
  aidash-manager config get <id|name>  查看配置文件（--json 含有效设置）
  aidash-manager config set <id|name> <key> <value>   修改顶层配置键
  aidash-manager templates             列出 runner harness 模板
  aidash-manager open [id|name]        打开服务网页（省略 id 时打开管理台）

创建服务（也可以直接用 Web 页面）：
  aidash-manager add aidash --name <名称> --cwd <数据目录> --port 8788 \\
      [--host 127.0.0.1] [--config-mode env|file] [--config-path 文件] \\
      [--app-dir 程序目录] [--server-entry 入口] [--db-path ...] [--static-dir ...] \\
      [--token 令牌 | --token-file 文件 | --token-source env]
      （--cwd 只放数据；程序默认从管理台同装目录/已登记服务自动识别）

  aidash-manager add runner --name <名称> --cwd <目录> \\
      --template claude|codex|dsh|narnat|custom \\
      [--url http://127.0.0.1:8787/mcp] [--harness-id 标识] [--channels a,b] \\
      [--ensure-channel 精确通道key --channel-title 标题] \\
      [--config-path 文件] [--data-dir 目录] [--run-cwd 目录] [--runner-entry 入口] \\
      [--match-all | --no-match-all --tags a,b] \\
      [--token 令牌 | --token-file 文件 | --token-source env]

全局参数：
  --home <目录>       管理台数据目录，默认 ~/.aidash/manager（也可用 AIDASH_MANAGER_HOME）
  --json             机器可读输出（stdout 只有一个 JSON 信封）
  --strict-port      端口被占用时直接报错，不自动向后找空闲端口（显式 --port 已隐含此行为）
  --version / --help 版本与帮助（配合 --json 时输出 JSON 信封）
`;

function emptyFlags() {
  return {
    help: false,
    version: false,
    json: false,
    'no-open': false,
    'strict-port': false,
    follow: false,
    force: false,
    'use-existing-config': false,
    'no-match-all': false,
    'match-all': false,
    home: undefined,
    'data-dir': undefined,
    port: undefined,
    host: undefined,
    'web-host': undefined,
    name: undefined,
    cwd: undefined,
    token: undefined,
    'token-file': undefined,
    'token-env': undefined,
    'token-source': undefined,
    template: undefined,
    url: undefined,
    'harness-id': undefined,
    channels: undefined,
    'ensure-channel': undefined,
    'channel-title': undefined,
    'runner-entry': undefined,
    'config-path': undefined,
    'config-mode': undefined,
    'server-entry': undefined,
    'db-path': undefined,
    'backup-dir': undefined,
    'static-dir': undefined,
    'log-file': undefined,
    'run-cwd': undefined,
    tags: undefined,
    'title-prefix': undefined,
    'channel-key': undefined,
    priority: undefined,
    kind: undefined,
    poll: undefined,
    lease: undefined,
    heartbeat: undefined,
    gap: undefined,
    'command-timeout': undefined,
    lines: undefined,
    source: undefined,
  };
}

function parseArgv(argv) {
  const flags = emptyFlags();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(2, eq);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      if (!VALUE_FLAGS.has(name)) throw new ManagerError('ARG_UNKNOWN', `未知参数：--${name}`);
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      flags.version = true;
      continue;
    }
    if (arg === '-f') {
      flags.follow = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      if (!VALUE_FLAGS.has(name)) throw new ManagerError('ARG_UNKNOWN', `未知参数：${arg}`);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ManagerError('ARG_VALUE_REQUIRED', `${arg} 需要一个值`);
      }
      flags[name] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new ManagerError('ARG_UNKNOWN', `未知参数：${arg}`);
    positionals.push(arg);
  }
  let command = positionals.shift() ?? 'web';
  if (!COMMANDS.has(command)) {
    throw new ManagerError('COMMAND_UNKNOWN', `未知命令：${command}（运行 --help 查看用法）`);
  }
  if (command === 'serve') command = 'web';
  if (command === 'ls') command = 'list';
  if (command === 'rm') command = 'remove';
  return { command, positionals, flags };
}

function newStore(flags) {
  // --home 是管理台数据目录的唯一 CLI 入口；--data-dir 留给 runner 服务
  // （见 add runner 的 HELP）。两者混用会让“给 runner 指定数据目录”的命令
  // 悄悄把管理台状态搬到别处，排查时很难发现。
  const store = new ManagerStore({ home: flags.home });
  store.init();
  return store;
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function printJson(value) {
  process.stdout.write(`${stableJson(value)}\n`);
}

function table(rows, headers) {
  const widths = headers.map((header, index) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[index] ?? '').length)),
  );
  const line = (row) => row.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ');
  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

function readTokenFlag(flags) {
  if (flags.token && flags['token-file']) {
    throw new ManagerError('TOKEN_CONFLICT', '--token 与 --token-file 只能给一个');
  }
  if (flags.token) return flags.token;
  if (flags['token-file']) {
    const file = resolvePath(flags['token-file']);
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch (error) {
      throw new ManagerError('TOKEN_READ_FAILED', `读取令牌文件失败：${file}（${error.message}）`);
    }
  }
  return undefined;
}

function parseNumberFlag(raw, label, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ManagerError('ARG_INVALID', `${label} 必须是数字`);
  return value;
}

async function promptLine(question) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function cmdWeb(flags) {
  const store = newStore(flags);
  const host = flags['web-host'] ?? flags.host ?? DEFAULT_WEB_HOST;
  const port = parseNumberFlag(flags.port, '--port', DEFAULT_WEB_PORT);
  const { server, url, port: actualPort } = await startManagerServer({
    store,
    host,
    port,
    strictPort: Boolean(flags['strict-port'] || flags.port),
  });
  const accessUrl = `${url}/?token=${store.webToken()}`;
  const shouldOpen = !flags['no-open'];
  const opened = shouldOpen ? await openBrowser(accessUrl) : false;
  if (flags.json) {
    printJson({
      ok: true,
      data: {
        url,
        access_url: accessUrl,
        port: actualPort,
        host,
        home: store.home,
        opened,
      },
    });
  } else {
    process.stdout.write(
      [
        `AIDash Manager v${VERSION} 已启动`,
        `  管理台: ${accessUrl}`,
        `  数据目录: ${store.home}`,
        '  提示: 链接里的 token 用于首次鉴权，浏览器会自动改成 Cookie；不要把它发给别人。',
        '  按 Ctrl+C 停止管理台（不会停止由它拉起的服务进程）',
        ...(shouldOpen && !opened ? ['  （自动打开浏览器失败，请手动复制上面的链接）'] : []),
        '',
      ].join('\n'),
    );
  }
  await new Promise((resolve) => {
    const shutdown = () => {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      store.clearWebRuntime(process.pid);
      server.close(() => resolve());
      // 有 keep-alive/进行中的请求时 close 可能一直等；1 秒后断开连接强制结束，
      // 否则用户按了 Ctrl+C 进程却退不掉。
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 1_000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

async function cmdList(flags) {
  const store = newStore(flags);
  const summaries = await listServiceSummaries(store);
  if (flags.json) {
    printJson({ ok: true, data: { home: store.home, services: summaries } });
    return 0;
  }
  if (summaries.length === 0) {
    process.stdout.write(`还没有服务（数据目录：${store.home}）。运行 aidash-manager 打开 Web 创建。\n`);
    return 0;
  }
  const rows = summaries.map((item) => [
    item.name,
    item.type,
    item.state,
    item.pid ?? '-',
    item.url ?? '-',
    item.instance_id ?? '-',
  ]);
  process.stdout.write(`${table(rows, ['名称', '类型', '状态', 'PID', '地址', '实例'])}\n数据目录: ${store.home}\n`);
  return 0;
}

async function cmdStatus(flags, positionals) {
  const store = newStore(flags);
  const target = positionals[0];
  if (!target) return cmdList(flags);
  const service = store.requireService(target);
  const runtime = await getServiceRuntime(store, service);
  const view = {
    id: service.id,
    name: service.name,
    type: service.type,
    cwd: service.cwd,
    config_path: service.type === 'aidash' ? service.aidash.configPath : service.runner.configPath,
    runtime,
    web_url: serviceWebUrl(store, service),
    has_token: Boolean(store.getSecret(service.id)),
  };
  if (flags.json) {
    printJson({ ok: true, data: view });
    return 0;
  }
  process.stdout.write(
    [
      `${service.name}（${service.type}）`,
      `  状态: ${runtime.state}${runtime.pid ? `  PID: ${runtime.pid}` : ''}`,
      `  说明: ${runtime.detail ?? '-'}`,
      `  地址: ${view.web_url ?? '-'}`,
      runtime.uptime_ms ? `  运行: ${formatDuration(runtime.uptime_ms)}` : null,
      runtime.current_task ? `  当前任务: ${runtime.current_task.title ?? runtime.current_task.id ?? JSON.stringify(runtime.current_task)}` : null,
      `  配置: ${view.config_path}`,
      `  日志: ${runtime.log_file ?? '-'}`,
      runtime.config_error ? `  配置错误: ${runtime.config_error}` : null,
      runtime.last_error ? `  最近错误: ${runtime.last_error}` : null,
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );
  return 0;
}

async function cmdStartStopRestart(flags, positionals, action) {
  const store = newStore(flags);
  if (!positionals[0]) throw new ManagerError('ARG_REQUIRED', `${action} 需要一个服务 id 或名称`);
  const service = store.requireService(positionals[0]);
  let runtime;
  if (action === 'start') {
    runtime = service.type === 'aidash' ? await startAidash(store, service) : await startRunner(store, service);
  } else if (action === 'stop') {
    runtime =
      service.type === 'aidash'
        ? await stopAidash(store, service, { force: Boolean(flags.force) })
        : await stopRunner(store, service, { force: Boolean(flags.force) });
  } else {
    runtime = await restartService(store, service);
  }
  if (flags.json) {
    printJson({ ok: true, data: { service: service.name, runtime } });
  } else {
    process.stdout.write(`${service.name}: ${runtime.state}（${runtime.detail ?? ''}）\n`);
  }
  return 0;
}

async function cmdRemove(flags, positionals) {
  const store = newStore(flags);
  if (!positionals[0]) throw new ManagerError('ARG_REQUIRED', 'remove 需要一个服务 id 或名称');
  const service = store.requireService(positionals[0]);
  const runtime = await getServiceRuntime(store, service);
  // 外部进程不受管理台控制，删除登记时不能也不该去停止它。
  const external = runtime.state === 'external';
  if (['running', 'starting', 'unresponsive'].includes(runtime.state)) {
    if (!flags.force) {
      throw new ManagerError('SERVICE_RUNNING', `${service.name} 正在运行；加 --force 先停止再删除`);
    }
    if (service.type === 'aidash') await stopAidash(store, service, { force: true });
    else await stopRunner(store, service, { force: true });
  }
  store.removeService(service.id);
  if (flags.json) printJson({ ok: true, data: { removed: service.id, name: service.name, external } });
  else process.stdout.write(`已删除服务 ${service.name}（配置文件与日志保留在原处）${external ? '；外部进程未受影响' : ''}\n`);
  return 0;
}

async function followLog(filePath) {
  let offset = 0;
  try {
    offset = fs.statSync(filePath).size;
  } catch {
    offset = 0;
  }
  process.stdout.write('--- 开始跟随日志（Ctrl+C 退出）---\n');
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  try {
    while (!stopped) {
      await sleep(500);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.size < offset) offset = 0;
      if (stat.size > offset) {
        const fd = fs.openSync(filePath, 'r');
        try {
          const length = stat.size - offset;
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, offset);
          process.stdout.write(buffer.toString('utf8'));
          offset = stat.size;
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
  }
  return 0;
}

async function cmdLogs(flags, positionals) {
  const store = newStore(flags);
  if (!positionals[0]) throw new ManagerError('ARG_REQUIRED', 'logs 需要一个服务 id 或名称');
  const service = store.requireService(positionals[0]);
  const result = getServiceLogs(store, service, {
    source: flags.source ?? 'auto',
    lines: parseNumberFlag(flags.lines, '--lines', 200),
  });
  if (flags.json && !flags.follow) {
    printJson({ ok: true, data: result });
    return 0;
  }
  if (!result.exists) {
    process.stdout.write(`日志文件不存在：${result.path}\n`);
    return 0;
  }
  process.stdout.write(`${result.lines.join('\n')}${result.lines.length ? '\n' : ''}`);
  if (flags.follow) await followLog(result.path);
  return 0;
}

function configView(store, service) {
  if (service.type === 'aidash') {
    const file = readAidashConfigFile(service.aidash.configPath);
    return {
      type: 'aidash',
      config_path: service.aidash.configPath,
      mode: service.aidash.configMode,
      file,
      effective: effectiveAidashSettings(service),
    };
  }
  const file = readRunnerConfigFile(service.runner.configPath);
  return {
    type: 'runner',
    config_path: service.runner.configPath,
    file,
    effective: effectiveRunnerSettings(service),
    runner_entry: detectRunnerEntry(service.cwd, service.runner.runnerEntry),
  };
}

async function cmdConfig(flags, positionals) {
  const store = newStore(flags);
  const sub = positionals[0];
  const target = positionals[1];
  if (sub !== 'get' && sub !== 'set') {
    throw new ManagerError('ARG_INVALID', '用法：config get|set <id|name> [key] [value]');
  }
  if (!target) throw new ManagerError('ARG_REQUIRED', 'config 需要一个服务 id 或名称');
  const service = store.requireService(target);

  if (sub === 'get') {
    const view = configView(store, service);
    if (flags.json) {
      printJson({ ok: true, data: view });
      return 0;
    }
    process.stdout.write(
      `配置文件: ${view.config_path}\n存在: ${view.file.exists ? '是' : '否'}\n` +
        (view.file.errors?.length ? `错误:\n${view.file.errors.map((item) => `  - ${item}`).join('\n')}\n` : '') +
        (view.file.text ? `${view.file.text}\n` : ''),
    );
    return 0;
  }

  const key = positionals[2];
  const rawValue = positionals[3];
  if (!key) throw new ManagerError('ARG_REQUIRED', 'config set 需要 key');
  if (rawValue === undefined) throw new ManagerError('ARG_REQUIRED', 'config set 需要 value');
  let value = rawValue;
  try {
    value = JSON.parse(rawValue);
  } catch {
    // 非 JSON 就按字符串写入。
  }
  if (service.type === 'aidash') {
    const file = readAidashConfigFile(service.aidash.configPath);
    const raw = file.raw ?? {};
    raw[key] = value;
    writeAidashConfigFile(service.aidash.configPath, raw);
    store.replaceService(applyConfigToService(service, raw));
  } else {
    const file = readRunnerConfigFile(service.runner.configPath);
    const raw = file.raw ?? {};
    raw[key] = value;
    writeRunnerConfigFile(service.runner.configPath, raw);
    store.replaceService(applyRunnerConfigToService(service, raw));
  }
  if (flags.json) printJson({ ok: true, data: { config_path: configView(store, service).config_path, key } });
  else process.stdout.write(`已写入 ${key}\n`);
  return 0;
}

function buildAddSpec(flags, type) {
  const tokenSource = flags['token-source'] === 'manager' ? 'manager' : flags['token-source'] === 'env' ? 'env' : flags.token || flags['token-file'] ? 'manager' : 'env';
  const tokenEnv = flags['token-env'] ?? 'AIDASH_TOKEN';
  if (type === 'aidash') {
    return {
      host: flags.host ?? '127.0.0.1',
      port: parseNumberFlag(flags.port, '--port', 8787),
      configMode: flags['config-mode'] ?? 'env',
      configPath: flags['config-path'],
      appDir: flags['app-dir'],
      serverEntry: flags['server-entry'],
      dbPath: flags['db-path'],
      backupDir: flags['backup-dir'],
      staticDir: flags['static-dir'],
      tokenSource,
      tokenEnv,
    };
  }
  const matchAll = !flags['no-match-all'];
  return {
    template: flags.template ?? 'claude',
    aidashUrl: flags.url ?? 'http://127.0.0.1:8787/mcp',
    harnessId: flags['harness-id'],
    runnerName: flags.name,
    configPath: flags['config-path'],
    dataDir: flags['data-dir'] ?? flags['data-dir-runner'],
    logFile: flags['log-file'],
    runnerEntry: flags['runner-entry'],
    // 留空时由 normalizeRunnerSpec 使用服务工作目录；不要再把 flags.cwd
    // 传进来——normalizeRunnerSpec 会以 cwd 为基准解析相对路径，相对
    // --cwd 会被拼成 <cwd>/<cwd>。
    runCwd: flags['run-cwd'],
    channels: flags.channels ? flags.channels.split(',').map((item) => item.trim()).filter(Boolean) : [],
    ensureChannel: flags['ensure-channel'],
    channelTitle: flags['channel-title'],
    match: {
      matchAll: flags['match-all'] ? true : matchAll,
      tags: flags.tags ? flags.tags.split(',') : [],
      titlePrefix: flags['title-prefix'],
      channelKey: flags['channel-key'],
      priority: flags.priority ? flags.priority.split(',') : [],
      kind: flags.kind ? flags.kind.split(',') : [],
    },
    pollSeconds: parseNumberFlag(flags.poll, '--poll', 5),
    leaseSeconds: parseNumberFlag(flags.lease, '--lease', 900),
    heartbeatSeconds: parseNumberFlag(flags.heartbeat, '--heartbeat', 60),
    gapSeconds: parseNumberFlag(flags.gap, '--gap', 2),
    commandTimeoutSeconds: parseNumberFlag(flags['command-timeout'], '--command-timeout', 1800),
    tokenSource,
    tokenEnv,
  };
}

async function cmdAdd(flags, positionals) {
  const type = positionals[0];
  if (type !== 'aidash' && type !== 'runner') {
    throw new ManagerError('ARG_INVALID', '用法：add aidash|runner ...（见 --help）');
  }
  const store = newStore(flags);
  if (!flags.name) throw new ManagerError('ARG_REQUIRED', '--name 必填');
  if (!flags.cwd) throw new ManagerError('ARG_REQUIRED', '--cwd 必填（服务的工作目录）');
  const spec = buildAddSpec(flags, type);
  const token = readTokenFlag(flags);
  if (spec.tokenSource === 'manager' && !token) {
    throw new ManagerError('TOKEN_REQUIRED', '--token-source manager 时必须用 --token 或 --token-file 提供令牌');
  }
  // 与 Web 创建走同一套落盘逻辑：runner 生成配置，AIDash 文件模式生成配置。
  const created = await createServiceWithFiles(store, {
    type,
    name: flags.name,
    cwd: flags.cwd,
    spec,
    token,
    useExistingConfig: flags['use-existing-config'],
  });
  if (flags.json) printJson({ ok: true, data: publicService(created, { hasToken: Boolean(token) || store.getSecret(created.id) }) });
  else process.stdout.write(`已创建 ${type} 服务：${created.name}（${created.id}）\n`);
  return 0;
}

function cmdTemplates(flags) {
  const templates = templateSummaries();
  if (flags.json) {
    printJson({ ok: true, data: templates });
    return 0;
  }
  for (const item of templates) {
    process.stdout.write(`${item.key}\t${item.name}\t${item.command || '(自定义)'}\n  ${item.description}\n`);
  }
  return 0;
}

async function cmdOpen(flags, positionals) {
  const store = newStore(flags);
  let url;
  if (positionals[0]) {
    const service = store.requireService(positionals[0]);
    url = serviceWebUrl(store, service);
    if (!url) throw new ManagerError('URL_UNKNOWN', `无法从服务 ${service.name} 推导出网页地址`);
  } else {
    // 优先读管理台启动时留下的实际地址；没有运行中的管理台时给出默认地址提示。
    const runtime = store.readWebRuntime();
    const alive = runtime && Number.isInteger(runtime.pid) && isProcessAlive(runtime.pid);
    const base = alive ? runtime.url : `http://${DEFAULT_WEB_HOST}:${DEFAULT_WEB_PORT}`;
    url = `${String(base).replace(/\/+$/, '')}/?token=${store.webToken()}`;
  }
  const opened = await openBrowser(url);
  if (flags.json) printJson({ ok: true, data: { url, opened } });
  else process.stdout.write(`${url}\n${opened ? '' : '（自动打开浏览器失败，请手动复制上面的链接）\n'}`);
  return 0;
}

export async function runMain(argv) {
  const wantsJson = argv.includes('--json');
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    if (wantsJson) printJson({ ok: false, error: { code: error.code ?? 'ERROR', message: errorMessage(error) } });
    else process.stderr.write(`错误：${errorMessage(error)}\n`);
    return 2;
  }
  const { command, positionals, flags } = parsed;
  if (flags.version || command === 'version') {
    if (flags.json) printJson({ ok: true, data: { version: VERSION } });
    else process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || command === 'help') {
    if (flags.json) printJson({ ok: true, data: { version: VERSION, help: HELP } });
    else process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (command) {
      case 'web':
        return await cmdWeb(flags);
      case 'list':
        return await cmdList(flags);
      case 'status':
        return await cmdStatus(flags, positionals);
      case 'start':
      case 'stop':
      case 'restart':
        return await cmdStartStopRestart(flags, positionals, command);
      case 'remove':
        return await cmdRemove(flags, positionals);
      case 'logs':
        return await cmdLogs(flags, positionals);
      case 'config':
        return await cmdConfig(flags, positionals);
      case 'add':
        return await cmdAdd(flags, positionals);
      case 'templates':
        return cmdTemplates(flags);
      case 'open':
        return await cmdOpen(flags, positionals);
      default:
        process.stdout.write(HELP);
        return 0;
    }
  } catch (error) {
    if (flags.json) {
      printJson({
        ok: false,
        error: {
          code: error.code ?? 'ERROR',
          message: errorMessage(error),
          details: error.details ?? null,
        },
      });
    } else {
      process.stderr.write(`错误：${errorMessage(error)}\n`);
      if (error.details?.errors?.length) {
        for (const item of error.details.errors) process.stderr.write(`  - ${item}\n`);
      }
    }
    return error.code === 'ARG_REQUIRED' || error.code === 'ARG_INVALID' || error.code === 'ARG_UNKNOWN' ? 2 : 1;
  }
}
