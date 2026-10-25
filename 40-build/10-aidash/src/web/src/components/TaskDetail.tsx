import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Priority, TaskView } from '../types';
import { describeError } from '../api/client';
import { copyTask, getTask, moveTask, updateTask } from '../api/endpoints';
import { useAsync } from '../hooks/useAsync';
import { formatAbsolute, formatRelative, fromLocalInput, parseTagInput, shortId, toLocalInput } from '../lib/format';
import { openCard } from '../lib/router';
import { buildParentOptions, isSelfOrDescendant } from '../lib/task-tree';
import { EVENT_LABELS, REASON_EVENTS, eventNeedsToken } from '../lib/task-events';
import type { TaskEvent } from '../lib/task-events';
import {
  PriorityBadge,
  TaskDeferBadge,
  TaskKindBadge,
  TaskRiskBadge,
  TaskStatusBadge,
} from './Badge';
import { ErrorBox, Loading } from './Feedback';
import { Markdown } from './Markdown';
import { TaskDetailEditor } from './TaskDetailEditor';
import { TaskDetailEvents } from './TaskDetailEvents';
import { TaskDetailMoveCopy } from './TaskDetailMoveCopy';
import { TaskDetailTimeline } from './TaskDetailTimeline';
import { TaskFeed } from './TaskFeed';
import { useToast } from './Toast';

/** 只改覆盖层、不改 status 的事件：确认文案要避免“推进状态”的误导。 */
const OVERLAY_EVENTS: TaskEvent[] = ['defer', 'undefer', 'flag_risk', 'unflag_risk'];

/**
 * SCR-03 R3/R4：任务详情与状态事件。
 *
 * claim_token 由 TaskBoard 以内存 map 持有；本组件只消费，不持久化。
 * 没有 token 时“需要令牌”的事件直接禁用，而不是提交后让服务端报错。
 */
export function TaskDetail({
  taskId,
  tasks,
  claimToken,
  reloadNonce,
  onChanged,
  onOpenTask,
  onPrev,
  onNext,
  position,
  total,
  onClose,
  onUnreadChange,
}: {
  taskId: string;
  /** 当前通道的全部任务（扁平树序），用于“新父任务”下拉选项。 */
  tasks: TaskView[];
  claimToken: string | null;
  /** 父组件认领/释放后递增，用来强制拉取最新任务状态。 */
  reloadNonce: number;
  onChanged: () => void;
  /** 点击父任务时切到该任务详情；不传则父 ID 只读展示。 */
  onOpenTask?: (taskId: string) => void;
  /** 按可视任务树的顺序翻阅上一条/下一条；列表为空时不传。 */
  onPrev?: () => void;
  onNext?: () => void;
  /** 当前详情在可视列表里的位置（从 1 开始），用于显示“第 3 / 12 项”。 */
  position?: number;
  total?: number;
  onClose: () => void;
  /** 信息流逐条已读后通知任务树更新红点，不必整树重拉。 */
  onUnreadChange?: (taskId: string, unreadCount: number) => void;
}): ReactElement {
  const notify = useToast().notify;
  const editSectionRef = useRef<HTMLElement | null>(null);
  // 详情卡自己就是滚动容器；信息流的 IntersectionObserver 必须拿它当 root，
  // 否则会用整个视口判断可见性，列表在卡片右侧也会被误判为“看到了”。
  const dockRef = useRef<HTMLElement | null>(null);
  // 状态事件/保存字段后递增，让信息流重新拉一次（完成时可能刚新增证据卡）。
  const [feedNonce, setFeedNonce] = useState(0);
  const { data, loading, error, reload } = useAsync(
    () => getTask(taskId),
    [taskId, reloadNonce],
  );

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [assignee, setAssignee] = useState('');
  const [tags, setTags] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [parentId, setParentId] = useState('');
  const [reason, setReason] = useState('');
  // defer 专用：计划恢复时间。与 due_at 分开，允许“暂缓到下周但仍月底截止”。
  const [deferUntil, setDeferUntil] = useState('');
  const [evidenceInput, setEvidenceInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // 图片压缩期间不允许保存：否则提交的是插入图片之前的 description，
  // 用户会看到“保存成功”，但刚粘贴的截图没有进库。
  const [editorBusy, setEditorBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * 可选的“新父任务”列表。
   *
   * 用任务树的全量扁平列表而不是让用户手填 ID：手填既容易打错，
   * 也看不出目标在当前树的哪一层。选项里排除自身与后代，
   * 因为服务端会对这两个位置返回 TASK_CYCLE。
   */
  const parentOptions = useMemo(
    () => (data ? buildParentOptions(tasks, data.id) : []),
    [tasks, data],
  );

  useEffect(() => {
    if (!data) return;
    setTitle(data.title);
    setDescription(data.description_md ?? '');
    setCategory(data.category ?? '');
    setPriority(data.priority);
    setAssignee(data.assignee ?? '');
    setTags(data.tags.join(', '));
    setDueAt(toLocalInput(data.due_at));
    setParentId(data.parent_id ?? '');
    setReason('');
    setDeferUntil(toLocalInput(data.deferred_until));
    setEvidenceInput(data.evidence_ids.join(', '));
    setEditing(false);
    setFormError(null);
  }, [data]);

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setFormError(null);
    try {
      await action();
      // 成功动作后刷新信息流：complete 前必须已存在证据卡，
      // 用户刚发的事件/刚补的字段都可能对应一条新信息。
      setFeedNonce((value) => value + 1);
    } catch (cause) {
      const message = describeError(cause);
      setFormError(message);
      notify('error', message);
    } finally {
      setBusy(null);
    }
  };

  const savePatch = async (task: TaskView): Promise<void> => {
    if (!title.trim()) {
      setFormError('标题不能为空');
      return;
    }
    // 按钮已经禁用；这里再挡一次，覆盖“按回车/脚本触发”等绕过按钮状态的路径。
    if (editorBusy) {
      setFormError('图片仍在压缩，请等插入完成后再保存。');
      return;
    }
    await run('save', async () => {
      await updateTask(task.id, {
        patch: {
          title: title.trim(),
          description_md: description.trim() ? description : null,
          // 空串由服务端落成 NULL，任务树就不会出现空分类标签。
          category: category.trim() || null,
          priority,
          assignee: assignee.trim() || null,
          tags: parseTagInput(tags),
          due_at: fromLocalInput(dueAt),
        },
      });
      notify('success', '任务字段已更新');
      setEditing(false);
      reload();
      onChanged();
    });
  };

  const submitEvent = async (task: TaskView, event: TaskEvent): Promise<void> => {
    const tokenRequired = eventNeedsToken(event, task.status);
    if (tokenRequired && !claimToken) {
      setFormError('缺少 claim_token：请先在任务行认领/续租任务（令牌只保存在当前页面会话）。');
      return;
    }
    if (REASON_EVENTS.includes(event) && !reason.trim()) {
      setFormError(`${EVENT_LABELS[event]}必须填写原因`);
      return;
    }
    const evidenceIds = parseTagInput(evidenceInput);
    // “提交待认领”是草稿最常用的下一步，而且可逆（随时还能取消/暂缓）：
    // 每次点都弹确认只会让连续整理任务变慢。破坏性事件仍保留确认。
    if (event !== 'submit') {
      // 覆盖层事件（暂缓、隐患）不改变状态，不能沿用“推进为”的文案，
      // 否则用户会以为任务换了状态。
      // retry 也不是“推进”：它把 failed 任务放回待认领队列，说“推进为重新排队”很别扭，
      // 且容易让人以为任务在向前走；这里单独给出“重新排队”的确认文案。
      const confirmText =
        event === 'retry'
          ? '确认把任务重新排队？'
          : OVERLAY_EVENTS.includes(event)
            ? `确认「${EVENT_LABELS[event]}」？`
            : `确认将任务状态推进为「${EVENT_LABELS[event]}」？`;
      if (!window.confirm(confirmText)) return;
    }

    await run(`event:${event}`, async () => {
      await updateTask(task.id, {
        event,
        claim_token: tokenRequired ? (claimToken ?? undefined) : undefined,
        reason: reason.trim() || undefined,
        // 只有 defer 携带计划恢复时间；其他事件即使输入框有值也不应写入。
        deferred_until: event === 'defer' ? fromLocalInput(deferUntil) : undefined,
        // 留空时服务端会复用该任务下已关联的 status/artifact 卡；
        // 两者都没有时才返回 EVIDENCE_REQUIRED，由错误提示引导补卡。
        evidence_card_ids:
          event === 'complete' && evidenceIds.length > 0 ? evidenceIds : undefined,
      });
      notify('success', `任务事件已提交：${EVENT_LABELS[event]}`);
      setReason('');
      reload();
      onChanged();
    });
  };

  /** 下拉里选中的父任务；空字符串代表根节点。 */
  const selectedParent = (task: TaskView): TaskView | null => {
    const id = parentId.trim();
    if (!id) return null;
    return tasks.find((item) => item.id === id) ?? null;
  };

  const move = async (task: TaskView): Promise<void> => {
    const target = selectedParent(task);
    // 下拉已经排除了非法项；这里再挡一次，覆盖“数据刚变化、选项尚未刷新”的窗口。
    if (target && isSelfOrDescendant(target.path, task.path)) {
      setFormError('不能把任务移动到它自己或它的后代下面');
      return;
    }
    if (
      !window.confirm(
        `确认把任务移动到 ${target ? `「${target.title}」` : '根节点'}？所有子任务会一起移动。`,
      )
    ) {
      return;
    }
    await run('move', async () => {
      await moveTask(task.id, target?.id ?? null);
      notify('success', '任务层级已移动');
      reload();
      onChanged();
    });
  };

  const copy = async (task: TaskView): Promise<void> => {
    const target = selectedParent(task);
    if (target && isSelfOrDescendant(target.path, task.path)) {
      setFormError('不能把任务复制到它自己或它的后代下面');
      return;
    }
    if (!window.confirm('复制会创建整棵子树的副本，确认继续？')) return;
    await run('copy', async () => {
      const result = await copyTask(task.id, target?.id ?? null);
      notify(
        'success',
        `已复制 ${result.copied} 个任务节点，新根任务 ${shortId(result.task.id)}`,
      );
      onChanged();
    });
  };

  // 顶部“编辑”按钮打开编辑区后把它滚进视野：编辑区在详情底部，
  // 不滚动的话用户会以为按钮没反应（尤其是详情自己是一个滚动容器时）。
  const toggleEditing = (): void => {
    const next = !editing;
    setEditing(next);
    if (next) {
      requestAnimationFrame(() => {
        editSectionRef.current?.scrollIntoView({ block: 'nearest' });
      });
    }
  };

  return (
    <aside className="task-detail task-detail-dock" aria-label="任务详情" ref={dockRef}>
      <header className="panel-header task-detail-header">
        <h3>任务详情</h3>
        <div className="inline task-detail-nav">
          <button
            type="button"
            className={editing ? 'btn btn-small' : 'btn btn-small btn-ghost'}
            aria-pressed={editing}
            onClick={toggleEditing}
          >
            {editing ? '收起编辑' : '编辑'}
          </button>
          {position && total ? (
            <span className="muted small" title="按当前任务树的可视顺序">
              {position} / {total}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-small btn-ghost"
            title="上一条任务（←）"
            aria-label="上一条任务"
            disabled={!onPrev || (total ?? 0) === 0}
            onClick={onPrev}
          >
            ← 上一条
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            title="下一条任务（→）"
            aria-label="下一条任务"
            disabled={!onNext || (total ?? 0) === 0}
            onClick={onNext}
          >
            下一条 →
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>
            收起
          </button>
        </div>
      </header>

      {loading && !data ? <Loading label="加载任务…" /> : null}
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}

      {data ? (
        <>
          <div className="drawer-badges">
            <TaskStatusBadge status={data.status} />
            {data.defer_reason ? (
              <TaskDeferBadge reason={data.defer_reason} until={data.deferred_until} />
            ) : null}
            {/* 详情里已解除的隐患也显示：复盘要能看到“曾经带病完成、后来补上了”。 */}
            {data.risk_note ? (
              <TaskRiskBadge
                note={data.risk_note}
                resolved={data.risk_resolved_at !== null}
                resolvedAt={data.risk_resolved_at}
              />
            ) : null}
            <TaskKindBadge kind={data.kind} />
            {data.category ? <span className="tag">分类 {data.category}</span> : null}
            <PriorityBadge priority={data.priority} />
            <a
              className="tag"
              href={`#/c/${encodeURIComponent(data.channel_key)}`}
              title="打开该通道"
            >
              {data.channel_key}
            </a>
            {data.assignee ? <span className="tag">负责人 {data.assignee}</span> : null}
          </div>
          <h2 className="drawer-title">{data.title}</h2>
          <p className="muted small" title={data.id}>
            {shortId(data.id)} · 层级 {data.path} · 更新 {formatRelative(data.updated_at)}
            {data.due_at ? ` · 到期 ${formatAbsolute(data.due_at)}` : ''}
          </p>
          <p className="muted small">
            {data.claimed_by ? `认领人 ${data.claimed_by}` : '尚未认领'}
            {data.claim_expires_at ? ` · 租约至 ${formatAbsolute(data.claim_expires_at)}` : ''}
            {' · '}
            {data.parent_id ? (
              onOpenTask ? (
                <button
                  type="button"
                  className="link-button"
                  title={data.parent_id}
                  onClick={() => onOpenTask(data.parent_id ?? '')}
                >
                  父任务 {shortId(data.parent_id)}
                </button>
              ) : (
                <span title={data.parent_id}>父任务 {shortId(data.parent_id)}</span>
              )
            ) : (
              '根任务'
            )}
          </p>

          {data.description_md ? <Markdown source={data.description_md} /> : null}

          <TaskDetailTimeline task={data} />

          {data.evidence_ids.length > 0 ? (
            <section>
              <h4>完成证据</h4>
              <div className="inline wrap">
                {data.evidence_ids.map((cardId) => (
                  <button
                    key={cardId}
                    type="button"
                    className="link-button"
                    onClick={() => openCard(cardId)}
                  >
                    卡片 {shortId(cardId)}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {/*
            信息流放在编辑区之前：用户“翻到下方”时先遇到消息，
            而不是先经过一堆表单再看到未读。滚动容器是整张详情卡。
          */}
          <TaskFeed
            taskId={data.id}
            rootRef={dockRef}
            onUnreadChange={onUnreadChange}
            reloadNonce={feedNonce}
          />

          <TaskDetailEditor
            editing={editing}
            editSectionRef={editSectionRef}
            title={title}
            category={category}
            priority={priority}
            assignee={assignee}
            tags={tags}
            dueAt={dueAt}
            description={description}
            busy={busy}
            editorBusy={editorBusy}
            onToggle={toggleEditing}
            onSave={() => void savePatch(data)}
            onTitleChange={setTitle}
            onCategoryChange={setCategory}
            onPriorityChange={setPriority}
            onAssigneeChange={setAssignee}
            onTagsChange={setTags}
            onDueAtChange={setDueAt}
            onDescriptionChange={setDescription}
            onEditorBusyChange={setEditorBusy}
          />

          <TaskDetailEvents
            task={data}
            claimToken={claimToken}
            reason={reason}
            deferUntil={deferUntil}
            evidenceInput={evidenceInput}
            busy={busy}
            onReasonChange={setReason}
            onDeferUntilChange={setDeferUntil}
            onEvidenceInputChange={setEvidenceInput}
            onSubmit={(event) => void submitEvent(data, event)}
          />

          <TaskDetailMoveCopy
            parentId={parentId}
            parentOptions={parentOptions}
            busy={busy}
            onParentChange={setParentId}
            onMove={() => void move(data)}
            onCopy={() => void copy(data)}
          />

          {formError ? (
            <div className="error-box" role="alert">
              {formError}
            </div>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}
