/**
 * 展示层格式化工具：只做纯函数，不碰 React，便于在页面与组件间复用。
 */
import type {
  CardOption,
  CardStatus,
  CardType,
  CardView,
  EnrichmentStatus,
  HandoffState,
  RecommendationRole,
  StatusResult,
  TaskKind,
  TaskStatus,
  TaskView,
} from '../types';

export const CARD_TYPE_LABELS: Record<CardType, string> = {
  info: '信息',
  handoff: '交接',
  question: '决策',
  suggestion: '建议',
  status: '状态',
  artifact: '产物',
};

export const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  open: '待处理',
  answered: '已回答',
  dismissed: '已忽略',
  expired: '已过期',
  archived: '已归档',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '草稿',
  pending: '待认领',
  claimed: '已认领',
  in_progress: '进行中',
  blocked: '阻塞',
  done: '完成',
  failed: '失败',
  cancelled: '取消',
};

/**
 * 任务类型文案。普通任务不展示类型徽标（默认形态不需要标签），
 * 只有“建议”需要在任务树里一眼区分出来。
 */
export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  task: '任务',
  suggestion: '建议',
};

export const ENRICHMENT_LABELS: Record<EnrichmentStatus, string> = {
  pending: '增强排队',
  running: '增强中',
  done: '已增强',
  unavailable: '增强不可用',
  skipped: '未增强',
};

export const HANDOFF_STATE_LABELS: Record<HandoffState, string> = {
  draft: '未复制',
  copied: '已复制',
  sent: '已发送',
  ack: '对方已知悉',
};

export const RESULT_LABELS: Record<StatusResult, string> = {
  success: '成功',
  failed: '失败',
  blocked: '阻塞',
  partial: '部分完成',
};

export const SEVERITY_LABELS: Record<'info' | 'warn' | 'critical', string> = {
  info: '提示',
  warn: '警告',
  critical: '严重',
};

export function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 相对时间：列表里扫一眼就知道新旧，悬停时页面再给绝对时间。 */
export function formatRelative(value: string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const diffMs = Date.now() - date.getTime();
  const future = diffMs < 0;
  const seconds = Math.abs(Math.floor(diffMs / 1000));
  if (seconds < 45) return future ? '即将' : '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return future ? `${minutes} 分钟后` : `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return future ? `${hours} 小时后` : `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return future ? `${days} 天后` : `${days} 天前`;
  return formatAbsolute(value);
}

export function formatAbsolute(value: string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * 固定输出“YYYY-MM-DD HH:mm”（浏览器本地时区）。
 *
 * 为什么不用 Intl 的 formatAbsolute：通道树要在窄列里并排显示“开始/结束”，
 * Intl 在中文环境可能输出“2026/10/24 08:15”，斜杠与全角空格会让两列对不齐；
 * 这里手工拼固定宽度，年月日时分一眼可比。
 */
export function formatStamp(value: string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function formatBytes(size: number | null | undefined): string {
  if (size === null || size === undefined) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 只允许 http/https，避免 javascript: 这类链接进入 href。 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export const RECOMMENDATION_ROLE_LABELS: Record<RecommendationRole, string> = {
  primary: '主推荐',
  backup: '备选推荐',
};

/**
 * 读取新卡的推荐角色。
 *
 * 只认 recommendation_role，不把旧字段硬猜成主/备：
 * 旧数据里的 recommendation 既可能是布尔也可能是理由字符串，无法区分主次，
 * 所以旧数据返回 null，由 recommendationLabel 统一降级成“推荐”。
 */
export function recommendationRole(option: CardOption): RecommendationRole | null {
  return option.recommendation_role === 'primary' || option.recommendation_role === 'backup'
    ? option.recommendation_role
    : null;
}

export function isPrimaryRecommendation(option: CardOption): boolean {
  return recommendationRole(option) === 'primary';
}

export function isBackupRecommendation(option: CardOption): boolean {
  return recommendationRole(option) === 'backup';
}

/** 兼容旧数据的“是否推荐”：新角色、旧布尔 true、旧非空理由字符串都算。 */
export function isRecommendedOption(option: CardOption): boolean {
  if (recommendationRole(option)) return true;
  if (option.recommendation === true) return true;
  return typeof option.recommendation === 'string' && option.recommendation.trim().length > 0;
}

/** 徽标文案：主推荐 / 备选推荐；旧数据只能显示“推荐”；不推荐返回 null。 */
export function recommendationLabel(option: CardOption): string | null {
  const role = recommendationRole(option);
  if (role) return RECOMMENDATION_ROLE_LABELS[role];
  return isRecommendedOption(option) ? '推荐' : null;
}

/** 旧字段里的推荐理由；布尔或空值返回空串，避免把 true 渲染成文字。 */
export function recommendationReason(option: CardOption): string {
  return typeof option.recommendation === 'string' ? option.recommendation.trim() : '';
}

/** 快速回答优先取主推荐，其次备选，最后才是旧数据里的推荐项。 */
export function recommendedOption(card: CardView): CardOption | undefined {
  return (
    card.options.find(isPrimaryRecommendation) ??
    card.options.find(isBackupRecommendation) ??
    card.options.find(isRecommendedOption)
  );
}

/**
 * 任务行要显示的“当前状态时间”。
 *
 * 返回值是状态事件本身发生的时间（例如认领时间、完成时间），而不是 updated_at：
 * updated_at 会被任何字段编辑刷新，用它会让“完成时间”在改标题后漂移。
 * draft/pending 还没发生过状态变更，返回 null，由调用方退回 created_at。
 */
export function taskStatusTime(task: TaskView): { label: string; value: string } | null {
  switch (task.status) {
    case 'claimed':
      return task.claimed_at ? { label: '认领', value: task.claimed_at } : null;
    case 'in_progress':
      return task.started_at ? { label: '开始', value: task.started_at } : null;
    case 'blocked':
      return task.blocked_at ? { label: '阻塞', value: task.blocked_at } : null;
    case 'done':
      return task.completed_at ? { label: '完成', value: task.completed_at } : null;
    // failed 也是带时刻的终态：不显示会让“什么时候失败的”只能去详情里翻，
    // 与用户要求的“状态 + 时间在通道里一眼看到”相悖。
    case 'failed':
      return task.failed_at ? { label: '失败', value: task.failed_at } : null;
    case 'cancelled':
      return task.cancelled_at ? { label: '取消', value: task.cancelled_at } : null;
    default:
      return null;
  }
}

export function optionLabel(card: CardView, optionId: string | null | undefined): string {
  if (!optionId) return '';
  const option = card.options.find((item) => item.id === optionId);
  return option ? option.label : optionId;
}

export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 100)}%`;
}

export function cardHeadline(card: CardView): string {
  return card.title?.trim() || card.summary?.trim() || CARD_TYPE_LABELS[card.type];
}

export function parseTagInput(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** datetime-local 控件需要本地时区的 YYYY-MM-DDTHH:mm，不能直接用 ISO 的 Z 时间。 */
export function toLocalInput(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 控件值按浏览器本地时区解释，再转成服务端要求的 ISO 8601。 */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function localInputDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return toLocalInput(date.toISOString());
}

export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

