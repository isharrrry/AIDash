import type { ReactElement } from 'react';
import { ALLOWED_EVENTS, EVENT_LABELS, eventNeedsToken } from '../lib/task-events';
import type { TaskEvent } from '../lib/task-events';
import type { TaskView } from '../types';

export interface TaskDetailEventsProps {
  task: TaskView;
  claimToken: string | null;
  reason: string;
  deferUntil: string;
  evidenceInput: string;
  busy: string | null;
  onReasonChange: (value: string) => void;
  onDeferUntilChange: (value: string) => void;
  onEvidenceInputChange: (value: string) => void;
  onSubmit: (event: TaskEvent) => void;
}

/** 状态事件区：按状态机展示可用事件，并在缺令牌时提前禁用需要令牌的按钮。 */
export function TaskDetailEvents({
  task,
  claimToken,
  reason,
  deferUntil,
  evidenceInput,
  busy,
  onReasonChange,
  onDeferUntilChange,
  onEvidenceInputChange,
  onSubmit,
}: TaskDetailEventsProps): ReactElement {
  return (
    <section>
      <h4>状态事件</h4>
      {!claimToken &&
      ALLOWED_EVENTS[task.status].some((event) => eventNeedsToken(event, task.status)) ? (
        <p className="warn-text">
          当前会话没有 claim_token。需要令牌的事件已禁用；可在任务行用同一 harness_id
          续租取回令牌，或让原认领方处理。
        </p>
      ) : null}

      <label className="field">
        <span>
          原因（block / fail / retry / defer / 标记隐患 必填；解除隐患可留空）
        </span>
        <textarea
          rows={3}
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
        />
      </label>
      <label className="field">
        <span>计划恢复时间（defer 可选）</span>
        <input
          type="datetime-local"
          value={deferUntil}
          onChange={(event) => onDeferUntilChange(event.target.value)}
        />
      </label>
      <label className="field">
        <span>证据卡 ID（complete 用，留空则复用已关联卡）</span>
        <input
          value={evidenceInput}
          placeholder="cd_xxx, cd_yyy；留空自动查找任务下的 status/artifact 卡"
          onChange={(event) => onEvidenceInputChange(event.target.value)}
        />
      </label>

      <div className="inline wrap">
        {ALLOWED_EVENTS[task.status].length === 0 ? (
          <span className="muted">终态任务没有状态事件；仍可补记或解除隐患。</span>
        ) : (
          <>
            {ALLOWED_EVENTS[task.status].map((event) => {
              const needsToken = eventNeedsToken(event, task.status);
              const disabled = busy !== null || (needsToken && !claimToken);
              return (
                <button
                  key={event}
                  type="button"
                  className={
                    event === 'fail' || event === 'cancel'
                      ? 'btn btn-small btn-danger'
                      : 'btn btn-small'
                  }
                  disabled={disabled}
                  onClick={() => onSubmit(event)}
                >
                  {busy === `event:${event}` ? '提交中…' : EVENT_LABELS[event]}
                </button>
              );
            })}
            {/*
              undefer 只在确实存在暂缓标记时出现。不放进 ALLOWED_EVENTS：
              那张表按状态生成，而“能否取消暂缓”取决于覆盖层是否有值。
            */}
            {task.defer_reason ? (
              <button
                type="button"
                className="btn btn-small btn-ghost"
                disabled={busy !== null}
                onClick={() => onSubmit('undefer')}
              >
                {busy === 'event:undefer' ? '提交中…' : EVENT_LABELS.undefer}
              </button>
            ) : null}
          </>
        )}
        {/*
          隐患是覆盖层，任何状态（包括 done/failed/cancelled）都能标记或解除，
          所以不放进按状态生成的 ALLOWED_EVENTS。终态任务最常见的场景恰恰是
          “已经完成，但回头发现留了坑”，按钮必须仍然可用。
        */}
        {task.risk_note && !task.risk_resolved_at ? (
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={busy !== null}
            onClick={() => onSubmit('unflag_risk')}
          >
            {busy === 'event:unflag_risk' ? '提交中…' : EVENT_LABELS.unflag_risk}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-small btn-danger"
            disabled={busy !== null}
            onClick={() => onSubmit('flag_risk')}
          >
            {busy === 'event:flag_risk' ? '提交中…' : EVENT_LABELS.flag_risk}
          </button>
        )}
      </div>
    </section>
  );
}
