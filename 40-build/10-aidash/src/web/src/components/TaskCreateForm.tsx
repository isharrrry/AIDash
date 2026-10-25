import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { Priority, TaskView } from '../types';
import { describeError } from '../api/client';
import { createTask } from '../api/endpoints';
import { fromLocalInput, parseTagInput } from '../lib/format';
import { MarkdownEditor } from './MarkdownEditor';
import { useToast } from './Toast';

/**
 * 新建任务表单。
 *
 * 默认 submit=true：用户在网页上填完通常期望它可被认领；
 * 若想保留草稿，取消勾选即可（服务端创建后是 draft）。
 */
export function TaskCreateForm({
  channelKey,
  parents,
  onCreated,
  onCancel,
}: {
  channelKey: string;
  parents: TaskView[];
  onCreated: (task: TaskView) => void;
  onCancel: () => void;
}): ReactElement {
  const notify = useToast().notify;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');
  // 分类是单值归属，不是 tags；留空表示暂不分类。
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [assignee, setAssignee] = useState('');
  const [tags, setTags] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [submit, setSubmit] = useState(true);
  const [busy, setBusy] = useState(false);
  // 图片压缩是异步的：这期间提交会创建一条不含截图的旧描述，必须等插入完成。
  const [editorBusy, setEditorBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitForm = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!title.trim()) {
      setError('标题不能为空');
      return;
    }
    if (editorBusy) {
      setError('图片仍在压缩，请等插入完成后再创建任务。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createTask({
        channel_key: channelKey,
        title: title.trim(),
        description_md: description.trim() ? description : null,
        parent_id: parentId || null,
        category: category.trim() || null,
        priority,
        assignee: assignee.trim() || null,
        tags: parseTagInput(tags),
        due_at: fromLocalInput(dueAt),
        submit,
      });
      notify('success', submit ? '任务已创建并提交' : '任务草稿已创建');
      setTitle('');
      setDescription('');
      setParentId('');
      setCategory('');
      setTags('');
      setDueAt('');
      onCreated(result.task);
    } catch (cause) {
      const message = describeError(cause);
      setError(message);
      notify('error', `创建任务失败：${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel create-task" onSubmit={(event) => void submitForm(event)}>
      <header className="panel-header">
        <h3>新建任务</h3>
        <span className="muted small">通道 {channelKey}</span>
      </header>

      <div className="form-grid">
        <label className="field">
          <span>标题（必填）</span>
          <input
            value={title}
            maxLength={200}
            placeholder="一句话说明要完成什么"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="field">
          <span>父任务</span>
          <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
            <option value="">（根任务）</option>
            {parents.map((task) => (
              <option key={task.id} value={task.id}>
                {task.path} · {task.title}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>分类</span>
          <input
            value={category}
            maxLength={40}
            placeholder="如 功能 / 缺陷 / 维护（可选，单值）"
            onChange={(event) => setCategory(event.target.value)}
          />
        </label>

        <label className="field">
          <span>优先级</span>
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority)}
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
            placeholder="可选，字符串标识"
            onChange={(event) => setAssignee(event.target.value)}
          />
        </label>

        <label className="field">
          <span>标签（逗号/空格分隔）</span>
          <input value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>

        <label className="field">
          <span>到期时间</span>
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </label>

        <div className="field field-full">
          <MarkdownEditor
            value={description}
            onChange={setDescription}
            rows={5}
            label="描述（Markdown，可粘贴截图）"
            onBusyChange={setEditorBusy}
          />
        </div>

        <label className="check inline-check">
          <input
            type="checkbox"
            checked={submit}
            onChange={(event) => setSubmit(event.target.checked)}
          />
          创建后立即提交（pending，可被认领）
        </label>
      </div>

      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}

      <div className="inline">
        <button
          type="submit"
          className="btn btn-primary btn-small"
          disabled={busy || editorBusy}
        >
          {busy ? '创建中…' : editorBusy ? '图片处理中…' : '创建任务'}
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={onCancel}>
          收起
        </button>
      </div>
    </form>
  );
}
