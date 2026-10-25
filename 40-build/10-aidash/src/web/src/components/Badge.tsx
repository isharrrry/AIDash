import type { ReactElement } from 'react';
import type {
  CardStatus,
  CardType,
  EnrichmentStatus,
  HandoffState,
  Priority,
  StatusResult,
  TaskKind,
  TaskStatus,
} from '../types';
import { formatAbsolute } from '../lib/format';
import {
  CARD_STATUS_LABELS,
  CARD_TYPE_LABELS,
  ENRICHMENT_LABELS,
  HANDOFF_STATE_LABELS,
  RESULT_LABELS,
  SEVERITY_LABELS,
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
} from '../lib/format';

/**
 * 优先级徽标。
 *
 * `muted` 只给“已结束（完成/取消）”的任务树行用：P0/P1 的红黄是“需要马上处理”
 * 的注意力信号，任务都结束了还亮着，会跟未结束的任务抢眼睛。降成灰色后，
 * 颜色强弱与“还要不要动手”保持一致；详情/卡片仍按原色显示，因为它们看的是
 * 单条任务的属性，不需要跟列表抢注意力。
 */
export function PriorityBadge({
  priority,
  muted = false,
}: {
  priority: Priority;
  muted?: boolean;
}): ReactElement {
  const className = `badge priority-${priority.toLowerCase()}${muted ? ' priority-muted' : ''}`;
  return <span className={className}>{priority}</span>;
}

export function CardTypeBadge({ type }: { type: CardType }): ReactElement {
  return <span className={`badge type-${type}`}>{CARD_TYPE_LABELS[type]}</span>;
}

export function CardStatusBadge({ status }: { status: CardStatus }): ReactElement {
  return <span className={`badge card-status-${status}`}>{CARD_STATUS_LABELS[status]}</span>;
}

export function TaskStatusBadge({ status }: { status: TaskStatus }): ReactElement {
  return <span className={`badge task-status-${status}`}>{TASK_STATUS_LABELS[status]}</span>;
}

/**
 * 任务类型徽标。
 *
 * 任务树现在有独立的“类型”列：普通任务也要显示“任务”，
 * 否则该列对大多数行是空白，用户反而不确定是“没有类型”还是“渲染丢了”。
 * 建议任务仍用高对比样式突出——它是“等你批准”的，不是队列里待认领的活。
 */
export function TaskKindBadge({ kind }: { kind: TaskKind }): ReactElement {
  return <span className={`badge kind-${kind}`}>{TASK_KIND_LABELS[kind]}</span>;
}

/**
 * “已暂缓/已排期”徽标。
 *
 * 用独立徽标而不是改状态文字：任务状态仍是 pending（没人接），
 * 暂缓只说明“已明确决定先不做”。两者同时可见，用户才不会把排期误读成认领。
 */
export function TaskDeferBadge({
  reason,
  until,
}: {
  reason: string;
  until: string | null;
}): ReactElement {
  const title = until
    ? `暂缓原因：${reason} · 计划恢复 ${formatAbsolute(until)}`
    : `暂缓原因：${reason}`;
  return (
    <span className="badge defer-badge" title={title}>
      已暂缓
    </span>
  );
}

/**
 * “隐患”徽标：为了按时收口而带着已知缺陷完成时留下的标记。
 *
 * 与 `TaskDeferBadge` 一样是“状态覆盖层”而不是新状态：任务本身可能已经 done，
 * 隐患标记回答的是另一个问题——“这次完成是不是打了折扣、折扣是什么”。
 * 未解除用高对比红，已解除降为空心灰：复盘时两者都能被筛出来，
 * 但日常视图里只有还欠着的隐患抢注意力。
 */
export function TaskRiskBadge({
  note,
  resolved = false,
  resolvedAt = null,
}: {
  note: string;
  resolved?: boolean;
  resolvedAt?: string | null;
}): ReactElement {
  const title = resolved
    ? `隐患已解除${resolvedAt ? `（${formatAbsolute(resolvedAt)}）` : ''}：${note}`
    : `未解除的隐患：${note}`;
  return (
    <span
      className={`badge risk-badge${resolved ? ' risk-badge-resolved' : ''}`}
      title={title}
    >
      {resolved ? '隐患已解除' : '隐患'}
    </span>
  );
}

/**
 * “有遗留”徽标：父任务已完成/取消，但后代里仍有未结束的节点。
 *
 * 为什么需要它：父任务打上“完成”后，用户很容易以为这一支已经收口；
 * 但验收时经常又拆出一条待办子任务。没有这个提示，遗留的子任务会被
 * 父任务的完成状态掩盖，直到有人专门展开树才发现。
 */
export function TaskLeftoverBadge({
  openCount,
}: {
  openCount: number;
}): ReactElement {
  return (
    <span
      className="badge badge-leftover"
      title={`父任务已结束，但仍有 ${openCount} 个后代任务未结束（未完成也未取消）`}
    >
      有遗留 {openCount}
    </span>
  );
}

export function EnrichmentBadge({ status }: { status: EnrichmentStatus }): ReactElement {
  return <span className={`badge enrich-${status}`}>{ENRICHMENT_LABELS[status]}</span>;
}

export function HandoffStateBadge({ state }: { state: HandoffState | null }): ReactElement {
  const value = state ?? 'draft';
  return <span className={`badge handoff-${value}`}>{HANDOFF_STATE_LABELS[value]}</span>;
}

export function ResultBadge({ result }: { result: StatusResult | null }): ReactElement {
  if (!result) return <span className="badge">未知结果</span>;
  return <span className={`badge result-${result}`}>{RESULT_LABELS[result]}</span>;
}

export function SeverityBadge({
  severity,
}: {
  severity: 'info' | 'warn' | 'critical' | null;
}): ReactElement | null {
  if (!severity) return null;
  return <span className={`badge severity-${severity}`}>{SEVERITY_LABELS[severity]}</span>;
}
