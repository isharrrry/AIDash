/**
 * Web 侧类型边界。
 *
 * 视图类型复用 src/shared/types.ts（服务端与 MCP 用的是同一套形状），
 * 只在这里补充“REST 传输层”额外需要的类型：设置、健康、KB 搜索命中、审计行等。
 * 这样避免前端再抄一份 CardView，字段漂移时能被 tsc 直接发现。
 */
import type {
  AssistantMemoryView,
  BatchAnswerResult,
  CardAnswer,
  CardOption,
  CardStatus,
  CardType,
  CardView,
  ChannelView,
  Digest,
  EnrichmentStatus,
  HandoffState,
  KbRef,
  Link,
  LlmMode,
  MemoryDigestRunView,
  MemoryProjectView,
  MemorySearchResult,
  Page,
  Priority,
  ProjectMemoryView,
  PromptKey,
  RecommendationRole,
  ReportKind,
  ReportPeriod,
  ReportRunStatus,
  ReportRunView,
  ReportStatus,
  ReportStatusView,
  ReportView,
  StatusResult,
  SuggestionItem,
  TaskKind,
  TaskStatus,
  TaskView,
  TreeNode,
} from '../../shared/types';

export type {
  AssistantMemoryView,
  BatchAnswerResult,
  CardAnswer,
  CardOption,
  CardStatus,
  CardType,
  CardView,
  ChannelView,
  Digest,
  EnrichmentStatus,
  HandoffState,
  KbRef,
  Link,
  LlmMode,
  MemoryDigestRunView,
  MemoryProjectView,
  MemorySearchResult,
  Page,
  Priority,
  ProjectMemoryView,
  PromptKey,
  RecommendationRole,
  ReportKind,
  ReportPeriod,
  ReportRunStatus,
  ReportRunView,
  ReportStatus,
  ReportStatusView,
  ReportView,
  StatusResult,
  SuggestionItem,
  TaskKind,
  TaskStatus,
  TaskView,
  TreeNode,
};

/** 健康检查返回结构；服务端只返回这一种形状。 */
export interface HealthDbView {
  path: string;
  size_bytes: number;
}

export interface HealthAuditChain {
  ok: boolean;
  broken_at?: number;
  /** 本次真实校验发生的时刻；缓存命中时仍是上一次校验的时间。 */
  checked_at: string;
}

export interface HealthView {
  status: string;
  db: HealthDbView;
  audit_chain: HealthAuditChain;
  waiting_requests: number;
  uptime_seconds: number;
  version: string;
}

/** KB 搜索命中（后端 FTS 返回 snippet，内含 <mark> 标记）。 */
export interface KbSearchHit {
  path: string;
  type: string;
  title: string | null;
  description: string | null;
  tags: string[];
  doc_date: string | null;
  snippet: string;
  score: number;
}

export interface KbSearchResult {
  items: KbSearchHit[];
  total: number;
  /**
   * 服务端 FTS 查询失败、退回 LIKE 子串搜索时为 true。
   * 结果仍然可用，但只会命中标题/描述，正文与分词命中会缺失 —— UI 必须提示。
   */
  degraded?: boolean;
  /** 固定错误码（当前只有 FTS_QUERY_FAILED），不透传底层 SQL 细节。 */
  degraded_reason?: string;
}

/** 知识库文档详情：字段与 `KbService.get()` 的返回一一对应。 */
export interface KbDocView {
  path: string;
  title: string | null;
  type: string;
  tags: string[];
  description: string | null;
  doc_date: string | null;
  body: string;
  hash: string;
}

/** 单条能力提示词：system 是当前生效值，default_system 用于“恢复默认”。 */
export interface PromptView {
  key: PromptKey;
  label: string;
  description: string;
  system: string;
  default_system: string;
}

/** POST /api/llm/test 的返回；reply 已在服务端截断，页面只做展示。 */
export interface LlmTestView {
  ok: true;
  latency_ms: number;
  endpoint: string;
  model: string;
  mode: LlmMode;
  reply: string;
}

/** 设置页视图，字段与 server/services/settings-service.ts 的 SettingsView 对齐。 */
export interface SettingsView {
  enrichment: {
    enabled: boolean;
    timeout_ms: number;
    llm: {
      endpoint: string | null;
      model: string | null;
      mode: LlmMode;
      has_api_key: boolean;
      configured: boolean;
      key_source: 'file' | 'env' | null;
      key_path: string;
      /**
       * 页面密钥的读取状态：ok / not_configured / unreadable。
       * unreadable 表示「配过但解不开」，必须显式告警 —— 否则用户会以为密钥还在，
       * 实际增强分析已经回退到环境变量或直接停用。
       */
      key_state: 'ok' | 'not_configured' | 'unreadable';
      /** 仅在 key_state=unreadable 时出现：master_key_missing / master_key_invalid / decrypt_failed / secrets_file_invalid。 */
      key_error?: string;
    };
    kb_suggestion_ready: boolean;
  };
  prompts: PromptView[];
  memory_digest: { enabled: boolean; interval_hours: number; window_days: number };
  kb: { root: string | null; configured: boolean };
  retention: { card_days: number; audit_days: number; log_days: number };
  limits: {
    max_wait_seconds: number;
    lease_seconds: number;
    page_size_max: number;
    rate_limit_per_minute: number;
    /** 令牌桶容量 = 允许的突发请求数（REQ-FN-028：60）。 */
    rate_limit_burst: number;
  };
  server: {
    host: string;
    port: number;
    db_path: string;
    config_source: string;
    schema_version: number;
  };
  token: { label: string; configured: boolean };
  /**
   * 页面保存值覆盖了同名环境变量的键；只用于提示“改环境变量不会生效”，
   * 不改变任何生效值。服务端未返回时按空数组处理（兼容旧后端）。
   */
  env_overrides: Array<{ key: string; env_var: string }>;
}

/**
 * 运行时可改的设置项（PATCH /api/settings）。
 *
 * llm_api_key 可以在这里出现，但服务端只把它写进加密文件、不并入设置 JSON，
 * 也不在任何响应里回显；这是“改 key 就能用”与“密钥不进库”的折中。
 */
export interface SettingsPatchView {
  enrichment_enabled?: boolean;
  enrichment_timeout_ms?: number;
  llm_endpoint?: string | null;
  llm_model?: string | null;
  llm_mode?: LlmMode;
  llm_api_key?: string | null;
  prompts?: Partial<Record<PromptKey, string>>;
  memory_digest_enabled?: boolean;
  memory_digest_interval_hours?: number;
  memory_digest_window_days?: number;
  kb_root?: string | null;
  card_retention_days?: number;
  audit_min_retention_days?: number;
  log_retention_days?: number;
}

export interface HarnessView {
  harness_id: string;
  name: string;
  host: string | null;
  capabilities?: string[];
  capabilities_json?: string | null;
  status: string;
  last_seen: string | number;
  registered_at: string | number;
  updated_at?: string | number;
}

/** 审计行：ts 在服务端可能是毫秒数，也可能是 ISO 字符串，前端统一格式化。 */
export interface AuditRow {
  id: number;
  ts: number | string;
  actor_label: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  result: string;
  request_id: string | null;
  detail_json: string | null;
  prev_hash?: string | null;
  hash?: string;
}

export interface TaskClaimResponse {
  task: TaskView;
  claim_token: string;
  lease_expires_at?: string;
  renewed?: boolean;
}
