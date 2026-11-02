import { useState } from 'react';
import type { ReactElement } from 'react';
import { describeError } from '../api/client';
import { createTask } from '../api/endpoints';
import { shortId, TASK_KIND_LABELS, TASK_STATUS_LABELS } from '../lib/format';
import {
  findOversizedTitle,
  MAX_CHILD_LINES,
  MAX_CHILD_TITLE,
  parseChildTitles,
} from '../lib/task-discussion';
import type { TaskAncestorView, TaskKind, TaskView } from '../types';
import { Markdown } from './Markdown';
import { useToast } from './Toast';

/**
 * 讨论任务在详情页的三块专用 UI：
 *
 * 1. 父链上下文：每层讨论都必须能回看上层的原始问题与已得结论；
 * 2. 讨论结论：harness 的大白话回答，置顶展示，不再埋在信息流里；
 * 3. 批量拆子讨论：一行一个问题，默认创建待认领的讨论子任务。
 *
 * 拆成独立文件而不是继续膨胀 TaskDetail：详情页已经承担编辑、状态事件、
 * 移动复制和信息流，讨论相关逻辑有自己的交互规则，单独维护更清楚。
 */

/** 父链面包屑 + 每层的可展开原文/结论。根在最左，直接父任务在最右。 */
export function TaskAncestors({
  ancestors,
  onOpenTask,
}: {
  ancestors: TaskAncestorView[];
  onOpenTask?: (taskId: string) => void;
}): ReactElement | null {
  if (ancestors.length === 0) return null;
  return (
    <section className="task-ancestors" aria-label="父级讨论上下文">
      <h4>讨论上下文</h4>
      <div className="task-ancestor-chain">
        {ancestors.map((ancestor, index) => (
          <span className="task-ancestor-item" key={ancestor.id}>
            {index > 0 ? <span className="muted small">›</span> : null}
            {onOpenTask ? (
              <button
                type="button"
                className="link-button"
                title={`打开父任务 ${ancestor.id}`}
                onClick={() => onOpenTask(ancestor.id)}
              >
                {ancestor.title}
              </button>
            ) : (
              <span>{ancestor.title}</span>
            )}
            <span className="tag">{TASK_KIND_LABELS[ancestor.kind]}</span>
          </span>
        ))}
      </div>
      <div className="task-ancestor-details">
        {ancestors.map((ancestor) => (
          // 直接父任务默认展开：子讨论最需要看到的就是上一层的原始问题与结论；
          // 更远的祖先折叠，避免详情页被整条讨论链路撑满。
          <details
            key={ancestor.id}
            className="task-ancestor-detail"
            open={ancestor.depth === 1}
          >
            <summary>
              第 {ancestor.depth} 层 · {ancestor.title}
              <span className="muted small">
                {' '}
                （{TASK_KIND_LABELS[ancestor.kind]} ·{' '}
                {TASK_STATUS_LABELS[ancestor.status] ?? ancestor.status}）
              </span>
            </summary>
            {ancestor.description_md ? (
              <Markdown source={ancestor.description_md} />
            ) : (
              <p className="muted small">（该层没有描述）</p>
            )}
            {ancestor.discussion_answer_md ? (
              <div className="task-ancestor-answer">
                <h5>上级结论</h5>
                <Markdown source={ancestor.discussion_answer_md} />
              </div>
            ) : null}
          </details>
        ))}
      </div>
    </section>
  );
}

/** 讨论结论：这是讨论任务的主产物，放在描述之后、时间线之前。 */
export function TaskDiscussionAnswer({
  answer,
  answeredAt,
}: {
  answer: string | null;
  answeredAt: string | null;
}): ReactElement | null {
  if (!answer?.trim()) return null;
  return (
    <section className="task-discussion-answer" aria-label="讨论结论">
      <header className="task-discussion-answer-head">
        <h4>讨论结论</h4>
        {answeredAt ? (
          <span className="muted small">写入 {new Date(answeredAt).toLocaleString()}</span>
        ) : null}
      </header>
      <Markdown source={answer} />
    </section>
  );
}

/**
 * 批量拆子任务。
 *
 * 两个默认值直接对应用户的诉求：
 * - 讨论任务下默认创建“讨论”子任务（也可以手动改成任务/建议）；
 * - 默认立即提交为 pending（待认领），否则拆出来的只是一堆草稿，agent 看不到。
 *
 * 每行一个问题，避免让用户为一个问题重复点十次“新建任务”。空行忽略；
 * 行首的 `- ` / `* ` / `1. ` 列表标记会被剥掉，方便用户直接从 Markdown 粘贴。
 */
export function TaskDiscussionChildren({
  task,
  onChanged,
}: {
  task: TaskView;
  onChanged: () => void;
}): ReactElement {
  const notify = useToast().notify;
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<TaskKind>(
    task.kind === 'discussion' ? 'discussion' : 'task',
  );
  const [submit, setSubmit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titles = parseChildTitles(draft);
  const tooLong = findOversizedTitle(titles);
  const tooMany = titles.length > MAX_CHILD_LINES;

  const createChildren = async (): Promise<void> => {
    if (titles.length === 0) {
      setError('请先写至少一个子问题（每行一个）');
      return;
    }
    if (tooLong) {
      setError(`标题不能超过 ${MAX_CHILD_TITLE} 字：${tooLong.slice(0, 40)}…`);
      return;
    }
    if (tooMany) {
      setError(`一次最多创建 ${MAX_CHILD_LINES} 个子任务`);
      return;
    }

    setBusy(true);
    setError(null);
    const failed: string[] = [];
    let created = 0;
    // 串行创建：顺序与用户输入一致，也避免瞬间打满服务端限流。
    for (const title of titles) {
      try {
        await createTask({
          channel_key: task.channel_key,
          parent_id: task.id,
          title,
          kind,
          submit,
        });
        created += 1;
      } catch (cause) {
        failed.push(`${title}：${describeError(cause)}`);
      }
    }
    setBusy(false);

    if (created > 0) {
      notify(
        'success',
        `已创建 ${created} 个${TASK_KIND_LABELS[kind]}子任务${submit ? '（待认领）' : '（草稿）'}`,
      );
      setDraft(failed.length > 0 ? failed.map((item) => item.split('：')[0]).join('\n') : '');
      onChanged();
    }
    if (failed.length > 0) {
      const message = `${failed.length} 个创建失败：${failed.join('；')}`;
      setError(message);
      notify('error', message);
    }
  };

  return (
    <section className="task-discussion-children" aria-label="批量创建子任务">
      <h4>快速拆分子任务</h4>
      <p className="muted small">
        每行一个问题；默认创建“{TASK_KIND_LABELS[kind]}”子任务并立即提交为待认领。
        子任务执行时会自动带上本任务的讨论上下文。
      </p>
      <label className="field">
        <span>子问题（每行一个，最多 {MAX_CHILD_LINES} 行）</span>
        <textarea
          rows={4}
          value={draft}
          placeholder={'例如：\n- 这个方案最大的风险是什么？\n- 如果不做改动，会有什么后果？'}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
        />
      </label>
      <div className="inline wrap">
        <label className="field">
          <span>子任务类型</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as TaskKind)}
          >
            <option value="discussion">讨论（默认）</option>
            <option value="task">任务</option>
            <option value="suggestion">建议</option>
          </select>
        </label>
        <label className="check inline-check">
          <input
            type="checkbox"
            checked={submit}
            onChange={(event) => setSubmit(event.target.checked)}
          />
          创建后立即提交（pending，可被认领）
        </label>
      </div>
      <div className="inline wrap">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={busy || titles.length === 0}
          onClick={() => void createChildren()}
        >
          {busy
            ? '创建中…'
            : `创建 ${titles.length} 个${TASK_KIND_LABELS[kind]}子任务`}
        </button>
        <span className="muted small">
          将挂在 {shortId(task.id)} 下 · 通道 {task.channel_key}
        </span>
      </div>
      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
