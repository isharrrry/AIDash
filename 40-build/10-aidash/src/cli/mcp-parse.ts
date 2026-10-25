import { BusinessError, TransportError } from './errors.js';

/**
 * MCP 响应解析与类型守卫。
 *
 * 边界原则：服务端返回的是“不可信 JSON”，字段可能缺失或换名。
 * 解析层只做两件事：
 * 1. 把 snake_case 响应收敛成 CLI 需要的窄类型；
 * 2. 缺关键字段（任务 id、claim_token、card_id）时立刻报错，
 *    绝不让 undefined 一路传到状态机或卡片请求里（那会变成很难查的 400）。
 */

export interface TaskItem {
  id: string;
  channel_key: string;
  title: string;
  status: string;
  priority: string;
  tags: string[];
  assignee: string | null;
  claim_expires_at: string | null;
}

export interface TaskPage {
  items: TaskItem[];
  hasMore: boolean;
  total: number | null;
}

export interface ClaimResult {
  task: TaskItem;
  token: string;
}

export interface DigestSummary {
  pending_decisions: number;
  p0_cards: number;
  p1_cards: number;
  channels_active: number;
  generated_at: string | null;
}

export function parseTaskItem(value: unknown, source = 'task'): TaskItem {
  const record = requireRecord(value, source);
  const id = asString(record.id);
  if (!id) throw new TransportError(`${source} 返回的任务缺少 id`);
  return {
    id,
    channel_key: asString(record.channel_key) ?? '',
    title: asString(record.title) ?? id,
    status: asString(record.status) ?? 'pending',
    priority: asString(record.priority) ?? 'P2',
    tags: parseTags(record),
    assignee: asString(record.assignee),
    claim_expires_at: asString(record.claim_expires_at),
  };
}

/** task.list 的返回可能是 Page<TaskView>、{tasks:[]} 或裸数组，统一兼容。 */
export function parseTaskPage(value: unknown): TaskPage {
  if (Array.isArray(value)) {
    return {
      items: value.map((item) => parseTaskItem(item, 'task.list')),
      hasMore: false,
      total: value.length,
    };
  }
  const record = requireRecord(value, 'task.list');
  const nested = isRecord(record.data) ? record.data : null;
  const list: unknown[] = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.tasks)
      ? record.tasks
      : nested && Array.isArray(nested.items)
        ? nested.items
        : nested && Array.isArray(nested.tasks)
          ? nested.tasks
          : [];
  const items = list.map((item) => parseTaskItem(item, 'task.list'));
  const hasMore =
    record.has_more === true ||
    record.hasMore === true ||
    nested?.has_more === true ||
    nested?.hasMore === true;
  const total = asNumber(record.total) ?? (nested ? asNumber(nested.total) : null);
  return { items, hasMore, total };
}

/** task.claim → { task, claim_token }；续租返回同一 token。 */
export function parseClaimResult(value: unknown): ClaimResult {
  const root = requireRecord(value, 'task.claim');
  const record = isRecord(root.data) ? root.data : root;
  const token = asString(record.claim_token);
  if (!token) {
    throw new BusinessError('INVALID_ARGUMENT', 'task.claim 未返回 claim_token，无法续租或回报');
  }
  return { task: parseTaskItem(record.task ?? record, 'task.claim'), token };
}

/** card.post → { card_id }（也兼容 {id} 与 {card:{id}}）。 */
export function parseCardId(value: unknown): string {
  const root = asRecord(value);
  if (!root) throw new BusinessError('INVALID_ARGUMENT', 'card.post 未返回 JSON 对象');
  const record = isRecord(root.data) ? root.data : root;
  const card = isRecord(record.card) ? record.card : null;
  const id = asString(record.card_id) ?? asString(record.id) ?? (card ? asString(card.id) : null);
  if (!id) {
    throw new BusinessError('INVALID_ARGUMENT', 'card.post 未返回 card_id，无法关联完成证据');
  }
  return id;
}

export function parseDigest(value: unknown): DigestSummary {
  const root = asRecord(value) ?? {};
  // 兼容三种信封：裸对象、{digest:{...}}、REST 风格 {data:{...}}。
  // 摘要只用于展示，字段缺失时按 0 处理，不像任务那样把缺字段当传输错误。
  const record = asRecord(root.digest) ?? asRecord(root.data) ?? root;
  return {
    pending_decisions: asNumber(record.pending_decisions) ?? 0,
    p0_cards: countOrLength(record.p0_cards),
    p1_cards: countOrLength(record.p1_cards),
    channels_active: asNumber(record.channels_active) ?? 0,
    generated_at: asString(record.generated_at),
  };
}

// ---------------------------------------------------------------------------
// 基础类型守卫：避免 any，同时让响应解析在边界处失败。
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function requireRecord(value: unknown, source: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new TransportError(`${source} 返回格式不符：期望 JSON 对象`);
  return record;
}

function countOrLength(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return asNumber(value) ?? 0;
}

function parseTags(record: Record<string, unknown>): string[] {
  if (Array.isArray(record.tags)) return asStringArray(record.tags);
  const raw = asString(record.tags_json);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return asStringArray(parsed);
  } catch {
    return [];
  }
}
