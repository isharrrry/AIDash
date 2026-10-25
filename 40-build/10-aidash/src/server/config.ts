import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../shared/errors.js';
import { MINUTE_MS } from '../shared/time.js';
import type { LlmMode } from '../shared/types.js';

/**
 * 配置优先级（03 §3.7.1）：环境变量 > 配置文件 > setting 表 > 内置默认。
 * 本文件只负责前两层；setting 表由 config-service 在启动时合并。
 */
export interface AppConfig {
  host: string;
  port: number;
  token: string; // 只驻留内存；比较前做 sha256
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
  cardRetentionDays: number;
  logRetentionDays: number;
  auditMinRetentionDays: number;
  backupDir: string;
  staticDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  heartbeatIntervalSeconds: number;
  offlineThresholdSeconds: number;
  configSource: string;
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
  rateLimitPerMinute: 600,
  cardRetentionDays: 365,
  logRetentionDays: 30,
  auditMinRetentionDays: 730,
  backupDir: './40-build/10-aidash/backups',
  staticDir: './40-build/10-aidash/dist/web',
  logLevel: 'info' as const,
  heartbeatIntervalSeconds: 60,
  offlineThresholdSeconds: 180,
} as const;

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

  const token = str(pick('AIDASH_TOKEN', 'token'));
  if (!token) {
    throw new AppError('INTERNAL', 'CONFIG_MISSING', { keys: ['AIDASH_TOKEN'] });
  }

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
      apiKey: str(pick('AIDASH_LLM_API_KEY', 'llm_api_key')) ?? str(llm.api_key),
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
  };
}
