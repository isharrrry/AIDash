import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Priority, TaskView } from '../types';
import { describeError } from '../api/client';
import { copyTask, getTask, moveTask, updateTask } from '../api/endpoints';
import { useAsync } from '../hooks/useAsync';
import { formatAbsolute, formatRelative, fromLocalInput, parseTagInput, shortId, toLocalInput } from '../lib/format';
import { openCard } from '../lib/router';
import { buildParentOptions, isSelfOrDescendant } from '../lib/task-tree';
import {
  ALLOWED_EVENTS,
  EVENT_LABELS,
  REASON_EVENTS,
  eventNeedsToken,
} from '../lib/task-events';
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
import { MarkdownEditor } from './MarkdownEditor';
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
      const confirmText = OVERLAY_EVENTS.includes(event)
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

  const timeline = data ? timelineEntries(data) : [];

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
            {data.blocked_reason ? (
              <div className="reason-box">
                <strong>阻塞原因</strong>
                <p>{data.blocked_reason}</p>
              </div>
            ) : null}
            {data.fail_reason ? (
              <div className="reason-box reason-box-danger">
                <strong>失败原因</strong>
                <p>{data.fail_reason}</p>
              </div>
            ) : null}
            {/* 取消也必须有原由：否则看板上只剩一个“已取消”，无法判断是重复、误建还是判断错误。 */}
            {data.cancel_reason ? (
              <div className="reason-box">
                <strong>取消原因</strong>
                <p>{data.cancel_reason}</p>
              </div>
            ) : null}
            {data.defer_reason ? (
              <div className="reason-box">
                <strong>暂缓 / 排期</strong>
                <p>{data.defer_reason}</p>
                <p className="muted small">
                  {data.deferred_until
                    ? `计划恢复：${formatAbsolute(data.deferred_until)}`
                    : '未设定计划恢复时间'}
                  {data.deferred_at ? ` · 标记于 ${formatAbsolute(data.deferred_at)}` : ''}
                </p>
              </div>
            ) : null}
            {/*
              隐患不随任务完成而消失：它回答的是“这次收口打了什么折扣”。
              解除后保留 note 原文，只把状态改成已解除，复盘才能对照当时的判断。
            */}
            {data.risk_note ? (
              <div className={data.risk_resolved_at ? 'reason-box' : 'reason-box reason-box-danger'}>
                <strong>{data.risk_resolved_at ? '隐患（已解除）' : '隐患（未解除）'}</strong>
                <p>{data.risk_note}</p>
                {data.risk_resolution ? (
                  <p className="muted small">复盘结论：{data.risk_resolution}</p>
                ) : null}
                <p className="muted small">
                  {data.risk_flagged_at
                    ? `标记于 ${formatAbsolute(data.risk_flagged_at)}`
                    : '标记时间未知'}
                  {data.risk_resolved_at
                    ? ` · 解除于 ${formatAbsolute(data.risk_resolved_at)}`
                    : ' · 仍未解除'}
                </p>
              </div>
            ) : null}
          </section>

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

          <section ref={editSectionRef}>
            <div className="panel-header">
              <h4>编辑字段</h4>
              <button type="button" className="btn btn-small" onClick={toggleEditing}>
                {editing ? '收起编辑' : '编辑'}
              </button>
            </div>

            {editing ? (
              <div className="form-grid">
                <label className="field">
                  <span>标题</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} />
                </label>
                <label className="field">
                  <span>分类</span>
                  <input
                    value={category}
                    maxLength={40}
                    placeholder="如 功能 / 缺陷 / 维护（留空表示未分类）"
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
                    placeholder="留空表示未指派"
                    onChange={(event) => setAssignee(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>标签（逗号分隔）</span>
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
                    rows={10}
                    disabled={busy !== null}
                    onBusyChange={setEditorBusy}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  disabled={busy !== null || editorBusy}
                  onClick={() => void savePatch(data)}
                >
                  {busy === 'save' ? '保存中…' : editorBusy ? '图片处理中…' : '保存字段'}
                </button>
              </div>
            ) : null}
          </section>

          <section>
            <h4>状态事件</h4>
            {!claimToken &&
            ALLOWED_EVENTS[data.status].some((event) => eventNeedsToken(event, data.status)) ? (
              <p className="warn-text">
                当前会话没有 claim_token。需要令牌的事件已禁用；可在任务行用同一 harness_id
                续租取回令牌，或让原认领方处理。
              </p>
            ) : null}

            <label className="field">
              <span>原因（block / fail / defer / 标记隐患 必填；解除隐患可留空）</span>
              <textarea
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label className="field">
              <span>计划恢复时间（defer 可选）</span>
              <input
                type="datetime-local"
                value={deferUntil}
                onChange={(event) => setDeferUntil(event.target.value)}
              />
            </label>
            <label className="field">
              <span>证据卡 ID（complete 用，留空则复用已关联卡）</span>
              <input
                value={evidenceInput}
                placeholder="cd_xxx, cd_yyy；留空自动查找任务下的 status/artifact 卡"
                onChange={(event) => setEvidenceInput(event.target.value)}
              />
            </label>

            <div className="inline wrap">
              {ALLOWED_EVENTS[data.status].length === 0 ? (
                <span className="muted">终态任务没有状态事件；仍可补记或解除隐患。</span>
              ) : (
                <>
                  {ALLOWED_EVENTS[data.status].map((event) => {
                    const needsToken = eventNeedsToken(event, data.status);
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
                        onClick={() => void submitEvent(data, event)}
                      >
                        {busy === `event:${event}` ? '提交中…' : EVENT_LABELS[event]}
                      </button>
                    );
                  })}
                  {/*
                    undefer 只在确实存在暂缓标记时出现。不放进 ALLOWED_EVENTS：
                    那张表按状态生成，而“能否取消暂缓”取决于覆盖层是否有值。
                  */}
                  {data.defer_reason ? (
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      disabled={busy !== null}
                      onClick={() => void submitEvent(data, 'undefer')}
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
              {data.risk_note && !data.risk_resolved_at ? (
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  disabled={busy !== null}
                  onClick={() => void submitEvent(data, 'unflag_risk')}
                >
                  {busy === 'event:unflag_risk' ? '提交中…' : EVENT_LABELS.unflag_risk}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  disabled={busy !== null}
                  onClick={() => void submitEvent(data, 'flag_risk')}
                >
                  {busy === 'event:flag_risk' ? '提交中…' : EVENT_LABELS.flag_risk}
                </button>
              )}
            </div>
          </section>

          <section>
            <h4>移动 / 复制</h4>
            <label className="field">
              <span>新父任务（下拉选择，已排除自身与后代）</span>
              <select
                value={parentId}
                onChange={(event) => setParentId(event.target.value)}
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
                onClick={() => void move(data)}
              >
                {busy === 'move' ? '移动中…' : '移动到所选父节点'}
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                disabled={busy !== null}
                onClick={() => void copy(data)}
              >
                {busy === 'copy' ? '复制中…' : '复制子树到所选父节点'}
              </button>
            </div>
          </section>

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

interface TimelineEntry {
  label: string;
  value: string;
}

/**
 * 状态时间线只列“真正发生过”的节点。
 *
 * created_at / updated_at 一定有值；其余字段由 task-service 在状态事件里写入，
 * 为空表示该事件没发生过。不能拿 updated_at 去补，否则会伪造一个不存在的时间点。
 */
function timelineEntries(task: TaskView): TimelineEntry[] {
  const candidates: Array<{ label: string; value: string | null }> = [
    { label: '创建', value: task.created_at },
    { label: '认领', value: task.claimed_at },
    { label: '开始', value: task.started_at },
    { label: '阻塞', value: task.blocked_at },
    { label: '暂缓', value: task.deferred_at },
    { label: '隐患标记', value: task.risk_flagged_at },
    { label: '隐患解除', value: task.risk_resolved_at },
    { label: '完成', value: task.completed_at },
    { label: '失败', value: task.failed_at },
    { label: '取消', value: task.cancelled_at },
    { label: '更新', value: task.updated_at },
  ];

  const entries: TimelineEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.value) entries.push({ label: candidate.label, value: candidate.value });
  }
  // 不能按固定生命周期顺序展示：隐患允许在任务完成/取消之后补记，
  // 固定顺序会把“完成后的隐患标记”排到“完成”上方，读起来像时间倒流。
  // ISO 时间可直接字典序比较；同刻保持上面的稳定顺序。
  return entries.sort((a, b) => a.value.localeCompare(b.value));
}
