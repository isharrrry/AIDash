import type { ReactElement } from 'react';
import { TASK_STATUS_LABELS } from '../lib/format';
import type { HarnessView, TaskStatus } from '../types';

const ALL_STATUSES: TaskStatus[] = [
  'draft',
  'pending',
  'claimed',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
];

export interface TaskBoardToolbarProps {
  keyword: string;
  onKeywordChange: (value: string) => void;
  onKeywordClear: () => void;
  harnessId: string;
  harnesses: HarnessView[];
  onHarnessChange: (value: string) => void;
  assignee: string;
  onAssigneeChange: (value: string) => void;
  statuses: TaskStatus[];
  onToggleStatus: (status: TaskStatus) => void;
}

/** 搜索、harness、负责人与状态 chip 的筛选工具栏。状态本身仍由 TaskBoard 管理。 */
export function TaskBoardToolbar({
  keyword,
  onKeywordChange,
  onKeywordClear,
  harnessId,
  harnesses,
  onHarnessChange,
  assignee,
  onAssigneeChange,
  statuses,
  onToggleStatus,
}: TaskBoardToolbarProps): ReactElement {
  return (
    <div className="task-toolbar">
      <label className="field task-search-field">
        <span>搜索任务</span>
        <input
          type="search"
          value={keyword}
          placeholder="标题 / 分类 / ID / 负责人 / 标签"
          aria-label="按关键字搜索任务"
          onChange={(event) => onKeywordChange(event.target.value)}
          onKeyDown={(event) => {
            // Esc 清空而不是退出搜索：用户常见的动作是“搜错了重来”。
            if (event.key === 'Escape') {
              event.preventDefault();
              onKeywordClear();
            }
          }}
        />
      </label>

      <label className="field">
        <span>harness_id（认领用）</span>
        <input
          value={harnessId}
          list="task-harness-options"
          placeholder="例如 win-dev-01"
          onChange={(event) => onHarnessChange(event.target.value)}
        />
        <datalist id="task-harness-options">
          {harnesses.map((harness) => (
            <option key={harness.harness_id} value={harness.harness_id}>
              {harness.name}
            </option>
          ))}
        </datalist>
      </label>

      <label className="field">
        <span>负责人筛选</span>
        <input
          value={assignee}
          placeholder="模糊匹配"
          onChange={(event) => onAssigneeChange(event.target.value)}
        />
      </label>

      <div className="filter-block grow">
        <span className="filter-label">状态</span>
        <div className="chip-group" role="group">
          {ALL_STATUSES.map((status) => {
            const active = statuses.includes(status);
            return (
              <button
                key={status}
                type="button"
                className={active ? 'chip active' : 'chip'}
                aria-pressed={active}
                onClick={() => onToggleStatus(status)}
              >
                {TASK_STATUS_LABELS[status]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
