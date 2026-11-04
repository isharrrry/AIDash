import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  aidashDataLayout,
  aidashLayoutCandidates,
  aidashProgramLayoutCandidates,
  AIDASH_HEALTH_PATH,
  TOKEN_ENV_NAME,
} from './constants.js';
import { ManagerError } from './errors.js';
import { getTemplate, HARNESS_TEMPLATES } from './templates.js';
import {
  exists,
  hostForUrl,
  isDirectory,
  isSensitiveEnvKey,
  newServiceId,
  normalizeUrlString,
  resolvePath,
} from './util.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromHere = createRequire(import.meta.url);

const NAME_MAX = 60;
const HARNESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 与 aidash-runner/src/channel-setup.js 的 CHANNEL_KEY_PATTERN 保持一致：
// 管理台先拦住明显非法的 key，避免 restart 后由日志报错才发现。
const CHANNEL_KEY_PATTERN = /^[A-Za-z0-9._~:/-]+$/;
const CHANNEL_KEY_MAX = 200;
const CHANNEL_TITLE_MAX = 200;

export function normalizeServiceName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new ManagerError('NAME_REQUIRED', '服务名称必填');
  if (name.length > NAME_MAX) throw new ManagerError('NAME_INVALID', `服务名称不能超过 ${NAME_MAX} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ManagerError('NAME_INVALID', '服务名称不能包含控制字符');
  return name;
}

function normalizeCwd(raw) {
  const cwd = resolvePath(String(raw ?? '').trim() || '.');
  if (!isDirectory(cwd)) {
    throw new ManagerError('CWD_INVALID', `工作目录不存在或不是目录：${cwd}；请先创建目录`);
  }
  return cwd;
}

function intInRange(raw, fallback, { min, max, label, integer = true }) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ManagerError('FIELD_INVALID', `${label} 必须在 ${min}..${max} 之间${integer ? '（整数）' : ''}`);
  }
  return value;
}

function normalizeEnvMap(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManagerError('ENV_INVALID', '环境变量必须是键值对象');
  }
  const env = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new ManagerError('ENV_INVALID', `环境变量名不合法：${key}`);
    }
    if (isSensitiveEnvKey(key)) {
      throw new ManagerError(
        'ENV_SENSITIVE',
        `环境变量 ${key} 看起来是凭据；请改用服务令牌字段或 CLI 自己的登录配置`,
      );
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new ManagerError('ENV_INVALID', `环境变量 ${key} 的值必须是字符串`);
    }
    env[key] = String(value);
  }
  return env;
}

function normalizeBool(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  return String(raw) === 'true' || String(raw) === '1';
}

function uniqueHarnessId(store, desired, selfId) {
  const used = new Set(
    store
      .listServices()
      .filter((item) => item.type === 'runner' && item.id !== selfId)
      .map((item) => item.runner?.harnessId)
      .filter(Boolean),
  );
  if (!used.has(desired)) return desired;
  throw new ManagerError(
    'HARNESS_ID_CONFLICT',
    `harness_id 已被其他 runner 使用：${desired}；每个 runner 必须使用唯一标识`,
  );
}

function comparePath(filePath) {
  const resolved = path.resolve(String(filePath));
  // Windows 路径大小写不敏感；如果不归一，D:\x 与 d:\X 会被当成两个目录。
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function otherRunnerServices(store, selfId) {
  return store.listServices().filter((item) => item.type === 'runner' && item.id !== selfId && item.runner);
}

/**
 * 同一管理台里两个 runner 共用一个配置文件是危险的：后保存的会覆盖前一个，
 * 而前一个服务下次启动会读到别人的 harness_id/命令。这里在写文件前就拦住，
 * 不依赖“文件已存在”这种间接信号。
 */
export function assertRunnerConfigPathUnused(store, configPath, selfId) {
  if (!configPath) return;
  const target = comparePath(configPath);
  const conflict = otherRunnerServices(store, selfId).find(
    (item) => item.runner.configPath && comparePath(item.runner.configPath) === target,
  );
  if (conflict) {
    throw new ManagerError(
      'CONFIG_PATH_CONFLICT',
      `配置文件已被服务 ${conflict.name} 使用：${configPath}；每个 runner 必须有独立的配置文件`,
      { status: 409 },
    );
  }
}

/** 共用 data_dir 会让 registry/日志/会话状态互相踩踏；默认已按服务隔离，这里兜住显式填写。 */
export function assertRunnerDataDirUnused(store, dataDir, selfId) {
  if (!dataDir) return;
  const target = comparePath(dataDir);
  const conflict = otherRunnerServices(store, selfId).find(
    (item) => item.runner.dataDir && comparePath(item.runner.dataDir) === target,
  );
  if (conflict) {
    throw new ManagerError(
      'DATA_DIR_CONFLICT',
      `数据目录已被服务 ${conflict.name} 使用：${dataDir}；每个 runner 必须使用独立的 data_dir`,
      { status: 409 },
    );
  }
}

export function detectAidashLayout(cwd) {
  const candidates = aidashLayoutCandidates(cwd);
  const found = candidates.find((item) => exists(item.serverEntry));
  return { ...(found ?? candidates[1] ?? candidates[0]), matched: Boolean(found) };
}

/** 标准入口是 <layoutRoot>/dist/server/main.js；只有这种形状才能可靠推出程序目录与静态资源。 */
function programFromEntry(entry, source, key = 'entry') {
  const serverDir = path.dirname(entry);
  const standard = path.basename(serverDir) === 'server' && path.basename(path.dirname(serverDir)) === 'dist';
  return {
    serverEntry: entry,
    staticDir: standard ? path.resolve(serverDir, '..', 'web') : '',
    appDir: standard ? path.resolve(serverDir, '..', '..') : '',
    source,
    key,
    matched: true,
  };
}

function matchProgramRoot(root, source) {
  for (const candidate of aidashProgramLayoutCandidates(root)) {
    if (exists(candidate.serverEntry)) {
      return { ...candidate, appDir: root, source, matched: true };
    }
  }
  return null;
}

/**
 * 管理台自己可能携带/同装的 AIDash 程序位置。
 *
 * 管理台的核心职责是“提供并管理程序”，服务的工作目录只放数据；
 * 因此程序识别不能只看服务工作目录。这里覆盖三种安装形态：
 * 同仓工作区（manager 与 10-aidash 兄弟）、仓库根/部署根（manager 在下一级）、
 * 以及 npm 同装依赖（`aidash` / `@isharrrry/aidash`）。
 */
function managerProgramRoots() {
  const roots = [
    path.resolve(PACKAGE_ROOT, '..', '10-aidash'),
    path.resolve(PACKAGE_ROOT, '..', '..'),
    path.resolve(PACKAGE_ROOT, '..'),
  ];
  for (const name of ['aidash', '@isharrrry/aidash']) {
    try {
      roots.push(path.dirname(requireFromHere.resolve(`${name}/package.json`)));
    } catch {
      // 未作为管理台依赖安装时跳过。
    }
  }
  return roots;
}

/**
 * 解析 AIDash 程序位置，与服务数据目录分开。
 *
 * 顺序：显式入口/程序目录 → 环境变量 → 工作目录兼容布局 → 管理台同装程序 →
 * 已登记服务使用的程序。显式入口不存在时不会停在坏路径上，而是继续寻找
 * 管理台能提供的程序；全都没有着落才回退到用户填写的入口，由启动阶段报错。
 */
export function findAidashProgram({ serverEntry, appDir, cwd, store, searchManager = true } = {}) {
  const base = cwd || process.cwd();
  const searched = [];
  const explicitEntry = resolvePath(String(serverEntry ?? '').trim(), base);
  if (explicitEntry) {
    searched.push(`配置入口 ${explicitEntry}`);
    if (exists(explicitEntry)) return { ...programFromEntry(explicitEntry, 'explicit'), searched };
  }
  const explicitAppDir = resolvePath(String(appDir ?? '').trim(), base);
  if (explicitAppDir) {
    searched.push(`程序目录 ${explicitAppDir}`);
    const found = matchProgramRoot(explicitAppDir, 'appDir');
    if (found) return { ...found, searched };
  }
  const envEntry = resolvePath(String(process.env.AIDASH_SERVER_ENTRY ?? '').trim(), base);
  if (envEntry) {
    searched.push(`AIDASH_SERVER_ENTRY ${envEntry}`);
    if (exists(envEntry)) return { ...programFromEntry(envEntry, 'env'), searched };
  }
  const envAppDir = resolvePath(String(process.env.AIDASH_APP_DIR ?? '').trim(), base);
  if (envAppDir) {
    searched.push(`AIDASH_APP_DIR ${envAppDir}`);
    const found = matchProgramRoot(envAppDir, 'env');
    if (found) return { ...found, searched };
  }
  if (cwd) {
    const cwdLayout = detectAidashLayout(cwd);
    if (cwdLayout.matched) {
      return { ...cwdLayout, appDir: cwd, source: 'cwd', matched: true, searched };
    }
  }
  if (searchManager) {
    const seen = new Set();
    for (const root of managerProgramRoots()) {
      const key = comparePath(root);
      if (seen.has(key)) continue;
      seen.add(key);
      searched.push(`管理台程序目录 ${root}`);
      const found = matchProgramRoot(root, 'manager');
      if (found) return { ...found, searched };
    }
  }
  if (store) {
    for (const service of store.listServices()) {
      if (service.type !== 'aidash' || !service.aidash) continue;
      const entry = resolvePath(String(service.aidash.serverEntry ?? '').trim(), service.cwd);
      if (entry && exists(entry)) {
        return { ...programFromEntry(entry, `service:${service.name}`), searched };
      }
      const root = resolvePath(String(service.aidash.appDir ?? '').trim(), service.cwd);
      if (root) {
        const found = matchProgramRoot(root, `service:${service.name}`);
        if (found) return { ...found, searched };
      }
    }
  }
  if (explicitEntry) {
    // 用户明确填了路径但当前不存在：保留它，启动时报“入口不存在”比静默换路径更可预期。
    return { ...programFromEntry(explicitEntry, 'explicit'), matched: false, searched };
  }
  return { serverEntry: '', staticDir: '', appDir: explicitAppDir, source: 'missing', key: '', matched: false, searched };
}

function looksLikeRunnerEntry(filePath) {
  return Boolean(filePath) && exists(filePath) && filePath.endsWith('.mjs');
}

export function detectRunnerEntry(cwd, explicit) {
  if (explicit) {
    const resolved = resolvePath(explicit, cwd);
    return { path: resolved, command: process.execPath, args_prefix: [resolved], explicit: true, exists: exists(resolved) };
  }
  const candidates = [];
  if (process.env.AIDASH_RUNNER_BIN) candidates.push(process.env.AIDASH_RUNNER_BIN);
  // 本仓 workspace：管理器与 runner 是兄弟目录。
  candidates.push(path.resolve(PACKAGE_ROOT, '..', '20-aidash-runner', 'bin', 'aidash-runner.mjs'));
  // 部署布局：<cwd>/runner/bin/aidash-runner.mjs
  candidates.push(path.resolve(cwd, 'runner', 'bin', 'aidash-runner.mjs'));
  candidates.push(path.resolve(cwd, '40-build', '20-aidash-runner', 'bin', 'aidash-runner.mjs'));
  try {
    const pkg = requireFromHere.resolve('aidash-runner/package.json');
    candidates.push(path.join(path.dirname(pkg), 'bin', 'aidash-runner.mjs'));
  } catch {
    // 未作为依赖安装时走兄弟目录/PATH。
  }
  for (const candidate of candidates) {
    const resolved = resolvePath(candidate, cwd);
    if (looksLikeRunnerEntry(resolved)) {
      return { path: resolved, command: process.execPath, args_prefix: [resolved], explicit: false, exists: true };
    }
  }
  // 最后回退到 PATH 上的 aidash-runner；命令不存在时 start 会给出明确错误。
  return { path: null, command: 'aidash-runner', args_prefix: [], explicit: false, exists: false };
}

export function sanitizeInstanceId(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .replace(/^[.]+$/, '-');
  return cleaned.slice(0, 80) || 'aidash-runner';
}

/** 旧版本在找不到程序时会猜测 source 布局路径；这组值正是“数据目录被当成部署目录”的来源。 */
function legacyGuessedPaths(cwd) {
  const source = aidashLayoutCandidates(cwd)[1];
  return new Set(
    [source.serverEntry, source.staticDir, source.dbPath, source.backupDir].map((item) => comparePath(item)),
  );
}

export function normalizeAidashSpec(input = {}, { cwd, store } = {}) {
  const layout = detectAidashLayout(cwd);
  // 服务记录自己也承认“工作目录没有匹配到程序布局”，但旧版本仍把猜测路径存了进去。
  // 这类猜测值不是用户配置，重算时当作空，改由管理台提供的程序与数据布局接管。
  const legacyGuess = input.layoutMatched === false && !layout.matched ? legacyGuessedPaths(cwd) : null;
  const resolved = (raw) => {
    const value = resolvePath(String(raw ?? '').trim(), cwd);
    return value && legacyGuess && legacyGuess.has(comparePath(value)) ? '' : value;
  };

  const host = String(input.host ?? '127.0.0.1').trim();
  if (!host) throw new ManagerError('FIELD_INVALID', '监听地址不能为空');
  const port = intInRange(input.port, 8787, { min: 1, max: 65535, label: '端口' });
  const tokenSource = input.tokenSource === 'env' ? 'env' : 'manager';
  const tokenEnv = String(input.tokenEnv ?? TOKEN_ENV_NAME).trim() || TOKEN_ENV_NAME;
  if (!ENV_NAME_PATTERN.test(tokenEnv)) {
    throw new ManagerError('FIELD_INVALID', `令牌环境变量名不合法：${tokenEnv}`);
  }

  const program = findAidashProgram({
    serverEntry: resolved(input.serverEntry),
    appDir: input.appDir,
    cwd,
    store,
  });
  const dataLayout = layout.matched ? layout : aidashDataLayout(cwd);
  const explicitStatic = resolved(input.staticDir);
  const staticDir =
    explicitStatic && exists(explicitStatic)
      ? explicitStatic
      : program.staticDir || explicitStatic || layout.staticDir || path.join(cwd, 'dist', 'web');
  const configMode = input.configMode === 'file' ? 'file' : 'env';
  const configPath = resolvePath(String(input.configPath ?? '').trim() || 'aidash.config.json', cwd);
  const logLevel = ['debug', 'info', 'warn', 'error'].includes(input.logLevel) ? input.logLevel : 'info';
  return {
    host,
    port,
    tokenSource,
    tokenEnv,
    appDir: program.appDir ?? '',
    serverEntry: program.serverEntry,
    programSource: program.source,
    programKey: program.key,
    programMatched: Boolean(program.matched),
    configMode,
    configPath,
    dbPath: resolved(input.dbPath) || dataLayout.dbPath,
    backupDir: resolved(input.backupDir) || dataLayout.backupDir,
    staticDir,
    logLevel,
    env: normalizeEnvMap(input.env),
    layoutKey: layout.key,
    layoutMatched: layout.matched,
  };
}

export function normalizeRunnerSpec(input = {}, { cwd, store, serviceId }) {
  const templateKey = String(input.template ?? 'claude');
  const template = getTemplate(templateKey);
  if (!template) {
    throw new ManagerError(
      'TEMPLATE_UNKNOWN',
      `未知 harness 模板：${templateKey}；可用：${HARNESS_TEMPLATES.map((item) => item.key).join(' / ')}`,
    );
  }
  const defaultHarness = `${templateKey}-${os.hostname().replace(/[^A-Za-z0-9._:-]/g, '-')}`.slice(0, 64);
  const harnessId = String(input.harnessId ?? defaultHarness).trim();
  if (!HARNESS_ID_PATTERN.test(harnessId)) {
    throw new ManagerError(
      'FIELD_INVALID',
      'harness_id 只能包含字母、数字、点、下划线、冒号、连字符（1..64 字符）',
    );
  }
  uniqueHarnessId(store, harnessId, serviceId);

  const rawUrl = String(input.aidashUrl ?? 'http://127.0.0.1:8787/mcp').trim();
  const normalizedUrl = normalizeUrlString(rawUrl);
  if (!normalizedUrl) {
    throw new ManagerError('FIELD_INVALID', `AIDash 地址不是合法 URL：${rawUrl}`);
  }
  const url = new URL(normalizedUrl);
  if (!url.pathname.replace(/\/+$/, '').endsWith('/mcp')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/mcp`;
  }
  url.hash = '';
  url.search = '';

  const configPath = resolvePath(
    String(input.configPath ?? '').trim() || `aidash-runner.${harnessId}.json`,
    cwd,
  );
  // 每个 runner 一份独立 data_dir：registry、日志、会话状态互不覆盖。
  const serviceDir = store.defaultServiceDir(serviceId);
  const dataDir = resolvePath(
    String(input.dataDir ?? '').trim() || path.join(serviceDir, 'runner-data'),
    cwd,
  );
  const logFile = resolvePath(
    String(input.logFile ?? '').trim() || path.join(serviceDir, 'runner.log'),
    cwd,
  );

  const channels = Array.isArray(input.channels)
    ? input.channels.map((item) => String(item).trim()).filter(Boolean)
    : String(input.channels ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

  // 精确通道创建（runner 的 --ensure-channel）：只建通道，不是匹配过滤器。
  // 用户最容易把“通道过滤”当成“创建通道”，所以两者在管理台里都保留，
  // 由 runner 在启动时调 channel.upsert 完成创建/复用。
  const ensureChannel = String(input.ensureChannel ?? '').trim();
  const channelTitle = String(input.channelTitle ?? '').trim();
  if (ensureChannel) {
    if (ensureChannel.length > CHANNEL_KEY_MAX || !CHANNEL_KEY_PATTERN.test(ensureChannel)) {
      throw new ManagerError(
        'FIELD_INVALID',
        `创建/复用通道必须是 1..${CHANNEL_KEY_MAX} 位 ASCII，且不含空白：${ensureChannel}`,
      );
    }
  }
  if (channelTitle) {
    if (!ensureChannel) {
      throw new ManagerError('FIELD_REQUIRED', '通道标题必须配合“创建/复用通道”使用');
    }
    if (channelTitle.length > CHANNEL_TITLE_MAX) {
      throw new ManagerError('FIELD_INVALID', `通道标题不能超过 ${CHANNEL_TITLE_MAX} 个字符`);
    }
  }

  const matchInput = input.match && typeof input.match === 'object' ? input.match : {};
  const match = {
    matchAll: normalizeBool(matchInput.matchAll, true),
    tags: Array.isArray(matchInput.tags)
      ? matchInput.tags.map((item) => String(item).trim()).filter(Boolean)
      : String(matchInput.tags ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
    titlePrefix: String(matchInput.titlePrefix ?? '').trim(),
    channelKey: String(matchInput.channelKey ?? '').trim(),
    priority: Array.isArray(matchInput.priority)
      ? matchInput.priority.filter((item) => ['P0', 'P1', 'P2', 'P3'].includes(item))
      : [],
    kind: Array.isArray(matchInput.kind)
      ? matchInput.kind.filter((item) => ['task', 'suggestion'].includes(item))
      : [],
  };
  if (!match.matchAll) {
    const hasSelector =
      match.tags.length > 0 ||
      Boolean(match.titlePrefix) ||
      Boolean(match.channelKey) ||
      match.priority.length > 0 ||
      match.kind.length > 0;
    if (!hasSelector) {
      throw new ManagerError(
        'MATCH_REQUIRED',
        '未勾选“匹配全部任务”时，至少填写一个匹配条件（标签/标题前缀/通道/优先级/类型）',
      );
    }
  }

  const tokenSource = input.tokenSource === 'env' ? 'env' : 'manager';
  const tokenEnv = String(input.tokenEnv ?? TOKEN_ENV_NAME).trim() || TOKEN_ENV_NAME;
  if (!ENV_NAME_PATTERN.test(tokenEnv)) {
    throw new ManagerError('FIELD_INVALID', `令牌环境变量名不合法：${tokenEnv}`);
  }

  const runnerEntry = input.runnerEntry ? resolvePath(String(input.runnerEntry).trim(), cwd) : null;
  const runCwd = resolvePath(String(input.runCwd ?? '').trim() || cwd, cwd);
  if (!isDirectory(runCwd)) {
    throw new ManagerError('CWD_INVALID', `任务工作目录不存在或不是目录：${runCwd}`);
  }

  // 显式填写的 data_dir 不能与其它 runner 共用；默认路径按服务 id 生成，天然唯一。
  assertRunnerDataDirUnused(store, dataDir, serviceId);

  return {
    template: templateKey,
    aidashUrl: url.toString(),
    harnessId,
    runnerName: String(input.runnerName ?? harnessId).trim() || harnessId,
    configPath,
    dataDir,
    logFile,
    runCwd,
    channels,
    ensureChannel,
    channelTitle,
    match,
    pollSeconds: intInRange(input.pollSeconds, 5, { min: 1, max: 86_400, label: '轮询间隔' }),
    leaseSeconds: intInRange(input.leaseSeconds, 900, { min: 1, max: 86_400, label: '租约时长' }),
    heartbeatSeconds: intInRange(input.heartbeatSeconds, 60, { min: 1, max: 3_600, label: '心跳间隔' }),
    gapSeconds: intInRange(input.gapSeconds, 2, { min: 0, max: 3_600, label: '任务间隔', integer: false }),
    commandTimeoutSeconds: intInRange(input.commandTimeoutSeconds, 1_800, {
      min: 1,
      max: 86_400,
      label: '命令超时',
    }),
    tokenSource,
    tokenEnv,
    runnerEntry,
    env: normalizeEnvMap(input.env),
    capabilities: template.capability ? [template.capability] : [],
  };
}

/**
 * dataDir/logFile 的默认值依赖 service id，因此创建时先分配 id 再做规范化。
 * 返回的 service 是持久化形状；令牌由调用方单独写入 secrets。
 */
export function createService(input, { store }) {
  const type = input?.type;
  if (type !== 'aidash' && type !== 'runner') {
    throw new ManagerError('TYPE_INVALID', '服务类型必须是 aidash 或 runner');
  }
  const name = normalizeServiceName(input.name);
  const cwd = normalizeCwd(input.cwd);
  const id = input.id ?? newServiceId();
  const now = new Date().toISOString();

  if (type === 'aidash') {
    return {
      id,
      type,
      name,
      cwd,
      createdAt: now,
      updatedAt: now,
      aidash: normalizeAidashSpec(input.spec ?? input.aidash ?? {}, { cwd, store }),
      runner: null,
    };
  }
  return {
    id,
    type,
    name,
    cwd,
    createdAt: now,
    updatedAt: now,
    aidash: null,
    runner: normalizeRunnerSpec(input.spec ?? input.runner ?? {}, { cwd, store, serviceId: id }),
  };
}

export function updateService(existing, input, { store }) {
  const type = existing.type;
  const name = input.name === undefined ? existing.name : normalizeServiceName(input.name);
  const cwd = input.cwd === undefined ? existing.cwd : normalizeCwd(input.cwd);
  const next = {
    ...existing,
    name,
    cwd,
    updatedAt: new Date().toISOString(),
  };
  if (type === 'aidash') {
    const partial = input.spec ?? input.aidash;
    // 局部更新常见于“只改端口/令牌来源”；不合并会把没提交的字段悄悄重置成默认值。
    next.aidash = normalizeAidashSpec(partial ? { ...existing.aidash, ...partial } : existing.aidash, {
      cwd,
      store,
    });
  } else {
    const partial = input.spec ?? input.runner;
    const merged = partial
      ? {
          ...existing.runner,
          ...partial,
          match:
            partial.match && typeof partial.match === 'object'
              ? { ...existing.runner.match, ...partial.match }
              : existing.runner.match,
        }
      : existing.runner;
    next.runner = normalizeRunnerSpec(merged, {
      cwd,
      store,
      serviceId: existing.id,
    });
  }
  return next;
}

/** 有效 AIDash 设置：文件模式以配置文件为准，环境模式以服务定义为准。 */
export function effectiveAidashSettings(service) {
  const spec = service.aidash;
  const base = {
    host: spec.host,
    port: spec.port,
    dbPath: spec.dbPath,
    backupDir: spec.backupDir,
    staticDir: spec.staticDir,
    logLevel: spec.logLevel,
    configPath: spec.configPath,
    configMode: spec.configMode,
    source: 'env',
    fileError: null,
  };
  if (spec.configMode !== 'file') return base;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(spec.configPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ...base, source: 'file', fileError: `配置文件不存在：${spec.configPath}` };
    }
    return { ...base, source: 'file', fileError: `配置文件无法解析：${error.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...base, source: 'file', fileError: '配置文件顶层必须是 JSON 对象' };
  }
  const pick = (key, fallback) => {
    const value = raw[key];
    return value === undefined || value === null || value === '' ? fallback : value;
  };
  return {
    host: String(pick('host', base.host)),
    port: Number(pick('port', base.port)),
    dbPath: resolvePath(String(pick('db_path', base.dbPath)), service.cwd),
    backupDir: resolvePath(String(pick('backup_dir', base.backupDir)), service.cwd),
    staticDir: resolvePath(String(pick('static_dir', base.staticDir)), service.cwd),
    logLevel: String(pick('log_level', base.logLevel)),
    configPath: spec.configPath,
    configMode: 'file',
    source: 'file',
    fileError: null,
  };
}

/** 有效 runner 设置：进程实际读的是配置文件，因此优先以文件为准。 */
export function effectiveRunnerSettings(service) {
  const spec = service.runner;
  const base = {
    configPath: spec.configPath,
    harnessId: spec.harnessId,
    instanceId: sanitizeInstanceId(spec.harnessId),
    dataDir: spec.dataDir,
    logFile: spec.logFile,
    aidashUrl: spec.aidashUrl,
    source: 'spec',
    fileError: null,
  };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(spec.configPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ...base, fileError: `配置文件不存在：${spec.configPath}` };
    }
    return { ...base, fileError: `配置文件无法解析：${error.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...base, fileError: '配置文件顶层必须是 JSON 对象' };
  }
  const harnessId = String(raw.harness_id || base.harnessId);
  const valueOr = (value, fallback) => (typeof value === 'string' && value.trim() ? value : fallback);
  return {
    configPath: spec.configPath,
    harnessId,
    instanceId: sanitizeInstanceId(harnessId),
    dataDir: resolvePath(valueOr(raw.data_dir, base.dataDir), path.dirname(spec.configPath)),
    logFile: resolvePath(valueOr(raw.log_file, base.logFile), path.dirname(spec.configPath)),
    aidashUrl: String(valueOr(raw.aidash_url, base.aidashUrl)),
    source: 'file',
    fileError: null,
  };
}

export function aidashUrlOf(settings) {
  // 0.0.0.0 / :: 是监听地址，不是可点击的访问地址；本机访问用回环。
  const host =
    settings.host === '0.0.0.0' ? '127.0.0.1' : settings.host === '::' ? '::1' : settings.host;
  return `http://${hostForUrl(host)}:${settings.port}`;
}

export function healthUrlOf(settings) {
  return `${aidashUrlOf(settings)}${AIDASH_HEALTH_PATH}`;
}

/**
 * 对外视图：不带令牌、不带 secrets 路径。
 * tokenSource == 'manager' 时只暴露 hasToken，前端无法读回明文。
 */
export function publicService(service, { hasToken }) {
  return {
    id: service.id,
    type: service.type,
    name: service.name,
    cwd: service.cwd,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
    aidash: service.aidash
      ? {
          ...service.aidash,
          hasToken,
        }
      : null,
    runner: service.runner
      ? {
          ...service.runner,
          hasToken,
          runnerEntryDetected: detectRunnerEntry(service.cwd, service.runner.runnerEntry),
        }
      : null,
  };
}

export function defaultRunnerPaths(store, serviceId) {
  const dir = store.serviceDir(serviceId);
  return {
    dataDir: path.join(dir, 'runner-data'),
    logFile: path.join(dir, 'runner.log'),
  };
}
