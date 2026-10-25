/**
 * 领域类型：与 05 的表结构一一对应。
 * 存储层字段保持 snake_case；对外视图在服务层组装（见下方 View 类型）。
 */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type CardType = 'info' | 'handoff' | 'question' | 'suggestion' | 'status' | 'artifact';
export type CardStatus = 'open' | 'answered' | 'dismissed' | 'expired' | 'archived';
export type TaskStatus =
  | 'draft'
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';
/**
 * 任务类型。
 *
 * `suggestion` 表示“agent 提出、等用户批准后才执行”的建议：
 * 创建后停在 draft，用户在任务树里能看到并决定是否推进，不需要额外发通知卡。
 */
export type TaskKind = 'task' | 'suggestion';
export type HarnessStatus = 'online' | 'offline' | 'disabled';
export type ChannelStatus = 'active' | 'archived';
export type EnrichmentStatus = 'pending' | 'running' | 'done' | 'unavailable' | 'skipped';
export type HandoffState = 'draft' | 'copied' | 'sent' | 'ack';
export type StatusResult = 'success' | 'failed' | 'blocked' | 'partial';

export interface Channel {
  id: string;
  channel_key: string;
  title: string | null;
  /**
   * 给人看的一句话别名，优先于 topic/title 展示。
   *
   * 与 title/topic 分离：channel_key 是筛选与深链的唯一标识，别名只是展示层标签，
   * agent 可以中途改它而不影响历史链接。空值表示回退到 topic/title/channel_key。
   */
  alias: string | null;
  harness_id: string | null;
  project: string | null;
  topic: string | null;
  /**
   * 该对话对应的工作路径（绝对路径优先）。
   *
   * 为什么放在通道而不是任务：一个通道通常对应一个仓库/工作目录，
   * 用户在 Web 上先确认“这条对话在改哪份代码”，再看卡和任务。
   * 允许为空，兼容旧通道；新通道应由 harness 在 channel.upsert 时登记。
   */
  workdir: string | null;
  status: ChannelStatus;
  /**
   * 最近一次 MCP 调用触及本通道的时间（毫秒）。
   *
   * 只由 MCP 入口写，REST/Web 操作不写：它回答的是“agent 还连着吗”，
   * 不是“用户刚改过什么”。null = 从未观测到 MCP 活动（历史通道）。
   */
  last_mcp_at: number | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface Card {
  id: string;
  channel_id: string;
  type: CardType;
  status: CardStatus;
  priority: Priority;
  title: string | null;
  body_md: string | null;
  /** 决策卡四段背景之一：议题背景（为什么现在要谈这件事）。 */
  background_md: string | null;
  /** 决策卡四段背景之二：达到目的或结果（做完之后世界变成什么样）。 */
  goal_md: string | null;
  /** 决策卡四段背景之三：调查参考（资源/止损/风险必须先调查再写）。 */
  research_md: string | null;
  /** 决策卡四段背景之四：决策项描述（这次究竟在选什么）。 */
  decision_md: string | null;
  message_md: string | null;
  summary: string | null;
  detail_md: string | null;
  severity: 'info' | 'warn' | 'critical' | null;
  recipient: string | null;
  channel_kind: 'email' | 'wechat' | 'other' | null;
  reason: string | null;
  handoff_state: HandoffState | null;
  options_json: string | null;
  allow_free_text: 0 | 1;
  default_action: string | null;
  due_at: number | null;
  answer_json: string | null;
  answered_at: number | null;
  artifact_url: string | null;
  artifact_kind: string | null;
  links_json: string | null;
  result: StatusResult | null;
  suggestions_json: string | null;
  kb_refs_json: string | null;
  confidence: number | null;
  blocking: 0 | 1;
  task_id: string | null;
  enrichment_status: EnrichmentStatus;
  enrichment_json: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface Task {
  id: string;
  channel_id: string;
  parent_id: string | null;
  path: string;
  title: string;
  description_md: string | null;
  /** 任务类型：普通任务 / 建议（待用户批准）。 */
  kind: TaskKind;
  /**
   * 任务分类（用户视角的“这一类活是什么”，如功能/缺陷/维护/调研）。
   *
   * 与 tags 的区别：分类是单值、稳定的归属，任务树按列展示；
   * tags 是多个、可随时增删的横切标记。空值表示未分类，不强制历史任务补填。
   */
  category: string | null;
  status: TaskStatus;
  priority: Priority;
  assignee: string | null;
  tags_json: string | null;
  due_at: number | null;
  claimed_by: string | null;
  claim_token: string | null;
  claim_expires_at: number | null;
  /** 状态时间线；由 task-service 在状态事件里写入，迁移 002 已从 task_event 回填历史。 */
  claimed_at: number | null;
  started_at: number | null;
  blocked_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  cancelled_at: number | null;
  blocked_reason: string | null;
  fail_reason: string | null;
  /** 取消原因。非正常结束也必须有原由，否则用户在任务树里无法判断“为什么没做”。 */
  cancel_reason: string | null;
  /**
   * 结束通知已读时间。
   *
   * 任务进入终态时清空，表示“结束这件事还没有被用户看到”；用户点任务行后写入时间。
   * 与 card_read 一样存服务端：换浏览器/清缓存后提醒不应复活，跨设备也应一致。
   */
  end_notice_read_at: number | null;
  /**
   * 暂缓/排期原因。
   *
   * 非空表示“这件活已知、但当前明确不做”，例如上一轮会话结束时留下的待认领任务。
   * 它不改变 status：pending 仍是 pending，避免伪造“已认领/已阻塞”；
   * 认领时会自动清空，表示重新开始处理。
   */
  defer_reason: string | null;
  /** 最近一次标记暂缓的时间。 */
  deferred_at: number | null;
  /** 计划恢复时间；null 表示只暂缓、未定期限。 */
  deferred_until: number | null;
  /**
   * 隐患说明。
   *
   * 非空表示任务“带着已知风险推进/完成”，例如“没做全量回归，只覆盖主流程”。
   * 与 defer 相反：隐患必须能在 done 上长期保留，认领和终态都不能清空它，
   * 否则复盘时找不到当时冒过什么险。
   */
  risk_note: string | null;
  /** 最近一次标记隐患的时间。 */
  risk_flagged_at: number | null;
  /** 隐患解除时间；null 表示仍未解除。解除不删除 note，历史判断仍可复盘。 */
  risk_resolved_at: number | null;
  /**
   * 解除隐患时的复盘结论（可选）。
   *
   * 例如“风险未发生，当时的取舍正确”。与 risk_note 分列存放：
   * note 是决策当时的欠账，resolution 是事后验证，两者都要留给复盘。
   * 重新标记隐患时清空——新一轮风险需要新的结论。
   */
  risk_resolution: string | null;
  evidence_json: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface Harness {
  harness_id: string;
  name: string;
  host: string | null;
  capabilities_json: string | null;
  status: HarnessStatus;
  last_seen: number;
  registered_at: number;
  updated_at: number;
}

export interface Artifact {
  id: string;
  card_id: string;
  kind: 'commit' | 'file' | 'log' | 'report' | 'url' | 'other';
  url: string;
  summary: string | null;
  size_bytes: number | null;
  created_at: number;
}

export interface KbDoc {
  id: number;
  path: string;
  type: string;
  title: string | null;
  description: string | null;
  tags_json: string | null;
  doc_date: string | null;
  hash: string;
  indexed_at: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor_label: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  result: 'ok' | 'denied' | 'error';
  request_id: string | null;
  detail_json: string | null;
  prev_hash: string | null;
  hash: string;
}

/** 服务层统一使用的分页结果。 */
export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
}

/** 调用上下文：单令牌系统里 isOwner 默认 true，保留字段是为了守卫语义可读。 */
export interface Ctx {
  actorLabel: string;
  requestId: string;
  isOwner: boolean;
}

/**
 * 决策项的角色。
 *
 * primary = 推荐主选项，backup = 推荐备选项；其余选项为普通项。
 * 用独立枚举而不是复用 recommendation：后者历史上既可能是布尔也可能是理由字符串，
 * 混在一起会让“推荐”既表示角色又表示原因，Web 无法稳定渲染主/备徽标。
 */
export type RecommendationRole = 'primary' | 'backup';

export interface CardOption {
  id: string;
  label: string;
  description?: string | null;
  /** 优点（Markdown）。新卡必填；旧卡允许为空，UI 降级展示。 */
  pros_md?: string | null;
  /** 缺点/代价（Markdown）。新卡必填；没有明显缺点也应写明“无明显缺点”。 */
  cons_md?: string | null;
  /** 主推荐/备选推荐；一张问题卡必须恰好各一个。 */
  recommendation_role?: RecommendationRole | null;
  /** 兼容旧数据：推荐理由或布尔标记。新卡请用 recommendation_role + pros/cons。 */
  recommendation?: string | boolean | null;
}

export interface CardAnswer {
  option_id?: string | null;
  free_text?: string | null;
  note?: string | null;
  answered_by?: string | null;
  answered_at?: string | null;
}

export interface SuggestionItem {
  text: string;
  rationale?: string | null;
  confidence?: number | null;
}

export interface KbRef {
  path: string;
  title?: string | null;
  excerpt?: string | null;
}

export interface Link {
  label: string;
  url: string;
}

export interface CardView {
  id: string;
  channel_id: string;
  channel_key: string;
  type: CardType;
  status: CardStatus;
  priority: Priority;
  title: string | null;
  body_md: string | null;
  background_md: string | null;
  goal_md: string | null;
  research_md: string | null;
  decision_md: string | null;
  message_md: string | null;
  /**
   * 列表预览正文：服务端从 body_md / background_md / goal_md 取第一个非空，
   * 截断到约 240 字符，保留 Markdown 原文。
   *
   * 列表默认把上述重字段置 null（避免一页 200 张卡把全文带回来），
   * 展示层只读这个字段；需要全文的调用方显式传 include_body=true，
   * 或走单卡详情。详情响应同样会带这个字段，方便前端复用排版。
   */
  preview_md: string | null;
  summary: string | null;
  detail_md: string | null;
  severity: 'info' | 'warn' | 'critical' | null;
  recipient: string | null;
  channel_kind: 'email' | 'wechat' | 'other' | null;
  reason: string | null;
  handoff_state: HandoffState | null;
  options: CardOption[];
  allow_free_text: boolean;
  default_action: string | null;
  due_at: string | null;
  answer: CardAnswer | null;
  answered_at: string | null;
  url: string | null;
  kind: string | null;
  size_bytes: number | null;
  result: StatusResult | null;
  suggestions: SuggestionItem[];
  kb_refs: KbRef[];
  links: Link[];
  blocking: boolean;
  task_id: string | null;
  /**
   * 已读时间；null 表示未读。
   *
   * 已读存在服务端（card_read 表），不是浏览器 localStorage：
   * 换浏览器/清缓存后红点不应复活，也不应因为另一台设备读过就丢红点。
   * 只记录“第一次读到”的时间，重复滚动不会刷新它。
   */
  read_at: string | null;
  enrichment: EnrichmentView;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface EnrichmentView {
  status: EnrichmentStatus;
  analysis_md?: string | null;
  suggestions?: SuggestionItem[];
  kb_refs?: KbRef[];
  confidence?: number | null;
  model?: string | null;
  has_kb_basis?: boolean;
  reason?: string | null;
}

export interface TaskView {
  id: string;
  channel_id: string;
  channel_key: string;
  parent_id: string | null;
  path: string;
  title: string;
  description_md: string | null;
  /** 任务类型：普通任务 / 建议（待用户批准）。 */
  kind: TaskKind;
  /** 任务分类（单值归属）；null 表示未分类。 */
  category: string | null;
  status: TaskStatus;
  priority: Priority;
  assignee: string | null;
  tags: string[];
  due_at: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  /**
   * 状态时间线。除了 created/updated 之外，其余字段只在对应事件发生后才有值。
   *
   * 为什么不在 Web 端从 task_event 现算：任务树一次要渲染几百个节点，
   * 每个节点再查一次事件会产生 N+1；这里由服务端在同一行上维护，列表接口一次取回。
   */
  claimed_at: string | null;
  started_at: string | null;
  blocked_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  blocked_reason: string | null;
  fail_reason: string | null;
  cancel_reason: string | null;
  /** 结束通知已读时间；null 且任务已结束表示还有一条未确认的结束提醒。 */
  end_notice_read_at: string | null;
  /**
   * 是否还有未确认的结束通知。
   *
   * 由服务端派生而不是让 Web 自己拼 `status in (...) && read_at == null`：
   * 服务端与 MCP 共用同一套判定，避免两边对“什么叫已结束”理解不一致。
   */
  end_notice_pending: boolean;
  /** 暂缓/排期原因；空表示正常排队。 */
  defer_reason: string | null;
  deferred_at: string | null;
  deferred_until: string | null;
  /** 隐患说明；空表示没有已知遗留风险。 */
  risk_note: string | null;
  risk_flagged_at: string | null;
  /** 隐患解除时间；null 且 risk_note 非空表示风险仍未处理。 */
  risk_resolved_at: string | null;
  /** 解除隐患时的复盘结论（可选）；重新标记时清空。 */
  risk_resolution: string | null;
  evidence_ids: string[];
  /**
   * 该任务下未读信息卡数量（不含已归档卡）。
   *
   * 由服务端在同一轮查询里算出，而不是 Web 逐节点请求：
   * 任务树一次几十到上千个节点，前端逐个查会产生 N+1。
   * 已读后 Web 先在本地把数字减到 0，再等下一次树刷新与服务端对齐。
   */
  unread_count: number;
  created_at: string;
  updated_at: string;
}

export interface TreeNode extends TaskView {
  children: TreeNode[];
}

export interface ChannelView {
  id: string;
  channel_key: string;
  title: string | null;
  /** 展示用别名；Web 默认优先显示它，空值回退到 topic/title/channel_key。 */
  alias: string | null;
  name: string | null;
  project: string | null;
  topic: string | null;
  workdir: string | null;
  status: ChannelStatus;
  card_count: number;
  /** 通道内全部任务数（含终态），用于通道卡片显示“有多少活”。 */
  task_count: number;
  /** 未结束任务数（pending/claimed/in_progress/blocked），用于提醒“还有多少没干完”。 */
  open_task_count: number;
  /** 最近一次 MCP 活动时间；null 表示从未观测到。 */
  last_mcp_at: string | null;
  /**
   * 是否有 agent 在线：last_mcp_at 在离线阈值内。
   *
   * 由服务端按 `AIDASH_OFFLINE_THRESHOLD_SECONDS` 计算，避免 Web 和 MCP
   * 各用一套阈值。未结束任务再多也不会让它为 true。
   */
  agent_online: boolean;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AskAnswerResult {
  status: 'answered';
  card_id: string;
  answer: CardAnswer;
}

export interface AskPendingResult {
  status: 'pending';
  card_id: string;
  poll_after_ms: number;
  expires_at: string | null;
}

export type AskResult = AskAnswerResult | AskPendingResult;

export interface BatchAnswerItemResult {
  card_id: string;
  ok: boolean;
  error?: { code: string; message: string };
}

export interface BatchAnswerResult {
  results: BatchAnswerItemResult[];
  success_count: number;
  failure_count: number;
}

/**
 * 主通道记忆的存储行。
 *
 * 一行对应一个 project（AGENTS §3.4 的“主对话”）。整篇 Markdown 是唯一真相：
 * 追加/搜索都在读写时按行切分，不做行表，避免“文档改了、行 ID 对不上”。
 */
export interface ProjectMemory {
  project: string;
  content_md: string;
  version: number;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * AIDash 自己的记忆（单行表 assistant_memory）。
 *
 * 与 ProjectMemory 的区别：没有 project 维度。它记录的是“AIDash 在做 AI 能力时
 * 反复用得上的经验”——哪些汇报口径被用户认可、哪些坑反复出现——不是某个项目的约束。
 */
export interface AssistantMemory {
  content_md: string;
  version: number;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

/** 对外的 AIDash 记忆视图；尚未创建时 exists=false、version=0，而不是 404。 */
export interface AssistantMemoryView {
  content_md: string;
  version: number;
  exists: boolean;
  line_count: number;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 对外的记忆视图；尚未创建时 exists=false、version=0，而不是 404。 */
export interface ProjectMemoryView {
  project: string;
  content_md: string;
  version: number;
  exists: boolean;
  line_count: number;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * 记忆 Tab 的一行：一个主通道（project）及其记忆概况。
 *
 * 来源不只有 project_memory 表：通道已经建好、但 agent 还没写过记忆的 project
 * 也要出现在列表里，否则用户会以为“没有记忆”而不是“还没写”。
 */
export interface MemoryProjectView {
  project: string;
  /**
   * 展示用别名：取该项目下“活跃优先、最近更新”的通道别名。
   * 主对话本身没有别名字段，别名始终来自通道；没有通道别名时为 null。
   */
  alias: string | null;
  /** 0 表示尚未创建记忆行；写入后从 1 开始。 */
  version: number;
  has_memory: boolean;
  line_count: number;
  updated_at: string | null;
  /** 该项目下全部通道数（含归档），用于解释“这份记忆被哪些对话共用”。 */
  channel_count: number;
  active_channel_count: number;
}

/** 按 key 搜索命中一行；line_no 是 1 基行号，方便用户回到编辑器定位。 */
export interface MemoryLineMatch {
  line_no: number;
  line: string;
}

export interface MemorySearchResult {
  project: string;
  query: string;
  version: number;
  total: number;
  /** 命中可能很多，只返回前 limit 行；truncated 告诉调用方“还有”。 */
  truncated: boolean;
  matches: MemoryLineMatch[];
}

/**
 * LLM 推理档位。
 *
 * 不把厂商私有参数（如 reasoning_effort）硬编码进请求体：
 * 不同 OpenAI 兼容网关对未知字段的容忍度不一样，宁可只用通用参数，
 * 再按档位调整输出预算与温度。max 表示“给足输出预算”，不是厂商开关。
 */
export type LlmMode = 'fast' | 'standard' | 'max';

/**
 * 五类能力提示词；每一项都能在设置页单独编辑并恢复默认。
 *
 * `assistant_memory` 对应“AIDash 自己的记忆”的学习提示词：汇报生成完成后，
 * 由它从汇报正文里提炼值得长期保留的经验。
 */
export type PromptKey =
  | 'card_analysis'
  | 'kb_suggestion'
  | 'memory_digest'
  | 'report'
  | 'assistant_memory';

export type MemoryDigestResult = 'ok' | 'empty' | 'unavailable' | 'failed';

/**
 * 汇报类型。
 *
 * `period` 是按自然期限自动更新的六种周期汇报；`topic` 是用户写一段话后
 * 按该要求新建或更新某一条汇报（专题）。两者共用一条生成批次，避免同时打模型。
 */
export type ReportKind = 'period' | 'topic';

/** 周期：日/周/月/季/半年/年；专题用 `topic` 占位，便于列表筛选。 */
export type ReportPeriod = 'day' | 'week' | 'month' | 'quarter' | 'half' | 'year' | 'topic';

export type ReportStatus = 'generating' | 'ready' | 'failed' | 'cancelled';
export type ReportRunStatus = 'running' | 'done' | 'cancelled' | 'failed';

export interface ReportView {
  id: string;
  kind: ReportKind;
  period: ReportPeriod;
  /** 自然周期键；专题汇报用生成日期。 */
  period_key: string;
  title: string;
  content_md: string | null;
  status: ReportStatus;
  run_id: string | null;
  error_message: string | null;
  source_count: number;
  instruction_md: string | null;
  model: string | null;
  mode: LlmMode | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportRunView {
  id: string;
  kind: ReportKind;
  status: ReportRunStatus;
  current_period: ReportPeriod | null;
  total: number;
  completed: number;
  cancel_requested: boolean;
  error_message: string | null;
  target_report_id: string | null;
  instruction_md: string | null;
  started_at: string;
  finished_at: string | null;
}

/** 汇报页首屏：当前批次 + 最近批次，避免页面自己拼两次请求。 */
export interface ReportStatusView {
  running: ReportRunView | null;
  runs: ReportRunView[];
}

/** 一次自动/手动记忆归纳的结果，页面按项目展示历史。 */
export interface MemoryDigestRunView {
  id: string;
  project: string;
  trigger: 'manual' | 'schedule';
  window_start: string;
  window_end: string;
  source_count: number;
  appended: number;
  skipped_duplicates: number;
  result: MemoryDigestResult;
  /** 只放收敛后的错误码/短句，不放上游响应体。 */
  error_message: string | null;
  lines: string[];
  created_at: string;
}

export interface Digest {
  generated_at: string;
  pending_decisions: number;
  p0_cards: CardView[];
  p1_cards: CardView[];
  recent_status: CardView[];
  recent_suggestions: CardView[];
  channels_active: number;
}
