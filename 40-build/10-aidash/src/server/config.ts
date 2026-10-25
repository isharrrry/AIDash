import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../shared/errors.js';
import { MINUTE_MS } from '../shared/time.js';
import type { LlmMode } from '../shared/types.js';

/**
 * 配置来源与优先级（**按实际实现写**）：
 *   页面设置（setting 表） > 环境变量 > 配置文件 > 内置默认。
 *
 * 本文件只负责「环境变量 > 配置文件 > 默认值」这一层；页面设置由
 * `SettingsService` 用 `coalesce(persisted, config)` 叠在上面，所以页面改过的键
 * 会盖住同名环境变量——这样用户在设置页改完即时生效，不必重启。
 *
 * 03 §3.7.1 与 05 §3.11 已统一为这个口径。为了让设置页能提示
 * 「页面值覆盖了同名环境变量」，这里额外记下实际出现过的 AIDASH_* 变量名
 * （只记键名，不保存值），供 `SettingsService` 比对。
 */
export interface AppConfig {
  host: string;
  port: number;
  /**
   * 唯一访问凭据；可以是一句短口令，也可以是长随机串。
   * 只驻留内存，比较前做 sha256；绝不写日志、卡片或任何响应。
   */
  token: string;
  tokenLabel: string;
  dbPath: string;
  /** 数据库文件不存在但备份目录有备份时，是否仍允许建空库（默认拒绝）。 */
  allowEmptyDb: boolean;
  kbRoot: string | null;
  kbIndexIntervalMs: number;
  enrichmentEnabled: boolean;
  /**
   * 页面写入的 LLM 密钥存放目录（加密文件 + 主密钥）。
   * 默认在用户目录下，刻意不放数据库/备份目录，避免一次备份把密钥带出去。
   */
  secretDir: string;
  llm: {
    endpoint: string | null;
    model: string | null;
    mode: LlmMode;
    apiKey: string | null;
    timeoutMs: number;
  };
  leaseSeconds: number;
  maxWaitSeconds: number;
  /**
   * MCP 侧 card.ask / card.wait 的等待上限（秒）。
   *
   * 为什么不直接用 maxWaitSeconds：MCP 客户端常在 30~60 秒就判定工具调用超时，
   * 而服务端此时已经把卡片落库——调用方看到“失败”，用户却在网页上看到新卡。
   * 默认 25 秒：在客户端超时前主动返回 pending + card_id，让调用方可以继续做别的。
   */
  mcpWaitCapSeconds: number;
  maxWaitingRequests: number;
  pageSizeMax: number;
  rateLimitPerMinute: number;
  /**
   * 令牌桶容量 = 允许的突发请求数（REQ-FN-028 要求 60）。
   * 与 rateLimitPerMinute 分开：前者是「一口气能打多少」，后者是「长期平均速率」。
   * 固定窗口只有一个数，表达不了这两件事。
   */
  rateLimitBurst: number;
  cardRetentionDays: number;
  logRetentionDays: number;
  auditMinRetentionDays: number;
  backupDir: string;
  /** 迁移前备份的保留天数；只清理本程序命名的备份。 */
  backupRetentionDays: number;
  /** 至少保留的备份份数；最新一份无条件保留。 */
  backupMinKeep: number;
  staticDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  heartbeatIntervalSeconds: number;
  offlineThresholdSeconds: number;
  configSource: string;
  /**
   * 本次启动实际提供的 AIDASH_* 环境变量名（升序，只含键名、不含值）。
   * 设置页据此判断“同名环境变量是否存在”，提示“页面值覆盖了环境变量”。
   */
  aidashEnvKeys: string[];
}

type RawConfig = Record<string, unknown>;

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  dbPath: './40-build/10-aidash/data/aidash.db',
  kbIndexIntervalMs: 5 * MINUTE_MS,
  // 默认开启：没有配置 LLM 时增强会直接 skipped，不会产生请求；
  // 一旦用户把 key/模型配置好，卡片分析与知识库建议就能自动跑起来，
  // 不需要再找一个“启用增强”的隐藏开关。
  enrichmentEnabled: true,
  llmEndpoint: 'https://api.deepseek.com/v1/chat/completions',
  llmModel: 'deepseek-flash',
  llmMode: 'max' as LlmMode,
  llmTimeoutMs: 60_000,
  secretDir: path.join(os.homedir(), '.aidash'),
  leaseSeconds: 900,
  maxWaitSeconds: 300,
  mcpWaitCapSeconds: 25,
  maxWaitingRequests: 100,
  pageSizeMax: 200,
  // REQ-FN-028：默认 300 请求/分钟、突发 60。
  // 5 秒轮询 + Web 操作下仍有余量，同时保留上限防止单进程跑飞把库打满。
  rateLimitPerMinute: 300,
  rateLimitBurst: 60,
  cardRetentionDays: 365,
  logRetentionDays: 30,
  auditMinRetentionDays: 730,
  backupDir: './40-build/10-aidash/backups',
  // 30 天足够覆盖一次升级后的观察期；至少 5 份，避免频繁迁移时把回滚点删光。
  backupRetentionDays: 30,
  backupMinKeep: 5,
  staticDir: './40-build/10-aidash/dist/web',
  logLevel: 'info' as const,
  heartbeatIntervalSeconds: 60,
  offlineThresholdSeconds: 180,
} as const;

/**
 * 配置 Schema 的路径：它是「配置文件里允许出现哪些键」的**唯一事实源**。
 *
 * 为什么不把键清单抄一份到代码里：两份清单一定会漂。现在改 Schema 就同时改了
 * 运行时校验，而 `tests/config-schema.test.ts` 负责盯着 Schema 与 pick() 的对应关系。
 *
 * 为什么相对路径能同时覆盖开发与生产：config.ts 编译后落在 `dist/server/`，
 * 与源码的 `src/server/` 同深度，`../../../00-platform/...` 两边解析到同一个文件。
 */
const CONFIG_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../00-platform/config/schema/aidash-config.schema.json',
);

/**
 * 凭据只认环境变量（页面写入的走 secret-store 的加密文件），配置文件里一旦出现就拒绝启动。
 *
 * 为什么不选「读到了但忽略」：忽略会让人以为自己填的 key 生效了，排查时往
 * LLM 服务商或令牌本身找半天。密钥误提交的代价又远高于一次启动失败，
 * 所以这里大声失败。`[键名, 应改用的环境变量]`。
 */
const FORBIDDEN_FILE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['token', 'AIDASH_TOKEN'],
  ['llm_api_key', 'AIDASH_LLM_API_KEY'],
];

/** 同上，但位于 `llm` 嵌套对象里。 */
const FORBIDDEN_NESTED_KEYS: ReadonlyArray<readonly [string, string, string]> = [
  ['llm', 'api_key', 'AIDASH_LLM_API_KEY'],
];

interface ConfigSchema {
  properties?: Record<string, { properties?: Record<string, unknown> }>;
}

/**
 * 从 Schema 读出允许出现的键。只取键名，不解释 type/minimum ——
 * 值域由下面的 num()/bool()/str()/llmMode() 各自校验，两边不重复也不冲突：
 * Schema 管「有没有这个键」，代码管「这个值合不合法」。
 */
function loadConfigSchemaKeys(): { topLevel: Set<string>; llm: Set<string> } {
  let text: string;
  try {
    text = fs.readFileSync(CONFIG_SCHEMA_PATH, 'utf8');
  } catch {
    // 读不到 Schema 时**不能**退回「不校验」：那正是这次要修的问题
    // （文件在、但没人拿它校验，于是拼错的键静默生效）。
    throw new AppError('INTERNAL', 'CONFIG_SCHEMA_MISSING', { path: CONFIG_SCHEMA_PATH });
  }
  let schema: ConfigSchema;
  try {
    schema = JSON.parse(text) as ConfigSchema;
  } catch {
    throw new AppError('INTERNAL', 'CONFIG_SCHEMA_INVALID', { path: CONFIG_SCHEMA_PATH });
  }
  const properties = schema.properties ?? {};
  return {
    topLevel: new Set(Object.keys(properties)),
    // `llm` 是唯一允许的嵌套对象，它的子键同样走白名单。
    llm: new Set(Object.keys(properties.llm?.properties ?? {})),
  };
}

/**
 * 校验配置文件的结构。只做两件事，顺序有讲究：
 *   1. 先查凭据键 —— 报「token 不能写文件」比报「未知键 token」有用得多；
 *   2. 再查白名单 —— 这就是 Schema 里 additionalProperties=false 的运行时含义。
 */
function assertConfigFileShape(raw: RawConfig, file: string): void {
  const base = path.basename(file);

  for (const [key, envKey] of FORBIDDEN_FILE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new AppError('INTERNAL', 'CONFIG_SECRET_IN_FILE', { file: base, key, use: envKey });
    }
  }
  for (const [parent, key, envKey] of FORBIDDEN_NESTED_KEYS) {
    const nested = raw[parent];
    if (nested !== null && typeof nested === 'object' && Object.prototype.hasOwnProperty.call(nested, key)) {
      throw new AppError('INTERNAL', 'CONFIG_SECRET_IN_FILE', {
        file: base,
        key: `${parent}.${key}`,
        use: envKey,
      });
    }
  }

  const allowed = loadConfigSchemaKeys();
  const unknown = Object.keys(raw)
    .filter((key) => !allowed.topLevel.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new AppError('INTERNAL', 'CONFIG_UNKNOWN_KEYS', { file: base, keys: unknown });
  }

  const nested = raw.llm;
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    const unknownNested = Object.keys(nested)
      .filter((key) => !allowed.llm.has(key))
      .sort()
      .map((key) => `llm.${key}`);
    if (unknownNested.length > 0) {
      throw new AppError('INTERNAL', 'CONFIG_UNKNOWN_KEYS', { file: base, keys: unknownNested });
    }
  }
}

function readConfigFile(file: string): RawConfig {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new AppError('INTERNAL', 'CONFIG_FILE_INVALID', { file: path.basename(file) });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('INTERNAL', 'CONFIG_FILE_INVALID', { file: path.basename(file) });
  }
  assertConfigFileShape(parsed as RawConfig, file);
  return parsed as RawConfig;
}

function num(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new AppError('INTERNAL', 'CONFIG_INVALID', { key: name, expected: `${min}..${max}` });
  }
  return n;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true' || String(value) === '1';
}

function str(value: unknown, fallback: string | null = null): string | null {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

/**
 * 是否只监听本机。
 *
 * `0.0.0.0` / `::` 都是“所有网卡”，不是回环；`localhost` 在本机解析上
 * 通常等价 127.0.0.1，但显式写出来时按本机处理。用于启动告警，不参与绑定。
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === 'localhost'
  );
}

function llmMode(value: unknown, fallback: LlmMode): LlmMode {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'fast' || value === 'standard' || value === 'max') return value;
  throw new AppError('INTERNAL', 'CONFIG_INVALID', {
    key: 'llm_mode',
    expected: 'fast|standard|max',
  });
}

/**
 * 启动时调用；缺令牌或配置非法必须立刻失败（REQ-FN-059）。
 * 默认只监听 127.0.0.1：跨机访问是部署方的显式选择。
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { configFile?: string } = {},
): AppConfig {
  const configFile = options.configFile ?? env.AIDASH_CONFIG ?? './aidash.config.json';
  const file = readConfigFile(configFile);
  const pick = (envKey: string, fileKey: string): unknown =>
    env[envKey] !== undefined ? env[envKey] : file[fileKey];

  // 统一凭据：AIDASH_TOKEN 可以是一句短口令；AIDASH_PASSPHRASE 只作弃用别名，
  // 仅为旧配置保留。两者都只认环境变量，没有文件回退。
  const rawToken = str(env.AIDASH_TOKEN);
  const legacyPassphrase = str(env.AIDASH_PASSPHRASE)?.trim() || null;
  if (!rawToken && legacyPassphrase !== null && legacyPassphrase.length < 8) {
    throw new AppError('INTERNAL', 'CONFIG_INVALID', {
      key: 'AIDASH_PASSPHRASE',
      expected: 'at least 8 characters when used as the only credential',
    });
  }
  const token = rawToken ?? legacyPassphrase;
  if (!token) {
    throw new AppError('INTERNAL', 'CONFIG_MISSING', { keys: ['AIDASH_TOKEN'] });
  }

  // 只保留“确实提供了非空值”的键：空字符串在 num()/str()/bool() 里等同未设置，
  // 若把它算作来源，设置页会提示一个根本不会生效的环境变量。
  const aidashEnvKeys = Object.keys(env)
    .filter((key) => key.startsWith('AIDASH_') && env[key] !== undefined && env[key] !== '')
    .sort();

  const llm = (file.llm ?? {}) as RawConfig;
  const staticDir = str(pick('AIDASH_STATIC_DIR', 'static_dir'), DEFAULTS.staticDir)!;

  return {
    host: str(pick('AIDASH_HOST', 'host'), DEFAULTS.host)!,
    port: num(pick('AIDASH_PORT', 'port'), DEFAULTS.port, 1, 65535, 'port'),
    token,
    tokenLabel: str(pick('AIDASH_TOKEN_LABEL', 'token_label'), 'owner')!,
    dbPath: str(pick('AIDASH_DB_PATH', 'db_path'), DEFAULTS.dbPath)!,
    // 默认 false：库文件不见但旁边有备份，十有八九是路径漂移，
    // 此时建空库会让人误以为“数据全没了”。显式设 true 才允许。
    allowEmptyDb: bool(pick('AIDASH_ALLOW_EMPTY_DB', 'allow_empty_db'), false),
    kbRoot: str(pick('AIDASH_KB_ROOT', 'kb_root')),
    kbIndexIntervalMs:
      num(
        pick('AIDASH_KB_INDEX_INTERVAL', 'kb_index_interval_seconds'),
        300,
        30,
        86_400,
        'kb_index_interval_seconds',
      ) * 1000,
    enrichmentEnabled: bool(
      pick('AIDASH_ENRICHMENT_ENABLED', 'enrichment_enabled'),
      DEFAULTS.enrichmentEnabled,
    ),
    secretDir: path.resolve(
      str(pick('AIDASH_SECRET_DIR', 'secret_dir'), DEFAULTS.secretDir)!,
    ),
    llm: {
      endpoint:
        str(pick('AIDASH_LLM_ENDPOINT', 'llm_endpoint')) ??
        str(llm.endpoint) ??
        DEFAULTS.llmEndpoint,
      model: str(pick('AIDASH_LLM_MODEL', 'llm_model')) ?? str(llm.model) ?? DEFAULTS.llmModel,
      mode: llmMode(pick('AIDASH_LLM_MODE', 'llm_mode') ?? llm.mode, DEFAULTS.llmMode),
      // 密钥只认环境变量（页面写入的走 secret-store 的加密文件，优先级更高）。
      // 配置文件里的 llm_api_key / llm.api_key 会被 assertConfigFileShape 直接拒绝。
      apiKey: str(env.AIDASH_LLM_API_KEY),
      // 兼容旧环境变量名 AIDASH_ENRICHMENT_TIMEOUT_MS：老部署不需要改脚本；
      // 新变量名更准确，因为它现在同时约束测试连接与记忆归纳。
      timeoutMs: num(
        pick('AIDASH_LLM_TIMEOUT_MS', 'llm_timeout_ms') ??
          pick('AIDASH_ENRICHMENT_TIMEOUT_MS', 'enrichment_timeout_ms'),
        DEFAULTS.llmTimeoutMs,
        5_000,
        300_000,
        'llm_timeout_ms',
      ),
    },
    leaseSeconds: num(pick('AIDASH_LEASE_SECONDS', 'lease_seconds'), 900, 60, 3600, 'lease_seconds'),
    maxWaitSeconds: num(
      pick('AIDASH_MAX_WAIT_SECONDS', 'max_wait_seconds'),
      300,
      0,
      300,
      'max_wait_seconds',
    ),
    mcpWaitCapSeconds: num(
      pick('AIDASH_MCP_WAIT_CAP_SECONDS', 'mcp_wait_cap_seconds'),
      DEFAULTS.mcpWaitCapSeconds,
      1,
      300,
      'mcp_wait_cap_seconds',
    ),
    maxWaitingRequests: num(
      pick('AIDASH_MAX_WAITING_REQUESTS', 'max_waiting_requests'),
      DEFAULTS.maxWaitingRequests,
      1,
      10_000,
      'max_waiting_requests',
    ),
    pageSizeMax: num(pick('AIDASH_PAGE_SIZE_MAX', 'page_size_max'), 200, 20, 500, 'page_size_max'),
    rateLimitPerMinute: num(
      pick('AIDASH_RATE_LIMIT_PER_MINUTE', 'rate_limit_per_minute'),
      DEFAULTS.rateLimitPerMinute,
      1,
      100_000,
      'rate_limit_per_minute',
    ),
    rateLimitBurst: num(
      pick('AIDASH_RATE_LIMIT_BURST', 'rate_limit_burst'),
      DEFAULTS.rateLimitBurst,
      1,
      10_000,
      'rate_limit_burst',
    ),
    cardRetentionDays: num(
      pick('AIDASH_CARD_RETENTION_DAYS', 'card_retention_days'),
      DEFAULTS.cardRetentionDays,
      30,
      3650,
      'card_retention_days',
    ),
    logRetentionDays: num(
      pick('AIDASH_LOG_RETENTION_DAYS', 'log_retention_days'),
      DEFAULTS.logRetentionDays,
      7,
      365,
      'log_retention_days',
    ),
    auditMinRetentionDays: num(
      pick('AIDASH_AUDIT_MIN_RETENTION_DAYS', 'audit_min_retention_days'),
      DEFAULTS.auditMinRetentionDays,
      30,
      3650,
      'audit_min_retention_days',
    ),
    backupDir: str(pick('AIDASH_BACKUP_DIR', 'backup_dir'), DEFAULTS.backupDir)!,
    backupRetentionDays: num(
      pick('AIDASH_BACKUP_RETENTION_DAYS', 'backup_retention_days'),
      DEFAULTS.backupRetentionDays,
      1,
      3650,
      'backup_retention_days',
    ),
    backupMinKeep: num(
      pick('AIDASH_BACKUP_MIN_KEEP', 'backup_min_keep'),
      DEFAULTS.backupMinKeep,
      1,
      1000,
      'backup_min_keep',
    ),
    staticDir,
    logLevel: (str(pick('AIDASH_LOG_LEVEL', 'log_level'), DEFAULTS.logLevel) as AppConfig['logLevel']) ?? 'info',
    heartbeatIntervalSeconds: num(
      pick('AIDASH_HEARTBEAT_INTERVAL_SECONDS', 'heartbeat_interval_seconds'),
      DEFAULTS.heartbeatIntervalSeconds,
      10,
      3600,
      'heartbeat_interval_seconds',
    ),
    offlineThresholdSeconds: num(
      pick('AIDASH_OFFLINE_THRESHOLD_SECONDS', 'offline_threshold_seconds'),
      DEFAULTS.offlineThresholdSeconds,
      30,
      10_800,
      'offline_threshold_seconds',
    ),
    configSource: fs.existsSync(configFile) ? configFile : 'env+defaults',
    aidashEnvKeys,
  };
}
