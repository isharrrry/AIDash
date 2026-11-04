/**
 * 事项页的纯函数：周期窗口、任务事件、汇总与树形重建。
 *
 * 单独放在 lib 里而不是页面组件内：
 *  - 周期边界算错一天，整列汇报都会错位，必须能单独测；
 *  - 事项页要同时用“通道属性”和“任务事件”两套数据，混在 JSX 里会很难读。
 *
 * 周期口径与服务端 `report-period.ts` 保持一致（自然日/ISO 周/自然月等），
 * 但这里支持“往前第 N 期”，因为时间轴要从最新一期向左/向右生成多列。
 */
import type {
  ChannelMeta,
  ChannelView,
  ItemStage,
  Priority,
  ReportPeriod,
  TaskStatus,
  TaskView,
} from '../types';

export type MatrixPeriod = Exclude<ReportPeriod, 'topic'>;

export interface PeriodRange {
  period: MatrixPeriod;
  /** 自然周期键，与服务端 ReportView.period_key 同口径。 */
  key: string;
  /** 中文周期名：日报/周报/… */
  label: string;
  /** 表头短标签：11/03、10/27–11/02、2026-11、2026 Q4。 */
  shortLabel: string;
  /** 悬停完整说明：周报 · 2026-W45（10/27–11/02）。 */
  title: string;
  start: number;
  end: number;
}

export const PERIOD_OPTIONS: Array<{ value: MatrixPeriod; label: string; name: string }> = [
  { value: 'day', label: '日', name: '按日' },
  { value: 'week', label: '周', name: '按周' },
  { value: 'month', label: '月', name: '按月' },
  { value: 'quarter', label: '季', name: '按季' },
  { value: 'half', label: '半年', name: '按半年' },
  { value: 'year', label: '年', name: '按年' },
];

const PERIOD_LABELS: Record<MatrixPeriod, string> = {
  day: '日报',
  week: '周报',
  month: '月报',
  quarter: '季度报',
  half: '半年报',
  year: '年报',
};

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时间的 YYYY-MM-DD；不能用 toISOString，否则东八区晚上会跳到第二天。 */
function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ISO 周序号：该周周四所在的“第几周”，与 service 的 isoWeekNumber 同实现。 */
function isoWeekNumber(thursday: Date): number {
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const firstOffset = (firstThursday.getDay() + 6) % 7;
  const firstMonday = new Date(
    firstThursday.getFullYear(),
    firstThursday.getMonth(),
    firstThursday.getDate() - firstOffset,
  );
  return Math.round((thursday.getTime() - firstMonday.getTime()) / (7 * 86_400_000)) + 1;
}

function endDateOfRange(period: MatrixPeriod, start: Date, end: number): Date {
  if (period === 'week') {
    // 周列展示到周日；end 是下周一 00:00，减一天才是用户看到的最后一天。
    return new Date(end - 86_400_000);
  }
  void start;
  return new Date(end - 1);
}

function shortLabelOf(period: MatrixPeriod, start: Date, endExclusive: number): string {
  const end = endDateOfRange(period, start, endExclusive);
  switch (period) {
    case 'day':
      return `${start.getMonth() + 1}/${start.getDate()} ${WEEKDAY[start.getDay()]}`;
    case 'week':
      return `${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}`;
    case 'month':
      return `${start.getFullYear()}-${pad(start.getMonth() + 1)}`;
    case 'quarter':
      return `${start.getFullYear()} Q${Math.floor(start.getMonth() / 3) + 1}`;
    case 'half':
      return `${start.getFullYear()} H${Math.floor(start.getMonth() / 6) + 1}`;
    case 'year':
      return `${start.getFullYear()}`;
  }
}

/**
 * 取“当前周期往前第 offset 期”的范围。
 *
 * offset=0 是当前周期（本周/本月…），offset=1 是上一期。
 * 全部用 `new Date(y, m, d)` 构造本地时间：服务端按服务器本地时区分期，
 * 前端若用 UTC 会在晚上 8 点后把“今天”算成明天，时间轴和日报对不上。
 */
export function periodRangeAt(
  period: MatrixPeriod,
  offset: number,
  now: number = Date.now(),
): PeriodRange {
  const date = new Date(now);
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  let start: Date;
  let end: Date;
  let key: string;

  switch (period) {
    case 'day': {
      start = new Date(y, m, d - offset);
      end = new Date(y, m, d - offset + 1);
      key = localDateKey(start);
      break;
    }
    case 'week': {
      // 周一为一周起点；getDay 周日=0，映射成“距周一几天”。
      const sinceMonday = (date.getDay() + 6) % 7;
      start = new Date(y, m, d - sinceMonday - offset * 7);
      end = new Date(y, m, d - sinceMonday - offset * 7 + 7);
      const thursday = new Date(y, m, d - sinceMonday - offset * 7 + 3);
      key = `${thursday.getFullYear()}-W${pad(isoWeekNumber(thursday))}`;
      break;
    }
    case 'month': {
      start = new Date(y, m - offset, 1);
      end = new Date(y, m - offset + 1, 1);
      key = `${start.getFullYear()}-${pad(start.getMonth() + 1)}`;
      break;
    }
    case 'quarter': {
      const quarterIndex = Math.floor(m / 3);
      start = new Date(y, (quarterIndex - offset) * 3, 1);
      end = new Date(y, (quarterIndex - offset + 1) * 3, 1);
      key = `${start.getFullYear()}-Q${Math.floor(start.getMonth() / 3) + 1}`;
      break;
    }
    case 'half': {
      const halfIndex = Math.floor(m / 6);
      start = new Date(y, (halfIndex - offset) * 6, 1);
      end = new Date(y, (halfIndex - offset + 1) * 6, 1);
      key = `${start.getFullYear()}-H${Math.floor(start.getMonth() / 6) + 1}`;
      break;
    }
    case 'year': {
      start = new Date(y - offset, 0, 1);
      end = new Date(y - offset + 1, 0, 1);
      key = `${start.getFullYear()}`;
      break;
    }
  }

  const label = PERIOD_LABELS[period];
  const shortLabel = shortLabelOf(period, start, end.getTime());
  return {
    period,
    key,
    label,
    shortLabel,
    title: `${label} · ${key}（${shortLabel}）`,
    start: start.getTime(),
    end: end.getTime(),
  };
}

/** 从最新一期开始生成 count 期；数组顺序就是页面从左到右的顺序（最新在前）。 */
export function buildPeriodWindows(
  period: MatrixPeriod,
  count: number,
  now: number = Date.now(),
): PeriodRange[] {
  return Array.from({ length: count }, (_, offset) => periodRangeAt(period, offset, now));
}

export type TaskEventKind =
  | 'created'
  | 'claimed'
  | 'started'
  | 'blocked'
  | 'deferred'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'risk_flagged'
  | 'risk_resolved'
  | 'updated';

export interface TaskEvent {
  kind: TaskEventKind;
  label: string;
  at: number;
  iso: string;
}

const EVENT_FIELDS: Array<{
  kind: TaskEventKind;
  label: string;
  pick: (task: TaskView) => string | null;
}> = [
  { kind: 'created', label: '新增', pick: (task) => task.created_at },
  { kind: 'claimed', label: '认领', pick: (task) => task.claimed_at },
  { kind: 'started', label: '开始', pick: (task) => task.started_at },
  { kind: 'blocked', label: '阻塞', pick: (task) => task.blocked_at },
  { kind: 'deferred', label: '暂缓', pick: (task) => task.deferred_at },
  { kind: 'completed', label: '完成', pick: (task) => task.completed_at },
  { kind: 'failed', label: '失败', pick: (task) => task.failed_at },
  { kind: 'cancelled', label: '取消', pick: (task) => task.cancelled_at },
  { kind: 'risk_flagged', label: '隐患', pick: (task) => task.risk_flagged_at },
  { kind: 'risk_resolved', label: '隐患解除', pick: (task) => task.risk_resolved_at },
];

/**
 * 一条任务的全部生命周期事件。
 *
 * `updated_at` 只在“没有其他事件恰好同一时刻”时补成“更新”：
 * 任务字段编辑会刷新 updated_at，若不加限制，刚改过标题的完成任务会在
 * 同一期里同时出现“完成”和“更新”两条记录，看起来像干了两件事。
 */
export function taskEvents(task: TaskView): TaskEvent[] {
  const events: TaskEvent[] = [];
  for (const field of EVENT_FIELDS) {
    const iso = field.pick(task);
    if (!iso) continue;
    const at = Date.parse(iso);
    if (Number.isNaN(at)) continue;
    events.push({ kind: field.kind, label: field.label, at, iso });
  }
  const updatedAt = Date.parse(task.updated_at);
  if (!Number.isNaN(updatedAt)) {
    const duplicate = events.some((event) => Math.abs(event.at - updatedAt) < 1000);
    if (!duplicate) {
      events.push({
        kind: 'updated',
        label: '更新',
        at: updatedAt,
        iso: task.updated_at,
      });
    }
  }
  return events.sort((left, right) => left.at - right.at);
}

export function eventsInRange(task: TaskView, range: PeriodRange): TaskEvent[] {
  return taskEvents(task).filter((event) => event.at >= range.start && event.at < range.end);
}

export interface PeriodTaskEntry {
  task: TaskView;
  events: TaskEvent[];
  /** 该任务在周期内的最后一次事件时间。 */
  lastAt: number;
}

/** 周期内出现过的任务，按最后事件时间倒序；同一时刻按创建时间倒序保证稳定。 */
export function tasksInPeriod(tasks: readonly TaskView[], range: PeriodRange): PeriodTaskEntry[] {
  const entries: PeriodTaskEntry[] = [];
  for (const task of tasks) {
    const events = eventsInRange(task, range);
    if (events.length === 0) continue;
    entries.push({ task, events, lastAt: events[events.length - 1]!.at });
  }
  return entries.sort((left, right) => {
    if (right.lastAt !== left.lastAt) return right.lastAt - left.lastAt;
    return Date.parse(right.task.created_at) - Date.parse(left.task.created_at);
  });
}

export interface SummaryCount {
  kind: TaskEventKind;
  label: string;
  count: number;
}

export interface PeriodSummary {
  counts: SummaryCount[];
  highlights: Array<{ tone: BadgeTone; text: string }>;
  taskCount: number;
}

export type BadgeTone = 'success' | 'danger' | 'warn' | 'info' | 'muted' | 'accent';

const SUMMARY_ORDER: TaskEventKind[] = [
  'completed',
  'created',
  'blocked',
  'failed',
  'cancelled',
  'started',
  'claimed',
  'risk_flagged',
  'risk_resolved',
  'deferred',
  'updated',
];

const SUMMARY_LABELS: Record<TaskEventKind, string> = {
  created: '新增',
  claimed: '认领',
  started: '启动',
  blocked: '阻塞',
  deferred: '暂缓',
  completed: '完成',
  failed: '失败',
  cancelled: '取消',
  risk_flagged: '隐患',
  risk_resolved: '解除',
  updated: '更新',
};

const HIGHLIGHT_WEIGHT: Record<TaskEventKind, number> = {
  completed: 100,
  blocked: 90,
  failed: 90,
  risk_flagged: 80,
  cancelled: 70,
  risk_resolved: 60,
  started: 50,
  created: 40,
  claimed: 30,
  deferred: 20,
  updated: 10,
};

export function eventTone(kind: TaskEventKind): BadgeTone {
  switch (kind) {
    case 'completed':
    case 'risk_resolved':
      return 'success';
    case 'blocked':
      return 'warn';
    case 'failed':
    case 'cancelled':
    case 'risk_flagged':
      return 'danger';
    case 'created':
    case 'started':
      return 'accent';
    default:
      return 'muted';
  }
}

/**
 * 按“汇报口径”压缩一个周期内的记录。
 *
 * 规则（无需 LLM，结果稳定可复现）：
 *  1. 统计各类事件次数，按 完成 > 新增 > 阻塞 > 失败 > 取消 > 启动 … 排序；
 *  2. 只挑最多两条最有信息量的事件做正文：完成/阻塞/失败优先，
 *     没有时退到新增/启动；
 *  3. 摘要正文是“完成「任务标题」”这种短句，和汇报里的一行结论同构。
 */
export function summarizePeriod(entries: readonly PeriodTaskEntry[]): PeriodSummary {
  const counts = new Map<TaskEventKind, number>();
  const candidates: Array<{ tone: BadgeTone; text: string; weight: number; at: number }> = [];

  for (const entry of entries) {
    for (const event of entry.events) {
      counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
      candidates.push({
        tone: eventTone(event.kind),
        text: `${SUMMARY_LABELS[event.kind]}「${entry.task.title}」`,
        weight: HIGHLIGHT_WEIGHT[event.kind],
        at: event.at,
      });
    }
  }

  const summaryCounts = SUMMARY_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map(
    (kind) => ({ kind, label: SUMMARY_LABELS[kind], count: counts.get(kind) ?? 0 }),
  );

  candidates.sort((left, right) => {
    if (right.weight !== left.weight) return right.weight - left.weight;
    return right.at - left.at;
  });

  return {
    counts: summaryCounts,
    highlights: candidates.slice(0, 2).map(({ tone, text }) => ({ tone, text })),
    taskCount: entries.length,
  };
}

export interface PeriodTaskNode {
  task: TaskView;
  depth: number;
  children: PeriodTaskNode[];
}

/**
 * 把周期内任务按 parent_id 重建成树。
 *
 * 父任务不在本周期时，子任务直接当根展示（depth=0）：用户要看的是
 * “这一期发生了什么”，硬把父任务从别的周期拉进来会伪造记录。
 * path 可用来稳定排序，缺失时退到 created_at + title。
 */
export function buildPeriodTaskForest(tasks: readonly TaskView[]): PeriodTaskNode[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string | null, TaskView[]>();
  for (const task of tasks) {
    const parentId = task.parent_id && byId.has(task.parent_id) ? task.parent_id : null;
    const list = children.get(parentId) ?? [];
    list.push(task);
    children.set(parentId, list);
  }
  const sortTasks = (list: TaskView[]): TaskView[] =>
    [...list].sort((left, right) => {
      const pathCompare = (left.path ?? '').localeCompare(right.path ?? '');
      if (pathCompare !== 0) return pathCompare;
      const createdCompare = left.created_at.localeCompare(right.created_at);
      if (createdCompare !== 0) return createdCompare;
      return left.title.localeCompare(right.title);
    });

  const visited = new Set<string>();
  const build = (task: TaskView, depth: number): PeriodTaskNode => {
    visited.add(task.id);
    const kids = sortTasks(children.get(task.id) ?? [])
      .filter((child) => !visited.has(child.id))
      .map((child) => build(child, depth + 1));
    return { task, depth, children: kids };
  };

  return sortTasks(children.get(null) ?? []).map((task) => build(task, 0));
}

export function flattenPeriodForest(nodes: readonly PeriodTaskNode[]): PeriodTaskNode[] {
  const result: PeriodTaskNode[] = [];
  const walk = (node: PeriodTaskNode): void => {
    result.push(node);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return result;
}

/** 通道展示名：别名 > topic > title > name > channel_key。 */
export function itemName(channel: ChannelView): string {
  return (
    channel.alias?.trim() ||
    channel.topic?.trim() ||
    channel.title?.trim() ||
    channel.name?.trim() ||
    channel.channel_key
  );
}

export function parentKey(channel: ChannelView): string {
  return channel.project?.trim() || '未分组';
}

export interface ChannelGroup {
  project: string;
  alias: string | null;
  channels: ChannelView[];
}

/** 同一父通道（project）的子通道放一组，组内按事项名排序。 */
export function groupChannelsByParent(channels: readonly ChannelView[]): ChannelGroup[] {
  const map = new Map<string, ChannelView[]>();
  for (const channel of channels) {
    const project = parentKey(channel);
    const list = map.get(project) ?? [];
    list.push(channel);
    map.set(project, list);
  }
  return Array.from(map.entries())
    .map(([project, list]) => {
      const sorted = [...list].sort((left, right) =>
        itemName(left).localeCompare(itemName(right), 'zh-Hans-CN'),
      );
      const alias =
        sorted
          .map((channel) => channel.alias?.trim())
          .find((value): value is string => Boolean(value)) ?? null;
      return { project, alias, channels: sorted };
    })
    .sort((left, right) => {
      if (left.project === '未分组') return 1;
      if (right.project === '未分组') return -1;
      return left.project.localeCompare(right.project, 'zh-Hans-CN');
    });
}

export const EMPTY_ITEM_META: ChannelMeta = {
  owner: null,
  priority: null,
  stage: null,
  group: null,
  participants: [],
  tags: [],
  iteration: null,
  product: null,
  category: null,
  remark: null,
  ai_suggestion: null,
  ai_suggestion_at: null,
};

export function itemMeta(channel: ChannelView): ChannelMeta {
  const meta = channel.meta;
  return meta ? { ...EMPTY_ITEM_META, ...meta } : EMPTY_ITEM_META;
}

export const STAGE_OPTIONS: Array<{ value: ItemStage; label: string }> = [
  { value: 'planned', label: '规划中' },
  { value: 'in_progress', label: '进行中' },
  { value: 'waiting', label: '等待' },
  { value: 'done', label: '已完成' },
  { value: 'closed', label: '关闭' },
];

export const STAGE_LABELS: Record<ItemStage, string> = {
  planned: '规划中',
  in_progress: '进行中',
  waiting: '等待',
  done: '已完成',
  closed: '关闭',
};

export const STAGE_ORDER: Record<ItemStage, number> = {
  planned: 0,
  in_progress: 1,
  waiting: 2,
  done: 3,
  closed: 4,
};

/**
 * 阶段筛选里的“非关闭”伪值。
 *
 * 它不是一个真实阶段，只是默认筛选：事项页常驻着大量已经收尾的事项，
 * 默认把它们藏起来，用户仍可从下拉框切到“全部”或“关闭”单独查看。
 */
export const OPEN_STAGE_FILTER = 'open';

export function matchesStageFilter(stage: ItemStage | null, filter: string): boolean {
  if (!filter) return true;
  if (filter === OPEN_STAGE_FILTER) return stage !== 'closed';
  return stage === filter;
}

export const PRIORITY_ORDER: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export interface ItemTaskStats {
  total: number;
  done: number;
  cancelled: number;
  open: number;
  blocked: number;
  active: number;
  /** 完成率：分母排除已取消，失败仍计入，避免进度虚高。 */
  progress: number;
}

export function taskStats(tasks: readonly TaskView[]): ItemTaskStats {
  let done = 0;
  let cancelled = 0;
  let open = 0;
  let blocked = 0;
  let active = 0;
  for (const task of tasks) {
    if (task.status === 'done') done += 1;
    else if (task.status === 'cancelled') cancelled += 1;
    else {
      open += 1;
      if (task.status === 'blocked') blocked += 1;
      if (task.status === 'in_progress') active += 1;
    }
  }
  const base = Math.max(tasks.length - cancelled, 0);
  return {
    total: tasks.length,
    done,
    cancelled,
    open,
    blocked,
    active,
    progress: base === 0 ? 0 : Math.round((done / base) * 100),
  };
}

/** 未结束任务的最高优先级；没有未结束任务时回退到全部任务的最高优先级。 */
export function derivedPriority(tasks: readonly TaskView[]): Priority | null {
  const open = tasks.filter((task) => !isClosed(task.status));
  const pool = open.length > 0 ? open : tasks;
  let best: Priority | null = null;
  for (const task of pool) {
    if (!best || PRIORITY_ORDER[task.priority] < PRIORITY_ORDER[best]) best = task.priority;
  }
  return best;
}

function isClosed(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** 最常见负责人；并列时保留先出现者（任务列表已按更新时间倒序）。 */
export function derivedOwner(tasks: readonly TaskView[]): string | null {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const assignee = task.assignee?.trim();
    if (!assignee) continue;
    counts.set(assignee, (counts.get(assignee) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

export function derivedParticipants(tasks: readonly TaskView[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const task of tasks) {
    const assignee = task.assignee?.trim();
    if (!assignee || seen.has(assignee)) continue;
    seen.add(assignee);
    result.push(assignee);
    if (result.length >= 8) break;
  }
  return result;
}

export function derivedTags(tasks: readonly TaskView[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const task of tasks) {
    for (const tag of task.tags) {
      const value = tag.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
      if (result.length >= 8) break;
    }
    if (result.length >= 8) break;
  }
  return result;
}

/**
 * 事项阶段：用户标注优先；没标注时按任务状态推导。
 *
 * 推导顺序：全部结束 → 已完成；有阻塞 → 等待；有进行中 → 进行中；
 * 其余（草稿/待认领）→ 规划中。这样左栏在用户还没填写时也不是一片空白。
 */
export function derivedStage(
  channel: ChannelView,
  tasks: readonly TaskView[],
): ItemStage | null {
  if (channel.status === 'archived') return 'done';
  if (tasks.length === 0) return 'planned';
  const stats = taskStats(tasks);
  if (stats.open === 0) return 'done';
  if (stats.blocked > 0) return 'waiting';
  if (stats.active > 0 || tasks.some((task) => task.status === 'claimed')) return 'in_progress';
  return 'planned';
}

export interface ResolvedField<T> {
  value: T;
  derived: boolean;
}

export function resolveOwner(
  meta: ChannelMeta,
  tasks: readonly TaskView[],
): ResolvedField<string | null> {
  if (meta.owner) return { value: meta.owner, derived: false };
  const derived = derivedOwner(tasks);
  return { value: derived, derived: derived !== null };
}

export function resolvePriority(
  meta: ChannelMeta,
  tasks: readonly TaskView[],
): ResolvedField<Priority | null> {
  if (meta.priority) return { value: meta.priority, derived: false };
  const derived = derivedPriority(tasks);
  return { value: derived, derived: derived !== null };
}

export function resolveStage(
  meta: ChannelMeta,
  channel: ChannelView,
  tasks: readonly TaskView[],
): ResolvedField<ItemStage | null> {
  if (meta.stage) return { value: meta.stage, derived: false };
  const derived = derivedStage(channel, tasks);
  return { value: derived, derived: derived !== null };
}

export function resolveParticipants(
  meta: ChannelMeta,
  tasks: readonly TaskView[],
): ResolvedField<string[]> {
  if (meta.participants.length > 0) return { value: meta.participants, derived: false };
  const derived = derivedParticipants(tasks);
  return { value: derived, derived: derived.length > 0 };
}

export function resolveTags(
  meta: ChannelMeta,
  tasks: readonly TaskView[],
): ResolvedField<string[]> {
  if (meta.tags.length > 0) return { value: meta.tags, derived: false };
  const derived = derivedTags(tasks);
  return { value: derived, derived: derived.length > 0 };
}

/** 按中文逗号/英文逗号/空白切分标签输入；与 format.parseTagInput 同规则。 */
export function parseListInput(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
