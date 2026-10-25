import type { ReactElement } from 'react';
import type { TaskBoardStats } from './task-board-utils';

export interface TaskBoardHeaderProps {
  compact: boolean;
  stats: TaskBoardStats;
  progressBase: number;
  donePct: number;
  activePct: number;
  hideClosed: boolean;
  creating: boolean;
  onToggleHideClosed: () => void;
  onToggleCreating: () => void;
  onRefresh: () => void;
}

/** 看板头部：统计、进度条和三个全局动作。纯展示，筛选状态仍由 TaskBoard 持有。 */
export function TaskBoardHeader({
  compact,
  stats,
  progressBase,
  donePct,
  activePct,
  hideClosed,
  creating,
  onToggleHideClosed,
  onToggleCreating,
  onRefresh,
}: TaskBoardHeaderProps): ReactElement {
  return (
    <header className="panel-header task-board-header">
      <div className="task-board-heading">
        <div className="task-board-titleline">
          <h2>{compact ? '本次通道任务' : '任务树'}</h2>
          <div className="task-stats" aria-label="任务统计">
            <span className="task-stat">总节点 <strong>{stats.total}</strong></span>
            <span className="task-stat task-stat-active">
              进行中 <strong>{stats.active}</strong>
            </span>
            <span className="task-stat" title="还没人接的任务；已暂缓的也在这里，但会带“已暂缓”标">
              待认领 <strong>{stats.pending}</strong>
            </span>
            <span className="task-stat" title="还没提交、不可认领的草稿">
              草稿 <strong>{stats.draft}</strong>
            </span>
            <span className="task-stat" title="已明确决定先不做、并写了原因的任务">
              已暂缓 <strong>{stats.deferred}</strong>
            </span>
            <span className="task-stat task-stat-blocked">阻塞 <strong>{stats.blocked}</strong></span>
            <span
              className={stats.riskOpen > 0 ? 'task-stat task-stat-risk' : 'task-stat'}
              title="带着未解除隐患收口的任务；已解除的不计入，但可在复盘筛选里查到"
            >
              带隐患 <strong>{stats.riskOpen}</strong>
            </span>
            <span className="task-stat task-stat-done">完成 <strong>{stats.done}</strong></span>
            <span className="task-stat">取消 <strong>{stats.cancelled}</strong></span>
          </div>
        </div>
        {/*
          进度条回答一个统计数字回答不了的问题：这条通道离收口还有多远。
          分段而不是单一完成度：进行中的量也在动，用户能看出“活有人在干”
          还是“全堆在待认领”。分母去掉取消（取消是决定不做，不是落后）。
        */}
        <div
          className="task-progress"
          role="progressbar"
          aria-label="任务完成进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={donePct}
          title={`完成 ${stats.done} / 有效 ${progressBase}（不含取消 ${stats.cancelled}）；进行中 ${stats.active}，待认领 ${stats.pending}，草稿 ${stats.draft}`}
        >
          <div className="task-progress-track" aria-hidden="true">
            <span className="task-progress-done" style={{ width: `${donePct}%` }} />
            <span className="task-progress-active" style={{ width: `${Math.min(activePct, 100 - donePct)}%` }} />
          </div>
          <span className="task-progress-text">
            完成 <strong>{donePct}%</strong>
            <span className="muted">
              {' '}· 进行中 {stats.active} · 未开始 {stats.pending + stats.draft}
              {stats.cancelled > 0 ? ` · 已取消 ${stats.cancelled}` : ''}
            </span>
          </span>
        </div>
      </div>
      <div className="inline">
        <button
          type="button"
          className={hideClosed ? 'btn btn-small' : 'btn btn-small btn-ghost'}
          aria-pressed={hideClosed}
          title={
            hideClosed
              ? '当前只显示未结束或带结束通知的任务；点一下显示全部'
              : '当前显示全部任务；点一下只看待处理'
          }
          onClick={onToggleHideClosed}
        >
          {hideClosed ? `全部（含已结束 ${stats.done + stats.cancelled}）` : '只看待处理'}
        </button>
        <button type="button" className="btn btn-small" onClick={onToggleCreating}>
          {creating ? '收起新建' : '新建任务'}
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={onRefresh}>
          刷新
        </button>
      </div>
    </header>
  );
}
