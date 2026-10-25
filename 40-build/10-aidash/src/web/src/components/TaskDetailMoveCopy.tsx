import type { ReactElement } from 'react';
import { shortId } from '../lib/format';
import type { TaskParentOption } from '../lib/task-tree';

export interface TaskDetailMoveCopyProps {
  parentId: string;
  parentOptions: TaskParentOption[];
  busy: string | null;
  onParentChange: (value: string) => void;
  onMove: () => void;
  onCopy: () => void;
}

/** 移动/复制区：选项已排除自身与后代，服务端仍会做最终环校验。 */
export function TaskDetailMoveCopy({
  parentId,
  parentOptions,
  busy,
  onParentChange,
  onMove,
  onCopy,
}: TaskDetailMoveCopyProps): ReactElement {
  return (
    <section>
      <h4>移动 / 复制</h4>
      <label className="field">
        <span>新父任务（下拉选择，已排除自身与后代）</span>
        <select
          value={parentId}
          onChange={(event) => onParentChange(event.target.value)}
        >
          <option value="">（根节点）</option>
          {parentOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label} · {shortId(option.id)}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        也可以直接在左侧任务树里按住任务名拖动到目标任务上，成为它的子任务。
      </p>
      <div className="inline wrap">
        <button
          type="button"
          className="btn btn-small"
          disabled={busy !== null}
          onClick={onMove}
        >
          {busy === 'move' ? '移动中…' : '移动到所选父节点'}
        </button>
        <button
          type="button"
          className="btn btn-small btn-ghost"
          disabled={busy !== null}
          onClick={onCopy}
        >
          {busy === 'copy' ? '复制中…' : '复制子树到所选父节点'}
        </button>
      </div>
    </section>
  );
}
