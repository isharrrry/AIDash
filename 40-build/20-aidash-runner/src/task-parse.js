import { BusinessError, TransportError } from './errors.js';
import { asFiniteNumber, asRecord, asString, asStringArray } from './util.js';

/**
 * 服务端返回的是不可信 JSON：字段可能缺失、可能换信封。
 * 解析层只做两件事：收窄成运行循环需要的字段；缺关键 id/token/card_id 时立刻报错。
 * 让 undefined 一路传到状态机会变成很难查的 400/500。
 */

export function parseTask(value, source = 'task') {
  const record = asRecord(value);
  if (!record) throw new TransportError(`${source} 返回格式不符：期望任务对象`);
  const id = asString(record.id);
  if (!id) throw new TransportError(`${source} 返回的任务缺少 id`);
  return {
    id,
    channel_key: asString(record.channel_key) ?? '',
    title: asString(record.title) ?? id,
    status: asString(record.status) ?? 'pending',
    priority: asString(record.priority) ?? 'P2',
    tags: asStringArray(record.tags),
    assignee: asString(record.assignee),
    claim_expires_at: asString(record.claim_expires_at),
    due_at: asString(record.due_at),
    kind: asString(record.kind) ?? 'task',
    parent_id: asString(record.parent_id),
    description_md: typeof record.description_md === 'string' ? record.description_md : null,
    discussion_answer_md:
      typeof record.discussion_answer_md === 'string' ? record.discussion_answer_md : null,
    ancestors: parseAncestors(record.ancestors),
    defer_reason: asString(record.defer_reason) ?? '',
    deferred_until: asString(record.deferred_until),
    created_at: asString(record.created_at),
  };
}

/**
 * 父链上下文（根 → 直接父）。服务端字段同样是不可信 JSON：
 * - ancestors 不是数组时按“没有上下文”处理，不让提示词里出现 `[object Object]`；
 * - 非对象条目直接丢弃，避免把字符串/数字当成祖先渲染；
 * - depth 缺失时按数组顺序倒推（最后一项是直接父=1），服务端正常都会显式给值。
 */
function parseAncestors(value) {
  if (!Array.isArray(value)) return [];
  const total = value.length;
  const parsed = [];
  value.forEach((item, index) => {
    const ancestor = parseAncestor(item, Math.max(1, total - index));
    if (ancestor) parsed.push(ancestor);
  });
  return parsed;
}

/** 单个祖先视图的安全收窄；不是对象就返回 null，由调用方丢弃。 */
export function parseAncestor(value, fallbackDepth = 1) {
  const record = asRecord(value);
  if (!record) return null;
  const id = asString(record.id) ?? '';
  const rawDepth = asFiniteNumber(record.depth);
  const depth = Number.isInteger(rawDepth) && rawDepth > 0 ? rawDepth : fallbackDepth;
  return {
    id,
    title: asString(record.title) ?? id,
    kind: asString(record.kind) ?? 'task',
    // 不用 pending 兜底：祖先缺状态时不能假装它还在排队，unknown 更诚实。
    status: asString(record.status) ?? 'unknown',
    depth,
    description_md: typeof record.description_md === 'string' ? record.description_md : null,
    discussion_answer_md:
      typeof record.discussion_answer_md === 'string' ? record.discussion_answer_md : null,
  };
}

/** task.list 的返回可能是 Page<TaskView>、{tasks:[]}、{data:{items}} 或裸数组。 */
export function parseTaskPage(value) {
  if (Array.isArray(value)) {
    return { items: value.map((item) => parseTask(item, 'task.list')), hasMore: false, total: value.length };
  }
  const record = asRecord(value);
  if (!record) throw new TransportError('task.list 返回格式不符：期望 JSON 对象');
  const nested = asRecord(record.data);
  const list = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.tasks)
      ? record.tasks
      : Array.isArray(nested?.items)
        ? nested.items
        : Array.isArray(nested?.tasks)
          ? nested.tasks
          : [];
  const items = list.map((item) => parseTask(item, 'task.list'));
  const hasMore =
    record.has_more === true ||
    record.hasMore === true ||
    nested?.has_more === true ||
    nested?.hasMore === true;
  const total = typeof record.total === 'number' ? record.total : typeof nested?.total === 'number' ? nested.total : null;
  return { items, hasMore, total };
}

export function parseClaimResult(value) {
  const root = asRecord(value);
  const record = asRecord(root?.data) ?? root;
  if (!record) throw new TransportError('task.claim 返回格式不符：期望 JSON 对象');
  const token = asString(record.claim_token);
  if (!token) {
    throw new BusinessError('INVALID_ARGUMENT', 'task.claim 未返回 claim_token，无法续租或回报');
  }
  const taskRaw = record.task ?? record;
  return {
    task: parseTask(taskRaw, 'task.claim'),
    token,
    lease_expires_at: asString(record.lease_expires_at),
    renewed: record.renewed === true,
  };
}

/** task.create → {task, created}；兼容 data 信封与直接返回 task 的旧实现。 */
export function parseCreatedTask(value) {
  const root = asRecord(value);
  const record = asRecord(root?.data) ?? root;
  if (!record) throw new TransportError('task.create 返回格式不符：期望 JSON 对象');
  const task = parseTask(record.task ?? record, 'task.create');
  return { task, created: record.created === true };
}

/** card.post → card_id；兼容 {card_id}、{id}、{card:{id}} 与 data 信封。 */
export function parseCardId(value) {
  const root = asRecord(value);
  if (!root) throw new BusinessError('INVALID_ARGUMENT', 'card.post 未返回 JSON 对象');
  const record = asRecord(root.data) ?? root;
  const card = asRecord(record.card);
  const id = asString(record.card_id) ?? asString(record.id) ?? asString(card?.id);
  if (!id) throw new BusinessError('INVALID_ARGUMENT', 'card.post 未返回 card_id，无法关联完成证据');
  return id;
}
