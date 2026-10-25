/**
 * REST 端点封装：页面只调用这里的函数，不直接拼 URL。
 * 端点以任务给定的 `/api/*` 契约为准；返回类型复用 shared/types 的视图类型。
 */
import { apiRequest, buildQuery } from './client';
import { TASK_TREE_MAX_DEPTH } from '../lib/task-tree';
import type {
  AssistantMemoryView,
  AuditRow,
  BatchAnswerResult,
  CardAnswer,
  CardStatus,
  CardType,
  CardView,
  ChannelView,
  Digest,
  HandoffState,
  HarnessView,
  HealthView,
  KbDocView,
  KbSearchHit,
  KbSearchResult,
  LlmTestView,
  MemoryDigestRunView,
  MemoryProjectView,
  Page,
  Priority,
  ProjectMemoryView,
  ReportKind,
  ReportPeriod,
  ReportRunView,
  ReportStatusView,
  ReportView,
  SettingsPatchView,
  SettingsView,
  TaskClaimResponse,
  TaskView,
  TreeNode,
} from '../types';

export interface CardQuery {
  channel_key?: string;
  /** 主对话筛选：按通道 key 的 project 段过滤，空值表示跨主对话查看。 */
  project?: string;
  types?: CardType[];
  statuses?: CardStatus[];
  priorities?: Priority[];
  include_archived?: boolean;
  /**
   * 是否要完整正文（默认 false）。
   *
   * 列表默认只给 preview_md，避免一页 200 张卡把全文拉回来；
   * 任务信息流等确实要显示全文的调用方显式传 true。
   */
  include_body?: boolean;
  q?: string;
  /** 只看某个任务下的卡：任务详情信息流用。 */
  task_id?: string;
  /** 只看没有任务归属的历史卡：决策台“历史遗留”入口用。 */
  unassigned?: boolean;
  page?: number;
  page_size?: number;
  sort?: 'priority' | 'due_at' | 'created_at' | 'updated_at';
  order?: 'asc' | 'desc';
}

function noEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

export function getDigest(channelKey?: string): Promise<Digest> {
  return apiRequest<Digest>(`/digest${buildQuery({ channel_key: noEmpty(channelKey) })}`);
}

export interface ChannelQuery {
  include_archived?: boolean;
  q?: string;
  page?: number;
  page_size?: number;
}

export function listChannels(query: ChannelQuery = {}): Promise<Page<ChannelView>> {
  return apiRequest<Page<ChannelView>>(
    `/channels${buildQuery({
      include_archived: query.include_archived ? true : undefined,
      q: query.q,
      page: query.page,
      page_size: query.page_size,
    })}`,
  );
}

export function archiveChannel(
  channelId: string,
  status: 'active' | 'archived',
): Promise<ChannelView> {
  return apiRequest<ChannelView>(`/channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    body: { status },
  });
}

/**
 * 修改通道别名。
 *
 * 传 null 表示清空别名，展示层会回退到 topic/title/channel_key；
 * 与归档共用 PATCH，但只带 alias 时不会改变通道状态。
 */
export function updateChannelAlias(
  channelId: string,
  alias: string | null,
): Promise<ChannelView> {
  return apiRequest<ChannelView>(`/channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    body: { alias },
  });
}

export function listCards(query: CardQuery = {}): Promise<Page<CardView>> {
  return apiRequest<Page<CardView>>(
    `/cards${buildQuery({
      channel_key: noEmpty(query.channel_key),
      project: noEmpty(query.project),
      type: query.types,
      status: query.statuses,
      priority: query.priorities,
      include_archived: query.include_archived ? true : undefined,
      include_body: query.include_body ? true : undefined,
      q: noEmpty(query.q),
      task_id: noEmpty(query.task_id),
      unassigned: query.unassigned ? true : undefined,
      page: query.page,
      page_size: query.page_size,
      sort: query.sort,
      order: query.order,
    })}`,
  );
}

export function getCard(cardId: string): Promise<CardView> {
  return apiRequest<CardView>(`/cards/${encodeURIComponent(cardId)}`);
}

export function updateCard(
  cardId: string,
  patch: { title?: string; priority?: Priority },
): Promise<CardView> {
  return apiRequest<CardView>(`/cards/${encodeURIComponent(cardId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function answerCard(cardId: string, answer: CardAnswer): Promise<CardView> {
  return apiRequest<CardView>(`/cards/${encodeURIComponent(cardId)}/answer`, {
    method: 'POST',
    body: {
      option_id: answer.option_id ?? null,
      free_text: answer.free_text ?? null,
      note: answer.note ?? null,
    },
  });
}

/**
 * 标记已读。
 *
 * 服务端只记第一次读的时间，重复调用返回同一个 read_at；
 * 所以滚动观察器重复触发、断网重试都不会把“读过的时刻”改来改去。
 */
export function markCardRead(cardId: string): Promise<CardView> {
  return apiRequest<CardView>(`/cards/${encodeURIComponent(cardId)}/read`, { method: 'POST' });
}

export function dismissCard(cardId: string): Promise<CardView> {
  return apiRequest<CardView>(`/cards/${encodeURIComponent(cardId)}/dismiss`, { method: 'POST' });
}

export function archiveCard(cardId: string): Promise<CardView> {
  return apiRequest<CardView>(`/cards/${encodeURIComponent(cardId)}/archive`, { method: 'POST' });
}

export function setHandoffState(cardId: string, state: HandoffState): Promise<CardView> {
  return apiRequest<CardView>(`/cards/${encodeURIComponent(cardId)}/handoff`, {
    method: 'POST',
    body: { state },
  });
}

export interface BatchAnswerItem {
  card_id: string;
  answer: CardAnswer;
}

export function batchAnswer(items: BatchAnswerItem[]): Promise<BatchAnswerResult> {
  return apiRequest<BatchAnswerResult>('/cards/batch-answer', {
    method: 'POST',
    body: { items },
  });
}

export interface TaskCreateBody {
  channel_key: string;
  title: string;
  description_md?: string | null;
  parent_id?: string | null;
  /** 单值分类；留空表示未分类。 */
  category?: string | null;
  priority?: Priority;
  assignee?: string | null;
  tags?: string[];
  due_at?: string | null;
  submit?: boolean;
}

export interface TaskCreateResult {
  task: TaskView;
  created: boolean;
}

/** 服务端把新任务包在 `{task, created}` 里，而不是直接返回 TaskView。 */
export function createTask(body: TaskCreateBody): Promise<TaskCreateResult> {
  return apiRequest<TaskCreateResult>('/tasks', { method: 'POST', body });
}

export function getTask(taskId: string): Promise<TaskView> {
  return apiRequest<TaskView>(`/tasks/${encodeURIComponent(taskId)}`);
}

export interface TaskUpdateBody {
  event?: string;
  claim_token?: string;
  patch?: {
    title?: string;
    description_md?: string | null;
    /** null/空串表示清空分类。 */
    category?: string | null;
    priority?: Priority;
    assignee?: string | null;
    tags?: string[];
    due_at?: string | null;
  };
  reason?: string;
  /** defer 专用：计划恢复时间（ISO 8601）；省略/null 表示只暂缓未定期限。 */
  deferred_until?: string | null;
  evidence_card_ids?: string[];
}

export function updateTask(taskId: string, body: TaskUpdateBody): Promise<TaskView> {
  return apiRequest<TaskView>(`/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body,
  });
}

export function claimTask(
  taskId: string,
  harnessId: string,
  leaseSeconds?: number,
): Promise<TaskClaimResponse> {
  return apiRequest<TaskClaimResponse>(`/tasks/${encodeURIComponent(taskId)}/claim`, {
    method: 'POST',
    body: { harness_id: harnessId, ...(leaseSeconds ? { lease_seconds: leaseSeconds } : {}) },
  });
}

export function releaseTask(
  taskId: string,
  claimToken: string,
  reason?: string,
): Promise<TaskView> {
  return apiRequest<TaskView>(`/tasks/${encodeURIComponent(taskId)}/release`, {
    method: 'POST',
    body: { claim_token: claimToken, reason: reason ?? 'released' },
  });
}

/**
 * 确认一条已结束任务的“结束通知”。
 *
 * 单独走 POST 而不是 updateTask：已读是查看回执，不属于任务字段编辑。
 * 服务端幂等，重复调用不会刷新第一次的已读时间。
 */
export function ackEndNotice(taskId: string): Promise<TaskView> {
  return apiRequest<TaskView>(`/tasks/${encodeURIComponent(taskId)}/ack-end-notice`, {
    method: 'POST',
  });
}

export function moveTask(taskId: string, newParentId: string | null): Promise<TaskView> {
  return apiRequest<TaskView>(`/tasks/${encodeURIComponent(taskId)}/move`, {
    method: 'POST',
    body: { new_parent_id: newParentId },
  });
}

export interface TaskCopyResult {
  /** 复制出的子树根节点，不是整棵子树的数组。 */
  task: TaskView;
  copied: number;
}

export function copyTask(taskId: string, newParentId: string | null): Promise<TaskCopyResult> {
  return apiRequest<TaskCopyResult>(`/tasks/${encodeURIComponent(taskId)}/copy`, {
    method: 'POST',
    body: { new_parent_id: newParentId },
  });
}

/** depth 默认值与 TaskBoard 共用同一常量，避免两处各写一个数字后悄悄漂移。 */
export function getTaskTree(
  channelKey: string,
  depth = TASK_TREE_MAX_DEPTH,
): Promise<TreeNode[]> {
  return apiRequest<TreeNode[]>(
    `/tasks/tree${buildQuery({ channel_key: channelKey, depth })}`,
  );
}

/**
 * 主通道记忆。
 *
 * expected_version 是服务端乐观锁：Web 保存时带页面加载到的版本，
 * 若 agent 刚好在期间追加了记忆，服务端返回 MEMORY_VERSION_CONFLICT，
 * 页面保留用户草稿并提示合并，而不是静默覆盖 agent 写的内容。
 */
export function getProjectMemory(project: string): Promise<ProjectMemoryView> {
  return apiRequest<ProjectMemoryView>(`/memory${buildQuery({ project })}`);
}

/**
 * 记忆 Tab 的主对话列表。
 *
 * 返回里同时包含“有记忆”和“有通道但还没写记忆”的项目；
 * 前端不许拿 `has_memory=false` 当成“项目不存在”。
 */
export function listMemoryProjects(): Promise<MemoryProjectView[]> {
  return apiRequest<MemoryProjectView[]>('/memory/projects');
}

export function updateProjectMemory(
  project: string,
  contentMd: string,
  expectedVersion: number,
): Promise<ProjectMemoryView> {
  return apiRequest<ProjectMemoryView>('/memory', {
    method: 'PUT',
    body: { project, content_md: contentMd, expected_version: expectedVersion },
  });
}

/**
 * AIDash 自己的记忆（全局一篇）。
 *
 * 与主对话记忆分开的端点：没有 project 参数，也不走 MCP。
 * 它只影响 AIDash 内部 AI 能力的提示词，不会被外部 agent 读取。
 */
export function getAssistantMemory(): Promise<AssistantMemoryView> {
  return apiRequest<AssistantMemoryView>('/memory/assistant');
}

export function updateAssistantMemory(
  contentMd: string,
  expectedVersion: number,
): Promise<AssistantMemoryView> {
  return apiRequest<AssistantMemoryView>('/memory/assistant', {
    method: 'PUT',
    body: { content_md: contentMd, expected_version: expectedVersion },
  });
}

/**
 * 立即归纳一次项目记忆。
 *
 * 服务端同一项目并发时返回 409 DIGEST_RUNNING；页面禁用按钮只是 UX，
 * 真正的互斥在服务层（两次归纳各自追加一组相近的行，去重挡不住）。
 */
export function runMemoryDigest(project: string): Promise<MemoryDigestRunView> {
  return apiRequest<MemoryDigestRunView>('/memory/digest', {
    method: 'POST',
    body: { project },
  });
}

export function listMemoryDigestRuns(
  project: string,
  limit = 10,
): Promise<MemoryDigestRunView[]> {
  return apiRequest<MemoryDigestRunView[]>(
    `/memory/digest/runs${buildQuery({ project, limit })}`,
  );
}

export interface KbSearchQuery {
  q: string;
  type?: string;
  tags?: string;
  top_k?: number;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toKbHit(value: unknown): KbSearchHit {
  const row = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    path: asString(row.path),
    type: asString(row.type, 'doc'),
    title: asNullableString(row.title),
    description: asNullableString(row.description),
    tags: asStringArray(row.tags),
    doc_date: asNullableString(row.doc_date),
    snippet: asString(row.snippet),
    score: typeof row.score === 'number' ? row.score : 0,
  };
}

/** KB 搜索；服务端固定返回 `{items,total,degraded?,degraded_reason?}`。 */
export async function searchKb(query: KbSearchQuery): Promise<KbSearchResult> {
  const data = await apiRequest<unknown>(
    `/kb/search${buildQuery({
      q: query.q,
      type: query.type,
      tags: query.tags,
      top_k: query.top_k,
    })}`,
  );
  const row = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const raw = Array.isArray(row.items) ? row.items : [];
  const items = raw.map(toKbHit);
  return {
    items,
    total: typeof row.total === 'number' ? row.total : items.length,
    // 服务端只在降级时回 true。
    degraded: row.degraded === true,
    degraded_reason: typeof row.degraded_reason === 'string' ? row.degraded_reason : undefined,
  };
}

export function getKbDoc(path: string): Promise<KbDocView> {
  return apiRequest<KbDocView>(`/kb/doc${buildQuery({ path })}`);
}

export function reindexKb(): Promise<unknown> {
  return apiRequest<unknown>('/kb/reindex', { method: 'POST' });
}

export interface ReportQuery {
  period?: ReportPeriod;
  kind?: ReportKind;
  page?: number;
  page_size?: number;
}

export function listReports(query: ReportQuery = {}): Promise<Page<ReportView>> {
  return apiRequest<Page<ReportView>>(
    `/reports${buildQuery({
      period: query.period,
      kind: query.kind,
      page: query.page,
      page_size: query.page_size,
    })}`,
  );
}

/**
 * 删除一条汇报。
 *
 * 服务端对“生成中”的汇报返回 409 REPORT_GENERATING；页面按钮会先禁用，
 * 但这里仍按普通错误上抛，避免并发/旧页面状态绕过 UI 校验。
 */
export function deleteReport(reportId: string): Promise<{ deleted: true }> {
  return apiRequest<{ deleted: true }>(`/reports/${encodeURIComponent(reportId)}`, {
    method: 'DELETE',
  });
}

/** 首屏同时拿“当前批次 + 最近批次”，页面不用发两次请求再自己对齐。 */
export function getReportStatus(): Promise<ReportStatusView> {
  return apiRequest<ReportStatusView>('/reports/status');
}

/**
 * 触发六种周期汇报的依次生成。
 *
 * 服务端立即返回 202 + 批次视图，生成在后台继续；页面靠轮询 /status 看进度，
 * 不能在这里 await 到生成结束——六个周期耗时会超过 HTTP 超时。
 */
export function startReportUpdate(): Promise<ReportRunView> {
  return apiRequest<ReportRunView>('/reports/update', { method: 'POST' });
}

export interface TopicReportBody {
  topic?: string | null;
  instruction: string;
  /** 传入则更新这些已有汇报；不传则新建一条专题汇报。 */
  target_report_ids?: string[];
}

export function startTopicReport(body: TopicReportBody): Promise<ReportRunView> {
  return apiRequest<ReportRunView>('/reports/topic', { method: 'POST', body });
}

export function cancelReportRun(runId: string): Promise<ReportRunView> {
  return apiRequest<ReportRunView>(`/reports/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

export function getSettings(): Promise<SettingsView> {
  return apiRequest<SettingsView>('/settings');
}

/**
 * 保存运行时可改设置。
 *
 * 服务端只接受白名单字段，并把 `kb_root` 校验为已存在目录；
 * 前端不做“看起来合法”的预判，避免两套规则漂移。
 */
export function updateSettings(patch: SettingsPatchView): Promise<SettingsView> {
  return apiRequest<SettingsView>('/settings', { method: 'PATCH', body: patch });
}

/**
 * 测试 LLM 连接。
 *
 * 走的是正式调用同一条路径（LlmService.chat），所以它通过基本等价于
 * “保存后增强/归纳能跑”；失败时服务端只回错误码，不回上游响应体。
 */
export function testLlm(): Promise<LlmTestView> {
  return apiRequest<LlmTestView>('/llm/test', { method: 'POST' });
}

export interface AuditQuery {
  since?: string;
  until?: string;
  action?: string;
  object_type?: string;
  object_id?: string;
  result?: string;
  page?: number;
}

export function listAudit(query: AuditQuery = {}): Promise<Page<AuditRow>> {
  return apiRequest<Page<AuditRow>>(
    `/audit${buildQuery({
      since: query.since,
      until: query.until,
      action: noEmpty(query.action),
      object_type: noEmpty(query.object_type),
      object_id: noEmpty(query.object_id),
      result: query.result,
      page: query.page,
    })}`,
  );
}

/** /api/harnesses 可能是数组，也可能被分页包一层；这里统一成数组。 */
export async function listHarnesses(): Promise<HarnessView[]> {
  const data = await apiRequest<unknown>('/harnesses');
  if (Array.isArray(data)) return data as HarnessView[];
  if (typeof data === 'object' && data !== null) {
    const row = data as Record<string, unknown>;
    if (Array.isArray(row.items)) return row.items as HarnessView[];
    if (Array.isArray(row.harnesses)) return row.harnesses as HarnessView[];
  }
  return [];
}

export function getHealth(): Promise<HealthView> {
  return apiRequest<HealthView>('/health');
}
