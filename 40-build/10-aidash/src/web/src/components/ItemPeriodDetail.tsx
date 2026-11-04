import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { CardView, ChannelView, ReportView, TaskView } from '../types';
import { listCards } from '../api/endpoints';
import { useAsync } from '../hooks/useAsync';
import { formatRelative, formatStamp, cardHeadline, truncate } from '../lib/format';
import { openCard } from '../lib/router';
import {
  buildPeriodTaskForest,
  eventTone,
  itemName,
  parentKey,
  summarizePeriod,
  tasksInPeriod,
} from '../lib/item-period';
import type { PeriodRange, PeriodTaskNode } from '../lib/item-period';
import { CardStatusBadge, PriorityBadge, TaskStatusBadge } from './Badge';
import { EmptyState, Loading } from './Feedback';
import { Markdown } from './Markdown';
import { TaskCreateForm } from './TaskCreateForm';
import { TaskDetail } from './TaskDetail';

const DECISION_PAGE_SIZE = 200;

/** 汇报状态文案；服务端状态是英文枚举，直接展示会让中文界面出现裸值。 */
const REPORT_STATUS_LABELS: Record<string, string> = {
  generating: '生成中',
  ready: '已生成',
  failed: '生成失败',
  cancelled: '已取消',
};

function isClosedTask(task: TaskView): boolean {
  return task.status === 'done' || task.status === 'cancelled' || task.status === 'failed';
}

/**
 * 事项时间轴格子详情。
 *
 * 固定停靠右侧（与任务详情同一套视觉语言），只让自己滚动；主表保持原位。
 * 内容分三层，顺序对应“看结论 → 看过程 → 看原始记录”：
 *   1. 本周期汇报（全局周期报，按 period_key 精确匹配）；
 *   2. 本周期任务树（完整列出生命周期落在窗口内的任务，重建父子层级）；
 *   3. 本周期决策记录（question 卡，按创建/回答时间落窗）。
 */
export function ItemPeriodDetail({
  channel,
  range,
  tasks,
  reports,
  onClose,
  onRefresh,
}: {
  channel: ChannelView;
  range: PeriodRange;
  tasks: readonly TaskView[];
  reports: readonly ReportView[];
  onClose: () => void;
  /** 新建任务或任务详情里改完字段后，让上层重拉任务/汇报。 */
  onRefresh?: () => void;
}): ReactElement {
  const entries = tasksInPeriod(tasks, range);
  const summary = summarizePeriod(entries);
  const [hideClosed, setHideClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);

  // 切到另一个事项/周期时，上一个格子的临时状态不该带过来：
  // 打开的任务详情、新建表单和折叠展开集合都属于上一格。
  useEffect(() => {
    setOpenTaskId(null);
    setCreating(false);
    setCollapsed(new Set());
  }, [channel.channel_key, range.key]);

  const visibleEntries = hideClosed
    ? entries.filter((entry) => !isClosedTask(entry.task))
    : entries;
  const closedCount = entries.length - entries.filter((entry) => !isClosedTask(entry.task)).length;
  const forest = buildPeriodTaskForest(visibleEntries.map((entry) => entry.task));
  const entryByTaskId = new Map(visibleEntries.map((entry) => [entry.task.id, entry]));
  const periodReports = reports.filter(
    (report) => report.period === range.period && report.period_key === range.key,
  );

  const decisions = useAsync<CardView[]>(
    async () => {
      const page = await listCards({
        channel_key: channel.channel_key,
        types: ['question'],
        page_size: DECISION_PAGE_SIZE,
        sort: 'updated_at',
        order: 'desc',
      });
      return page.items.filter((card) => {
        const at = Date.parse(card.answered_at ?? card.created_at);
        return !Number.isNaN(at) && at >= range.start && at < range.end;
      });
    },
    [channel.channel_key, range.key, range.period],
  );

  // 任务详情是叠在格子详情上的另一层；Esc 应该先关最上层，
  // 否则用户按一次 Esc 会把两层一起关掉，看起来像“打开失败”。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (openTaskId) setOpenTaskId(null);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, openTaskId]);

  const toggleCollapsed = (taskId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const renderNode = (node: PeriodTaskNode): ReactElement => {
    const entry = entryByTaskId.get(node.task.id);
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.task.id);
    const closed = isClosedTask(node.task);
    const lastAt = entry?.lastAt ?? Date.parse(node.task.updated_at);
    return (
      <div key={node.task.id} className="items-period-task-node">
        <div className="items-period-task-row">
          {hasChildren ? (
            <button
              type="button"
              className="items-task-caret"
              aria-label={isCollapsed ? '展开子任务' : '收起子任务'}
              aria-expanded={!isCollapsed}
              onClick={() => toggleCollapsed(node.task.id)}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="items-task-caret-spacer" aria-hidden="true" />
          )}
          <button
            type="button"
            className="items-period-task-main"
            title={`${node.task.title}\n${node.task.id}`}
            onClick={() => setOpenTaskId(node.task.id)}
          >
            <TaskStatusBadge status={node.task.status} />
            <PriorityBadge priority={node.task.priority} muted={closed} />
            <span className="items-period-task-title">{node.task.title}</span>
            <span
              className="items-period-task-time"
              title={Number.isNaN(lastAt) ? '—' : formatStamp(lastAt)}
            >
              {Number.isNaN(lastAt) ? '—' : formatRelative(lastAt)}
            </span>
          </button>
        </div>
        {hasChildren && !isCollapsed ? (
          <div className="items-period-task-children">
            {node.children.map(renderNode)}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <aside className="items-period-detail" aria-label={`${itemName(channel)} ${range.title} 详情`}>
        <header className="items-detail-header">
          <div className="items-detail-title">
            <strong>{itemName(channel)}</strong>
            <span className="muted small">
              {parentKey(channel)} · {range.title}
            </span>
          </div>
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>
            收起
          </button>
        </header>

        <div className="items-detail-stats">
          <span>{entries.length} 条任务记录</span>
          {summary.counts.length > 0 ? (
            <span className="items-detail-counts">
              {summary.counts.map((count) => (
                <span key={count.kind} className={`items-count tone-${eventTone(count.kind)}`}>
                  {count.label}
                  {count.count}
                </span>
              ))}
            </span>
          ) : null}
        </div>

        <section className="items-detail-section" aria-label="本周期汇报">
          <h3>本周期汇报（{periodReports.length}）</h3>
          {periodReports.length === 0 ? (
            <p className="muted small">
              该周期还没有对应汇报。汇报按六种自然周期统一生成，可到「汇报」Tab 触发更新；
              这里只展示 period_key 精确匹配的记录。
            </p>
          ) : (
            periodReports.map((report) => (
              <details key={report.id} className="items-report" open={periodReports.length === 1}>
                <summary>
                  <strong>{report.title}</strong>
                  <span className={`badge report-status-${report.status}`}>
                    {REPORT_STATUS_LABELS[report.status] ?? report.status}
                  </span>
                  <span className="muted small">
                    {report.generated_at ? `生成于 ${formatStamp(report.generated_at)}` : '尚未生成完成'}
                    {' · '}
                    {report.source_count} 条素材
                  </span>
                </summary>
                {report.content_md ? (
                  <div className="items-report-body">
                    <Markdown source={report.content_md} />
                  </div>
                ) : (
                  <p className="muted small">
                    {report.error_message || '这条汇报没有正文（可能仍在生成或生成失败）。'}
                  </p>
                )}
              </details>
            ))
          )}
          <p className="muted small">
            汇报是全局周期汇报，覆盖所有事项；任务树和下面的决策记录按当前事项过滤。
          </p>
        </section>

        <section className="items-detail-section" aria-label="本周期任务树">
          <div className="items-detail-task-toolbar">
            <h3>
              本周期任务树（{visibleEntries.length}
              {hideClosed ? ` / ${entries.length}` : ''}）
            </h3>
            <div className="inline">
              <button
                type="button"
                className={hideClosed ? 'btn btn-small' : 'btn btn-small btn-ghost'}
                aria-pressed={hideClosed}
                title={
                  hideClosed
                    ? '当前只显示未结束任务；点一下显示全部'
                    : '当前显示全部任务；点一下只看待处理'
                }
                onClick={() => setHideClosed((value) => !value)}
              >
                {hideClosed ? `全部（含已结束 ${closedCount}）` : '只看待处理'}
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setCreating((value) => !value)}
              >
                {creating ? '收起新建' : '新建任务'}
              </button>
            </div>
          </div>

          {creating ? (
            <div className="items-detail-create">
              <TaskCreateForm
                channelKey={channel.channel_key}
                parents={[...tasks]}
                onCreated={() => {
                  setCreating(false);
                  setDetailNonce((value) => value + 1);
                  onRefresh?.();
                }}
                onCancel={() => setCreating(false)}
              />
            </div>
          ) : null}

          {forest.length === 0 ? (
            <EmptyState
              title={hideClosed ? '该周期没有待处理任务' : '该周期没有任务记录'}
              hint={
                hideClosed
                  ? '取消“只看待处理”可以查看已结束任务。'
                  : '任务记录按创建/认领/开始/阻塞/完成/失败/取消/更新等生命周期事件落窗。'
              }
            />
          ) : (
            <div className="items-detail-task-tree">{forest.map(renderNode)}</div>
          )}
          <p className="muted small">
            点任务标题打开任务详情；点左侧箭头收起/展开子任务。树里只保留最后活跃时间，完整过程在详情里看。
          </p>
        </section>

        <section className="items-detail-section" aria-label="本周期决策记录">
          <h3>本周期决策记录（{decisions.data?.length ?? 0}）</h3>
          {decisions.loading && !decisions.data ? <Loading label="加载决策记录…" /> : null}
          {decisions.error ? (
            <p className="muted small">决策记录加载失败：{decisions.error}</p>
          ) : null}
          {(decisions.data ?? []).map((card) => (
            <button
              key={card.id}
              type="button"
              className="items-decision-row"
              onClick={() => openCard(card.id)}
              title="打开决策卡详情"
            >
              <CardStatusBadge status={card.status} />
              <PriorityBadge priority={card.priority} />
              <span className="grow">{truncate(cardHeadline(card), 64)}</span>
              <span className="muted small">
                {formatStamp(card.answered_at ?? card.created_at)}
              </span>
            </button>
          ))}
          {decisions.data && decisions.data.length === 0 ? (
            <p className="muted small">该周期没有产生或回答 question 卡。</p>
          ) : null}
        </section>
      </aside>

      {openTaskId ? (
        <TaskDetail
          key={openTaskId}
          taskId={openTaskId}
          tasks={[...tasks]}
          claimToken={null}
          reloadNonce={detailNonce}
          onChanged={() => {
            setDetailNonce((value) => value + 1);
            onRefresh?.();
          }}
          onOpenTask={(taskId) => setOpenTaskId(taskId)}
          onClose={() => setOpenTaskId(null)}
        />
      ) : null}
    </>
  );
}
