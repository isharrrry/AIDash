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

/**
 * 健康检查返回结构。
 *
 * 服务端当前返回 `{status, version, uptime_seconds, db:{path,size_bytes},
 * audit_chain:{ok,broken_at?}, waiting_requests}`；设计文档里还出现过
 * 字符串 db/kb 与 queue_backlog 等扁平字段。这里把两种形状都收进来，
 * 页面再按类型收窄展示，避免把对象直接交给 React 渲染而崩溃。
 */
export interface HealthDbView {
  path?: string;
  size_bytes?: number;
  [key: string]: unknown;
}

export interface HealthAuditChain {
  ok: boolean;
  broken_at?: number;
  [key: string]: unknown;
}

export interface HealthView {
  ok?: boolean;
  status?: string;
  db?: string | HealthDbView;
  kb?: string;
  audit_chain?: boolean | HealthAuditChain;
  waiting_requests?: number;
  schema_version?: number | string;
  queue_backlog?: number;
  pending_cards?: number;
  enrichment_failures?: number;
  uptime_seconds?: number;
  version?: string;
  [key: string]: unknown;
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
  kbStatus?: string;
}

/** 知识库文档详情：服务端可能返回 content_md（契约）或 body（服务层）。 */
export interface KbDocView {
  path: string;
  title: string | null;
  type: string;
  tags: string[];
  description?: string | null;
  doc_date?: string | null;
  content_md?: string;
  body?: string;
  frontmatter?: unknown;
  hash?: string;
}

export interface KbStatsView {
  docs: number;
  types: Array<{ type: string; count: number }>;
  last_indexed_at: number | string | null;
  configured?: boolean;
  root?: string | null;
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
  };
  server: {
    host: string;
    port: number;
    db_path: string;
    config_source: string;
    schema_version: number;
  };
  token: { label: string; configured: boolean };
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
