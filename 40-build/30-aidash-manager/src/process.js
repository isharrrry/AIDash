import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ManagerError } from './errors.js';
import {
  effectiveAidashSettings,
  effectiveRunnerSettings,
  aidashUrlOf,
  detectRunnerEntry,
  findAidashProgram,
  healthUrlOf,
  normalizeAidashSpec,
  sanitizeInstanceId,
} from './service.js';
import { buildRunnerConfig, readRunnerConfigFile, writeRunnerConfigFile } from './runner-config.js';
import { mergeServiceIntoConfig, readAidashConfigFile, writeAidashConfigFile } from './aidash-config.js';
import { aidashLayoutCandidates } from './constants.js';
import { mergeSummaries, readServiceLog, summarizeLog } from './logs.js';
import {
  ensureDirSync,
  exists,
  isPidAlive,
  killTree,
  readFileTail,
  runProcess,
  sleep,
  tailLines,
  truncate,
  waitFor,
} from './util.js';

/**
 * 服务进程管理。
 *
 * AIDash 服务端与 runner 的生命周期模型不同，不能硬套一套：
 * - AIDash 是前台 Node 进程，管理台负责把它 detached 拉起来、按 PID 树停止；
 * - runner 自带 --daemon 与控制面，管理台只负责调用它的 CLI + 读 registry，
 *   停止走控制面/CLI，避免直接杀 PID 把任务租约留在半空。
 *
 * “运行中”的判定都以实际港口/控制面为准，不只看 PID：PID 会被复用，
 * 而管理台自己的状态文件可能在上次崩溃前没来得及更新。
 */

const HEALTH_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 25_000;
const STOP_TIMEOUT_MS = 25_000;

export function resolveTokenForService(store, service) {
  const spec = service.type === 'aidash' ? service.aidash : service.runner;
  if (!spec) throw new ManagerError('SERVICE_INVALID', '服务定义缺少类型配置');
  if (spec.tokenSource === 'env') {
    const token = process.env[spec.tokenEnv];
    if (!token) {
      throw new ManagerError(
        'TOKEN_MISSING',
        `服务 ${service.name} 使用环境变量 ${spec.tokenEnv} 提供令牌，但启动管理台的进程里没有这个变量`,
      );
    }
    return token;
  }
  const token = store.getSecret(service.id);
  if (!token) {
    throw new ManagerError(
      'TOKEN_MISSING',
      `服务 ${service.name} 还没有保存令牌；请在配置里填写 AIDASH_TOKEN`,
    );
  }
  return token;
}

function baseEnv(service, token) {
  const spec = service.type === 'aidash' ? service.aidash : service.runner;
  const env = { ...process.env, ...(spec.env ?? {}) };
  env.AIDASH_TOKEN = token;
  return env;
}

/**
 * 探测类请求的硬性 deadline。
 *
 * 只用 AbortSignal.timeout 还不够：一旦底层连接/DNS 卡住，abort 不保证让
 * fetch 立刻结算，getAidashRuntime 就会被拖住（Windows 上半开连接尤其常见）。
 * 这里再加一层 Promise.race 兜底，并在 finally 里统一 abort，保证：
 * 1. 每次探测都有明确时间上界，状态查询不会被单个端口拖死；
 * 2. 本次探测的连接不会以半开状态留在 fetch 的全局 keep-alive 池里。
 */
async function withProbeDeadline(timeoutMs, label, work) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs);
  timer.unref?.();
  let hardTimer;
  const hardTimeout = new Promise((_, reject) => {
    hardTimer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs + 250);
    hardTimer.unref?.();
  });
  try {
    return await Promise.race([work(controller.signal), hardTimeout]);
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    controller.abort();
  }
}

async function probeHealth(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    return await withProbeDeadline(timeoutMs, '健康探测', async (signal) => {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal,
      });
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    });
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function probeControl(entry, pathname, { method = 'GET', timeoutMs = 1_500 } = {}) {
  try {
    return await withProbeDeadline(timeoutMs, '控制面探测', async (signal) => {
      const url = new URL(pathname.replace(/^\/+/, ''), `${String(entry.control_url).replace(/\/+$/, '')}/`);
      const response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${entry.control_token}`, accept: 'application/json' },
        redirect: 'error',
        signal,
      });
      const text = await response.text().catch(() => '');
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        return { ok: false, status: response.status, error: parsed?.error?.message ?? text ?? `HTTP ${response.status}` };
      }
      return { ok: true, status: response.status, data: parsed?.data ?? parsed };
    });
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function checkPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => {
      resolve({ ok: false, reason: error.code === 'EADDRINUSE' ? 'EADDRINUSE' : error.message });
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve({ ok: true }));
    });
  });
}

function appendLogHeader(logFile, lines) {
  ensureDirSync(path.dirname(logFile), 0o700);
  const header = lines.map((line) => `[aidash-manager] ${line}`).join('\n');
  fs.appendFileSync(logFile, `${header}\n`, { encoding: 'utf8', mode: 0o600 });
}

function spawnDetached(command, args, { cwd, env, logFile }) {
  ensureDirSync(path.dirname(logFile), 0o700);
  const fd = fs.openSync(logFile, 'a', 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener('error', onError);
      child.unref();
      resolve(child);
    };
    const onError = (error) => {
      child.removeListener('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function lastLogLines(filePath, count = 12) {
  try {
    const { text } = readFileTail(filePath, 128 * 1024);
    return tailLines(text, count).lines;
  } catch {
    return [];
  }
}

export async function getAidashRuntime(store, service) {
  const settings = effectiveAidashSettings(service);
  const runState = store.readRunState(service.id);
  const pid = Number.isInteger(runState?.pid) ? runState.pid : null;
  const pidAlive = pid ? isPidAlive(pid) : false;
  const health = await probeHealth(healthUrlOf(settings));
  const startedAt = runState?.startedAt ?? null;
  const uptimeMs = startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : null;

  let state = 'stopped';
  let detail = '';
  if (health.ok && pidAlive) {
    state = 'running';
    detail = '管理台拉起的进程正在运行';
  } else if (health.ok && !pidAlive) {
    state = 'external';
    detail = '端口上有 AIDash 在响应，但不是本管理台拉起的进程；不能从这里停止';
  } else if (pidAlive) {
    const age = startedAt ? Date.now() - Date.parse(startedAt) : Number.POSITIVE_INFINITY;
    state = age < 30_000 ? 'starting' : 'unresponsive';
    detail =
      state === 'starting'
        ? '进程已启动，正在等待健康检查通过'
        : '进程还在，但健康检查持续失败；查看日志确认是否卡在迁移/端口/数据库';
  } else if (runState?.lastExit && runState.lastExit.code !== 0) {
    state = 'error';
    detail = `上次进程退出码 ${runState.lastExit.code ?? runState.lastExit.signal}`;
  } else {
    detail = settings.fileError ?? '未运行';
  }

  return {
    state,
    alive: health.ok,
    pid,
    pid_alive: pidAlive,
    url: aidashUrlOf(settings),
    health: health.ok ? health.body : { error: health.error ?? `HTTP ${health.status}` },
    started_at: startedAt,
    uptime_ms: uptimeMs,
    detail,
    last_exit: runState?.lastExit ?? null,
    last_error: runState?.lastError ?? (settings.fileError || null),
    config_error: settings.fileError,
    log_file: store.logFile(service.id),
    host: settings.host,
    port: settings.port,
  };
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (value) => path.resolve(String(value));
  const left = norm(a);
  const right = norm(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * 修复旧版本写进配置文件里的“猜测布局”路径。
 *
 * 旧版在数据目录里找不到程序时，会把 `40-build/10-aidash/...` 的猜测值同时写进
 * 服务定义和配置文件。服务定义由 normalizeAidashSpec 重算；文件模式下配置文件
 * 才是运行时真源，所以这里只在“记录明确标记 layoutMatched=false 且文件值正是
 * 旧猜测值”时替换对应键，不碰用户手工改过的其它路径。
 */
function repairLegacyFileConfig(service, effectiveService) {
  const spec = service.aidash;
  if (spec.configMode !== 'file' || spec.layoutMatched !== false || !exists(spec.configPath)) return false;
  const guessed = aidashLayoutCandidates(service.cwd)[1];
  const file = readAidashConfigFile(spec.configPath);
  if (!file.exists || !file.raw || file.errors.length > 0) return false;
  const raw = { ...file.raw };
  let changed = false;
  for (const [key, oldValue, nextValue] of [
    ['db_path', guessed.dbPath, effectiveService.aidash.dbPath],
    ['backup_dir', guessed.backupDir, effectiveService.aidash.backupDir],
    ['static_dir', guessed.staticDir, effectiveService.aidash.staticDir],
  ]) {
    if (typeof raw[key] === 'string' && samePath(raw[key], oldValue) && !samePath(raw[key], nextValue)) {
      raw[key] = nextValue;
      changed = true;
    }
  }
  if (changed) writeAidashConfigFile(spec.configPath, raw);
  return changed;
}

export async function startAidash(store, service) {
  // 程序由管理台提供，服务的工作目录只放数据。配置里的入口失效时，先按同一套
  // 程序探测（管理台同装程序 / 已登记服务）重算整个服务定义，而不是卡在用户的数据目录里。
  let spec = service.aidash;
  let searched = [];
  if (!exists(spec.serverEntry)) {
    const normalized = normalizeAidashSpec(spec, { cwd: service.cwd, store });
    if (normalized.serverEntry && exists(normalized.serverEntry)) {
      spec = normalized;
    } else {
      searched = findAidashProgram({
        serverEntry: spec.serverEntry,
        appDir: spec.appDir,
        cwd: service.cwd,
        store,
      }).searched;
    }
  }
  const effectiveService = spec === service.aidash ? service : { ...service, aidash: spec };
  if (spec !== service.aidash && store.getService(service.id)) {
    // 把修复结果写回清单：概览/配置页随后显示的就是实际使用的程序与数据路径。
    store.replaceService({ ...service, aidash: spec, updatedAt: new Date().toISOString() });
  }
  const repairedLegacyConfig = repairLegacyFileConfig(service, effectiveService);
  const settings = effectiveAidashSettings(effectiveService);
  const current = await getAidashRuntime(store, service);
  if (current.state === 'running' || current.state === 'external') {
    throw new ManagerError(
      'ALREADY_RUNNING',
      `${service.name} 已在 ${aidashUrlOf(settings)} 运行${current.state === 'external' ? '（外部进程）' : ''}`,
      { status: 409 },
    );
  }
  if (!exists(settings.configPath) && service.aidash.configMode === 'file') {
    // 文件模式第一次启动时自动生成核心配置，避免用户切换模式后因文件缺失而连错默认库。
    const existing = {};
    writeAidashConfigFile(settings.configPath, mergeServiceIntoConfig(effectiveService, existing));
  }
  if (!exists(spec.serverEntry)) {
    throw new ManagerError(
      'ENTRY_MISSING',
      `未找到 AIDash 服务端程序（配置入口：${spec.serverEntry || '(未设置)'}）。` +
        '管理台会从自身安装目录、AIDASH_APP_DIR / AIDASH_SERVER_ENTRY 和已登记服务中寻找；' +
        '可以在服务配置的“程序目录”里指定 AIDash 安装目录（包含 server/dist 或 dist）。' +
        (searched.length ? `\n已检查：\n${searched.map((item) => `  - ${item}`).join('\n')}` : ''),
      { details: { searched } },
    );
  }
  if (service.aidash.configMode === 'file') {
    // AIDash 启动时按 dist/server 的相对位置读配置 Schema；独立部署若没把
    // 00-platform/config/schema 一起带上，文件模式会在启动后才报 CONFIG_SCHEMA_MISSING。
    // 这里提前拦住，给出比日志更直接的修复建议。
    const schemaPath = path.resolve(
      path.dirname(spec.serverEntry),
      '../../../00-platform/config/schema/aidash-config.schema.json',
    );
    if (!exists(schemaPath)) {
      throw new ManagerError(
        'CONFIG_SCHEMA_MISSING',
        `该 AIDash 部署缺少配置 Schema（期望 ${schemaPath}），无法使用配置文件模式；` +
          '请改用环境变量模式，或把 00-platform/config/schema 随部署一起复制',
      );
    }
  }
  const token = resolveTokenForService(store, service);
  const portCheck = await checkPortAvailable(settings.host, settings.port);
  if (!portCheck.ok) {
    throw new ManagerError(
      'PORT_IN_USE',
      `端口 ${settings.host}:${settings.port} 已被占用（${portCheck.reason}）；请换一个端口或先停止占用进程`,
      { status: 409 },
    );
  }

  const env = baseEnv(service, token);
  env.AIDASH_CONFIG = settings.configPath;
  if (service.aidash.configMode === 'env') {
    env.AIDASH_HOST = settings.host;
    env.AIDASH_PORT = String(settings.port);
    env.AIDASH_DB_PATH = settings.dbPath;
    env.AIDASH_BACKUP_DIR = settings.backupDir;
    env.AIDASH_STATIC_DIR = settings.staticDir;
    env.AIDASH_LOG_LEVEL = settings.logLevel;
  } else {
    // 文件模式必须清掉从管理台继承来的同名变量，否则“配置文件模式”会被环境变量悄悄覆盖。
    for (const key of [
      'AIDASH_HOST',
      'AIDASH_PORT',
      'AIDASH_DB_PATH',
      'AIDASH_BACKUP_DIR',
      'AIDASH_STATIC_DIR',
      'AIDASH_LOG_LEVEL',
    ]) {
      delete env[key];
    }
  }

  const logFile = store.logFile(service.id);
  appendLogHeader(logFile, [
    `启动 ${service.name}（${new Date().toISOString()}）`,
    `entry=${spec.serverEntry} cwd=${service.cwd}`,
    `config=${settings.configPath} mode=${service.aidash.configMode} listen=${settings.host}:${settings.port}`,
    ...(repairedLegacyConfig ? ['已修复旧版本写入配置文件的数据/静态路径'] : []),
  ]);
  let child;
  try {
    child = await spawnDetached(process.execPath, [spec.serverEntry], {
      cwd: service.cwd,
      env,
      logFile,
    });
  } catch (error) {
    throw new ManagerError('SPAWN_FAILED', `启动失败：${error.message}`, { status: 400 });
  }
  const pid = child.pid;
  const startedAt = new Date().toISOString();
  store.writeRunState(service.id, {
    pid,
    startedAt,
    command: [process.execPath, spec.serverEntry].join(' '),
    logFile,
  });
  child.once('exit', (code, signal) => {
    const previous = store.readRunState(service.id);
    if (previous?.pid === pid) {
      store.writeRunState(service.id, {
        ...previous,
        lastExit: { code, signal, at: new Date().toISOString() },
      });
    }
  });

  const healthy = await waitFor(
    async () => {
      if (!isPidAlive(pid)) return 'dead';
      const probe = await probeHealth(healthUrlOf(settings), 800);
      return probe.ok ? 'ok' : null;
    },
    { timeoutMs: START_TIMEOUT_MS, intervalMs: 350 },
  );
  if (healthy === 'ok') return getAidashRuntime(store, service);
  if (healthy === 'dead') {
    const lines = lastLogLines(logFile, 20);
    throw new ManagerError(
      'START_FAILED',
      `AIDash 启动后立即退出；日志尾部：\n${lines.join('\n') || '(无输出)'}`,
      { status: 500, details: { log_file: logFile } },
    );
  }
  // 超时但进程还在：保留进程，返回 starting；页面可以继续看日志。
  return getAidashRuntime(store, service);
}

export async function stopAidash(store, service, { force = true } = {}) {
  const runtime = await getAidashRuntime(store, service);
  if (runtime.state === 'external') {
    throw new ManagerError(
      'EXTERNAL_PROCESS',
      '这个 AIDash 不是管理台拉起的（没有 PID 记录），请在它自己的终端/脚本里停止',
      { status: 409 },
    );
  }
  if (!runtime.pid || !runtime.pid_alive) {
    store.clearRunState(service.id);
    return { already_stopped: true, ...runtime };
  }
  // Windows 上 taskkill 不带 /F 只是发 WM_CLOSE，控制台里的 node 进程通常收不到；
  // 对 AIDash 直接强制结束进程树，POSIX 才保留 SIGTERM 的优雅退出。
  const forceKill = force || process.platform === 'win32';
  appendLogHeader(store.logFile(service.id), [
    `停止 ${service.name}（${new Date().toISOString()}）pid=${runtime.pid} force=${forceKill}`,
  ]);
  await killTree(runtime.pid, { force: forceKill });
  const dead = await waitFor(() => !isPidAlive(runtime.pid), { timeoutMs: STOP_TIMEOUT_MS, intervalMs: 300 });
  if (!dead) {
    throw new ManagerError('STOP_FAILED', `无法结束进程树 PID ${runtime.pid}；请用任务管理器核对`, { status: 500 });
  }
  store.clearRunState(service.id);
  return { already_stopped: false, ...(await getAidashRuntime(store, service)) };
}

export function runnerRegistryFile(settings) {
  return path.join(settings.dataDir, 'instances', `${settings.instanceId}.json`);
}

export function readRunnerRegistry(settings) {
  const file = runnerRegistryFile(settings);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return { exists: true, invalid: true, file };
    return { exists: true, invalid: false, file, entry: raw };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, invalid: false, file };
    return { exists: true, invalid: true, file, error: error.message };
  }
}

export async function getRunnerRuntime(store, service) {
  const settings = effectiveRunnerSettings(service);
  const runState = store.readRunState(service.id);
  const registry = readRunnerRegistry(settings);
  if (!registry.exists) {
    return {
      state: runState?.lastError ? 'error' : 'stopped',
      alive: false,
      pid: null,
      pid_alive: false,
      instance_id: settings.instanceId,
      url: null,
      aidash_url: settings.aidashUrl,
      started_at: null,
      uptime_ms: null,
      detail: runState?.lastError ?? settings.fileError ?? '未运行',
      last_error: runState?.lastError ?? settings.fileError ?? null,
      last_exit: runState?.lastExit ?? null,
      config_error: settings.fileError,
      log_file: settings.logFile,
      data_dir: settings.dataDir,
      config_path: settings.configPath,
      current_task: null,
      last_poll_at: null,
      busy: false,
    };
  }
  if (registry.invalid) {
    return {
      state: 'error',
      alive: false,
      pid: null,
      pid_alive: false,
      instance_id: settings.instanceId,
      url: null,
      aidash_url: settings.aidashUrl,
      detail: `runner registry 损坏：${registry.error ?? registry.file}`,
      last_error: registry.error ?? null,
      config_error: settings.fileError,
      log_file: settings.logFile,
      data_dir: settings.dataDir,
      config_path: settings.configPath,
      current_task: null,
      last_poll_at: null,
      busy: false,
    };
  }
  const entry = registry.entry;
  const pid = Number.isInteger(entry.pid) ? entry.pid : null;
  const pidAlive = pid ? isPidAlive(pid) : false;
  const startedAt = typeof entry.started_at === 'string' ? entry.started_at : null;
  const uptimeMs = startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : null;
  if (!pidAlive) {
    return {
      state: 'stopped',
      alive: false,
      pid,
      pid_alive: false,
      instance_id: entry.instance_id ?? settings.instanceId,
      url: null,
      aidash_url: settings.aidashUrl,
      started_at: startedAt,
      uptime_ms: null,
      detail: `实例记录已失效（PID ${pid ?? '?'} 不存在）`,
      last_error: runState?.lastError ?? null,
      last_exit: runState?.lastExit ?? null,
      config_error: settings.fileError,
      log_file: entry.log_file || settings.logFile,
      data_dir: settings.dataDir,
      config_path: settings.configPath,
      current_task: null,
      last_poll_at: null,
      busy: false,
    };
  }
  const health = await probeControl(entry, '/health', { timeoutMs: 1_200 });
  let status = null;
  if (health.ok) status = await probeControl(entry, '/status', { timeoutMs: 1_200 });
  const age = startedAt ? Date.now() - Date.parse(startedAt) : Number.POSITIVE_INFINITY;
  const state = health.ok ? 'running' : age < 30_000 ? 'starting' : 'unresponsive';
  const statusData = status?.ok ? status.data : null;
  return {
    state,
    alive: health.ok,
    pid,
    pid_alive: pidAlive,
    instance_id: entry.instance_id ?? settings.instanceId,
    url: null,
    aidash_url: settings.aidashUrl,
    started_at: startedAt,
    uptime_ms: uptimeMs,
    detail: health.ok
      ? 'runner 控制面正常'
      : `进程存活但控制面不可达：${health.error ?? `HTTP ${health.status}`}`,
    last_error: runState?.lastError ?? null,
    last_exit: runState?.lastExit ?? null,
    config_error: settings.fileError,
    log_file: entry.log_file || settings.logFile,
    data_dir: settings.dataDir,
    config_path: settings.configPath,
    current_task: statusData?.current_task ?? statusData?.last_task ?? null,
    last_poll_at: statusData?.last_poll_at ?? null,
    busy: Boolean(statusData?.busy),
    // 控制面本来就返回 polls/claimed/completed 等计数；展示出来可以证明
    // “runner 在抓任务”，即使日志只保留轮询摘要。
    stats: statusData?.stats ?? null,
  };
}

export async function getServiceRuntime(store, service) {
  if (service.type === 'aidash') return getAidashRuntime(store, service);
  return getRunnerRuntime(store, service);
}

/**
 * 组装 `aidash-runner start` 参数。
 *
 * 单独导出是为了让测试不启动真实进程也能验证“创建/复用通道”确实进了 argv：
 * ensure-channel 只在启动时执行一次，参数漏传时用户在 AIDash 里看不到通道，
 * 现场很难把原因归到管理台。
 */
export function buildRunnerStartArgs(service, settings, resolved) {
  const args = [
    ...resolved.args_prefix,
    'start',
    '--daemon',
    '--config',
    service.runner.configPath,
    '--data-dir',
    settings.dataDir,
  ];
  const ensureChannel = String(service.runner.ensureChannel ?? '').trim();
  if (ensureChannel) {
    args.push('--ensure-channel', ensureChannel);
    const channelTitle = String(service.runner.channelTitle ?? '').trim();
    if (channelTitle) args.push('--channel-title', channelTitle);
  }
  return args;
}

export async function startRunner(store, service) {
  const current = await getRunnerRuntime(store, service);
  if (current.state === 'running' || current.state === 'starting') {
    throw new ManagerError('ALREADY_RUNNING', `${service.name} 已在运行（${current.instance_id}）`, {
      status: 409,
    });
  }
  const request = readRunnerConfigFile(service.runner.configPath);
  if (!request.exists) {
    const config = buildRunnerConfig(service);
    writeRunnerConfigFile(service.runner.configPath, config);
  } else if (request.errors.length > 0) {
    throw new ManagerError('CONFIG_INVALID', `runner 配置有错误，先修复再启动`, {
      details: { errors: request.errors },
    });
  }
  const resolved = detectRunnerEntry(service.cwd, service.runner.runnerEntry);
  if (resolved.path && !resolved.exists) {
    throw new ManagerError('RUNNER_ENTRY_MISSING', `找不到 runner 入口：${resolved.path}`);
  }
  const token = resolveTokenForService(store, service);
  const env = baseEnv(service, token);
  // data_dir 以配置文件里的值为准：用户可能直接编辑过文件，若这里传旧的 spec 值，
  // CLI 覆盖会让 runner 把 registry 写到另一个目录，状态查询就会“找不到实例”。
  const runnerSettings = effectiveRunnerSettings(service);
  const args = buildRunnerStartArgs(service, runnerSettings, resolved);
  const logFile = store.logFile(service.id);
  appendLogHeader(logFile, [
    `启动 runner ${service.name}（${new Date().toISOString()}）`,
    `command=${resolved.command} ${args.join(' ')}`,
  ]);
  const result = await runProcess(resolved.command, args, {
    cwd: service.cwd,
    env,
    timeoutMs: 40_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
  if (output) fs.appendFileSync(logFile, `${output}\n`, { encoding: 'utf8', mode: 0o600 });
  store.writeRunState(service.id, {
    startedAt: new Date().toISOString(),
    logFile,
    lastExit: { code: result.code, signal: result.signal, at: new Date().toISOString() },
  });
  const recordStartFailure = (message) => {
    const previous = store.readRunState(service.id) ?? {};
    store.writeRunState(service.id, { ...previous, lastError: message, lastExit: previous.lastExit ?? null });
  };
  if (result.timedOut) {
    const lines = lastLogLines(logFile, 20);
    const message = `runner start --daemon 超时；日志尾部：\n${lines.join('\n')}`;
    recordStartFailure(message);
    throw new ManagerError('RUNNER_START_TIMEOUT', message, { status: 500 });
  }
  if (result.code !== 0) {
    const lines = lastLogLines(logFile, 20);
    const message = `runner 启动失败（退出码 ${result.code}）：\n${lines.join('\n')}`;
    recordStartFailure(message);
    throw new ManagerError('RUNNER_START_FAILED', message, {
      status: 500,
      details: { stderr: truncate(result.stderr ?? '', 2_000) },
    });
  }
  const running = await waitFor(
    async () => {
      const runtime = await getRunnerRuntime(store, service);
      return runtime.state === 'running' || runtime.state === 'unresponsive' ? runtime : null;
    },
    { timeoutMs: START_TIMEOUT_MS, intervalMs: 400 },
  );
  if (!running) {
    const lines = lastLogLines(logFile, 20);
    const message = `runner 命令已返回，但控制面没有就绪；日志尾部：\n${lines.join('\n') || '(无输出)'}`;
    recordStartFailure(message);
    throw new ManagerError('RUNNER_START_UNCONFIRMED', message, { status: 500 });
  }
  const previous = store.readRunState(service.id) ?? {};
  store.writeRunState(service.id, { ...previous, lastError: null });
  return running;
}

export async function stopRunner(store, service, { force = false } = {}) {
  const settings = effectiveRunnerSettings(service);
  const runtime = await getRunnerRuntime(store, service);
  if (!runtime.pid || !runtime.pid_alive) {
    store.clearRunState(service.id);
    return { already_stopped: true, ...runtime };
  }
  appendLogHeader(store.logFile(service.id), [
    `停止 runner ${service.name}（${new Date().toISOString()}）pid=${runtime.pid} force=${force}`,
  ]);
  const registry = readRunnerRegistry(settings);
  let controlOk = false;
  if (!registry.invalid && registry.entry) {
    const response = await probeControl(registry.entry, '/stop', { method: 'POST', timeoutMs: 5_000 });
    controlOk = response.ok;
  }
  if (force || !controlOk) {
    await killTree(runtime.pid, { force: true });
  }
  const dead = await waitFor(() => !isPidAlive(runtime.pid), {
    timeoutMs: STOP_TIMEOUT_MS,
    intervalMs: 300,
  });
  if (!dead) {
    await killTree(runtime.pid, { force: true });
    const deadAfterKill = await waitFor(() => !isPidAlive(runtime.pid), { timeoutMs: 5_000, intervalMs: 200 });
    if (!deadAfterKill) {
      throw new ManagerError('RUNNER_STOP_FAILED', `无法结束 runner 进程 PID ${runtime.pid}`, { status: 500 });
    }
  }
  store.clearRunState(service.id);
  return { already_stopped: false, ...(await getRunnerRuntime(store, service)) };
}

export async function restartService(store, service) {
  if (service.type === 'aidash') await stopAidash(store, service, { force: true });
  else await stopRunner(store, service, { force: false });
  // 停止后立刻启动可能撞上端口/registry 清理的最后一刻；给 300ms 缓冲。
  await sleep(300);
  return service.type === 'aidash' ? startAidash(store, service) : startRunner(store, service);
}

export function serviceLogFiles(store, service) {
  const managerLog = { key: 'manager', label: '管理台启动日志', path: store.logFile(service.id) };
  if (service.type === 'aidash') return [managerLog];
  const settings = effectiveRunnerSettings(service);
  const files = [];
  if (settings.logFile && path.resolve(settings.logFile) !== path.resolve(managerLog.path)) {
    files.push({ key: 'runner', label: 'runner 运行日志', path: settings.logFile });
  }
  files.push(managerLog);
  return files;
}

export function getServiceLogs(store, service, { source = 'auto', lines = 200 } = {}) {
  const files = serviceLogFiles(store, service);
  const selected =
    source === 'auto'
      ? files.find((item) => exists(item.path)) ?? files[0]
      : files.find((item) => item.key === source);
  if (!selected) {
    throw new ManagerError('LOG_SOURCE_UNKNOWN', `未知日志来源：${source}`, { status: 404 });
  }
  const result = readServiceLog(selected.path, lines);
  return { source: selected.key, files, ...result };
}

export function getServiceErrors(store, service) {
  const files = serviceLogFiles(store, service);
  const summaries = files.map((item) => ({ ...summarizeLog(item.path), path: item.path, label: item.label }));
  return mergeSummaries(summaries);
}

/** 打开服务对应的网页地址：AIDash 返回自己的 Web；runner 返回它连接的 AIDash。 */
export function serviceWebUrl(store, service) {
  if (service.type === 'aidash') {
    return aidashUrlOf(effectiveAidashSettings(service));
  }
  const settings = effectiveRunnerSettings(service);
  try {
    const url = new URL(settings.aidashUrl);
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function serviceHealthUrl(service) {
  if (service.type !== 'aidash') return null;
  return healthUrlOf(effectiveAidashSettings(service));
}
