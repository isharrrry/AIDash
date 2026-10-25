import type { ReactElement } from 'react';
import { formatAbsolute, formatRelative } from '../lib/format';
import type { TaskView } from '../types';
import { timelineEntries } from './task-detail-timeline';

/** 任务详情中的状态时间线与各类原因/隐患记录。纯展示，不持有状态。 */
export function TaskDetailTimeline({ task }: { task: TaskView }): ReactElement {
  const timeline = timelineEntries(task);

  return (
    <section>
      <h4>状态时间线</h4>
      {timeline.length > 0 ? (
        <ol className="timeline">
          {timeline.map((entry) => (
            <li key={`${entry.label}-${entry.value}`}>
              <span className="timeline-label">{entry.label}</span>
              <span className="timeline-time" title={entry.value}>
                {formatAbsolute(entry.value)}
              </span>
              <span className="muted small">{formatRelative(entry.value)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">暂无状态时间线数据。</p>
      )}
      {task.blocked_reason ? (
        <div className="reason-box">
          <strong>阻塞原因</strong>
          <p>{task.blocked_reason}</p>
        </div>
      ) : null}
      {task.fail_reason ? (
        <div className="reason-box reason-box-danger">
          <strong>失败原因</strong>
          <p>{task.fail_reason}</p>
        </div>
      ) : null}
      {/* 取消也必须有原由：否则看板上只剩一个“已取消”，无法判断是重复、误建还是判断错误。 */}
      {task.cancel_reason ? (
        <div className="reason-box">
          <strong>取消原因</strong>
          <p>{task.cancel_reason}</p>
        </div>
      ) : null}
      {task.defer_reason ? (
        <div className="reason-box">
          <strong>暂缓 / 排期</strong>
          <p>{task.defer_reason}</p>
          <p className="muted small">
            {task.deferred_until
              ? `计划恢复：${formatAbsolute(task.deferred_until)}`
              : '未设定计划恢复时间'}
            {task.deferred_at ? ` · 标记于 ${formatAbsolute(task.deferred_at)}` : ''}
          </p>
        </div>
      ) : null}
      {/*
        隐患不随任务完成而消失：它回答的是“这次收口打了什么折扣”。
        解除后保留 note 原文，只把状态改成已解除，复盘才能对照当时的判断。
      */}
      {task.risk_note ? (
        <div className={task.risk_resolved_at ? 'reason-box' : 'reason-box reason-box-danger'}>
          <strong>{task.risk_resolved_at ? '隐患（已解除）' : '隐患（未解除）'}</strong>
          <p>{task.risk_note}</p>
          {task.risk_resolution ? (
            <p className="muted small">复盘结论：{task.risk_resolution}</p>
          ) : null}
          <p className="muted small">
            {task.risk_flagged_at
              ? `标记于 ${formatAbsolute(task.risk_flagged_at)}`
              : '标记时间未知'}
            {task.risk_resolved_at
              ? ` · 解除于 ${formatAbsolute(task.risk_resolved_at)}`
              : ' · 仍未解除'}
          </p>
        </div>
      ) : null}
    </section>
  );
}
