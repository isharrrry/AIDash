import type { ReactElement, RefObject } from 'react';
import type { Priority } from '../types';
import { MarkdownEditor } from './MarkdownEditor';

export interface TaskDetailEditorProps {
  editing: boolean;
  editSectionRef: RefObject<HTMLElement | null>;
  title: string;
  category: string;
  priority: Priority;
  assignee: string;
  tags: string;
  dueAt: string;
  description: string;
  busy: string | null;
  editorBusy: boolean;
  onToggle: () => void;
  onSave: () => void;
  onTitleChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onPriorityChange: (value: Priority) => void;
  onAssigneeChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  onDueAtChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onEditorBusyChange: (value: boolean) => void;
}

/** 任务字段编辑区。字段状态由 TaskDetail 持有，这里只负责渲染与回传输入。 */
export function TaskDetailEditor({
  editing,
  editSectionRef,
  title,
  category,
  priority,
  assignee,
  tags,
  dueAt,
  description,
  busy,
  editorBusy,
  onToggle,
  onSave,
  onTitleChange,
  onCategoryChange,
  onPriorityChange,
  onAssigneeChange,
  onTagsChange,
  onDueAtChange,
  onDescriptionChange,
  onEditorBusyChange,
}: TaskDetailEditorProps): ReactElement {
  return (
    <section ref={editSectionRef}>
      <div className="panel-header">
        <h4>编辑字段</h4>
        <button type="button" className="btn btn-small" onClick={onToggle}>
          {editing ? '收起编辑' : '编辑'}
        </button>
      </div>

      {editing ? (
        <div className="form-grid">
          <label className="field">
            <span>标题</span>
            <input value={title} onChange={(event) => onTitleChange(event.target.value)} />
          </label>
          <label className="field">
            <span>分类</span>
            <input
              value={category}
              maxLength={40}
              placeholder="如 功能 / 缺陷 / 维护（留空表示未分类）"
              onChange={(event) => onCategoryChange(event.target.value)}
            />
          </label>
          <label className="field">
            <span>优先级</span>
            <select
              value={priority}
              onChange={(event) => onPriorityChange(event.target.value as Priority)}
            >
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </select>
          </label>
          <label className="field">
            <span>负责人</span>
            <input
              value={assignee}
              placeholder="留空表示未指派"
              onChange={(event) => onAssigneeChange(event.target.value)}
            />
          </label>
          <label className="field">
            <span>标签（逗号分隔）</span>
            <input value={tags} onChange={(event) => onTagsChange(event.target.value)} />
          </label>
          <label className="field">
            <span>到期时间</span>
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(event) => onDueAtChange(event.target.value)}
            />
          </label>
          <div className="field field-full">
            <MarkdownEditor
              value={description}
              onChange={onDescriptionChange}
              rows={10}
              disabled={busy !== null}
              onBusyChange={onEditorBusyChange}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={busy !== null || editorBusy}
            onClick={onSave}
          >
            {busy === 'save' ? '保存中…' : editorBusy ? '图片处理中…' : '保存字段'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
