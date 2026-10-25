import { useState } from 'react';
import type { CSSProperties, DragEvent, KeyboardEvent, ReactElement } from 'react';
import type { CardView, TaskStatus, TreeNode } from '../types';
import {
  CARD_STATUS_LABELS,
  formatAbsolute,
  formatRelative,
  shortId,
  taskStatusTime,
} from '../lib/format';
import { canMoveTask } from '../lib/task-tree';
// 排序是纯数据逻辑，放在 lib 里便于单测；这里继续导出，TaskBoard 的导入路径不变。
import { sortTree } from '../lib/task-tree';
export { sortTree };
import {
  PriorityBadge,
  TaskDeferBadge,
  TaskKindBadge,
  TaskLeftoverBadge,
  TaskRiskBadge,
  TaskStatusBadge,
} from './Badge';
import { MarkdownInline } from './Markdown';

const RELEASABLE: TaskStatus[] = ['claimed', 'in_progress', 'blocked'];

/**
 * SCR-03 任务树：递归渲染任意层级。
 *
 * 任务是“树”而不是列表：子任务只有挂在父任务下才有上下文。
 * 移动/复制会改层级，但仍由 TaskBoard 触发，树组件保持纯展示。
 *
 * 列头的存在是为了回答“这一列是什么”：
 * 旧版每行靠徽标颜色猜含义，类型、状态、优先级挤在一起，新用户看不懂。
 * 现在类型、分类、状态、优先级各占一列；标题列承担层级缩进，其余列保持对齐。
 */
export function TaskTree({
  nodes,
  tokens,
  busyId,
  harnessId,
  activeTaskId,
  questionsByTask,
  onOpen,
  onOpenCard,
  onClaim,
  onRelease,
  onAddChild,
  onMove,
}: {
  nodes: TreeNode[];
  /** claim_token 只在本次页面会话内保存，刷新即失效（服务端也只在认领响应里返回一次）。 */
  tokens: Record<string, string>;
  busyId: string | null;
  /** 当前 harness 标识：仅认领人本人能看到“续租/取回令牌”。 */
  harnessId: string;
  /** 右侧详情当前展示的任务；用来在树里高亮，方向键翻阅时眼睛能跟上。 */
  activeTaskId?: string | null;
  /** task_id → 挂在该任务下的 question 卡；直接把决策挂在任务行下面。 */
  questionsByTask?: Record<string, CardView[]>;
  onOpen: (taskId: string) => void;
  onOpenCard: (cardId: string) => void;
  onClaim: (task: TreeNode) => void;
  onRelease: (task: TreeNode, token: string) => void;
  /** 在某个节点下创建一条草稿子任务；返回 false 表示失败，输入框保持打开。 */
  onAddChild: (parent: TreeNode, title: string) => Promise<boolean>;
  /** 拖拽移动：newParentId=null 表示移到根节点；返回 false 表示失败。 */
  onMove: (taskId: string, newParentId: string | null) => Promise<boolean>;
}): ReactElement {
  // 拖拽状态放在树的顶层：拖动的是哪个节点、当前悬停在哪个目标上，
  // 需要跨递归层级共享；让每个 TaskNode 各存一份会导致祖先/兄弟之间看不到对方。
  const [dragging, setDragging] = useState<TreeNode | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);

  if (nodes.length === 0) {
    return <p className="muted empty-inline">当前筛选或搜索下没有任务。</p>;
  }

  // 只在渲染前排序，不改服务端数据：未结束的在前，同组内新创建的在前面。
  const ordered = sortTree(nodes);

  const endDrag = (): void => {
    setDragging(null);
    setDropTargetId(null);
    setRootDropActive(false);
  };

  const startDrag = (node: TreeNode, event: DragEvent<HTMLElement>): void => {
    if (busyId === node.id) {
      event.preventDefault();
      return;
    }
    setDragging(node);
    setDropTargetId(null);
    setRootDropActive(false);
    event.dataTransfer.effectAllowed = 'move';
    // 某些浏览器要求必须写一点数据，拖拽才会真正开始。
    event.dataTransfer.setData('text/plain', node.id);
  };

  const dragOverNode = (node: TreeNode, event: DragEvent<HTMLElement>): void => {
    if (!dragging) return;
    // 非法目标不 preventDefault：浏览器会显示“禁止”光标，松手也不会触发 drop。
    if (!canMoveTask(dragging, node)) {
      event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (dropTargetId !== node.id) setDropTargetId(node.id);
    if (rootDropActive) setRootDropActive(false);
  };

  const dragLeaveNode = (node: TreeNode, event: DragEvent<HTMLElement>): void => {
    // 从行移到行内子元素也会触发 dragleave；relatedTarget 仍在行内时不能清高亮，
    // 否则拖到标题上时目标框会一直闪。
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    if (dropTargetId === node.id) setDropTargetId(null);
  };

  const dropOnNode = (node: TreeNode, event: DragEvent<HTMLElement>): void => {
    if (!dragging || !canMoveTask(dragging, node)) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceId = dragging.id;
    endDrag();
    void onMove(sourceId, node.id);
  };

  const dropOnRoot = (event: DragEvent<HTMLElement>): void => {
    if (!dragging || dragging.parent_id === null) return;
    event.preventDefault();
    const sourceId = dragging.id;
    endDrag();
    void onMove(sourceId, null);
  };

  return (
    <div className="task-table">
      {/*
        根节点投放区只在拖动一个“非根任务”时出现：
        把子任务拖回根节点是常见整理动作，但空树区域没有落点，
        不给一个明确目标用户只能去详情里用下拉。
      */}
      {dragging && dragging.parent_id !== null ? (
        <div
          className={rootDropActive ? 'task-root-drop active' : 'task-root-drop'}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (!rootDropActive) setRootDropActive(true);
            if (dropTargetId !== null) setDropTargetId(null);
          }}
          onDragLeave={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && event.currentTarget.contains(next)) return;
            setRootDropActive(false);
          }}
          onDrop={dropOnRoot}
        >
          松开：把「{dragging.title}」移到根节点
        </div>
      ) : null}

      <div className="task-table-head" aria-hidden="true">
        <span>状态</span>
        <span>类型</span>
        <span className="task-col-category">分类</span>
        <span>优先级</span>
        <span title="结束通知置顶，其次按最近活动时间倒序；按住任务名可拖动">
          标题 · 排序：通知置顶，最近活动优先
        </span>
        <span className="task-col-assignee">负责人</span>
        <span className="task-col-time">时间</span>
        <span>操作</span>
      </div>

      <ul className="task-tree" role="tree">
        {ordered.map((node, index) => (
          <TaskNode
            key={node.id}
            node={node}
            depth={0}
            isLast={index === ordered.length - 1}
            tokens={tokens}
            busyId={busyId}
            harnessId={harnessId}
            activeTaskId={activeTaskId ?? null}
            questionsByTask={questionsByTask ?? {}}
            dragging={dragging}
            dropTargetId={dropTargetId}
            onDragStartNode={startDrag}
            onDragEndNode={endDrag}
            onDragOverNode={dragOverNode}
            onDragLeaveNode={dragLeaveNode}
            onDropNode={dropOnNode}
            onOpen={onOpen}
            onOpenCard={onOpenCard}
            onClaim={onClaim}
            onRelease={onRelease}
            onAddChild={onAddChild}
          />
        ))}
      </ul>
    </div>
  );
}

function TaskNode({
  node,
  depth,
  isLast,
  tokens,
  busyId,
  harnessId,
  activeTaskId,
  questionsByTask,
  dragging,
  dropTargetId,
  onDragStartNode,
  onDragEndNode,
  onDragOverNode,
  onDragLeaveNode,
  onDropNode,
  onOpen,
  onOpenCard,
  onClaim,
  onRelease,
  onAddChild,
}: {
  node: TreeNode;
  depth: number;
  /** 在当前层的兄弟节点里是不是最后一个；决定“自己那根竖线”画半截还是贯通。 */
  isLast: boolean;
  tokens: Record<string, string>;
  busyId: string | null;
  harnessId: string;
  activeTaskId: string | null;
  questionsByTask: Record<string, CardView[]>;
  dragging: TreeNode | null;
  dropTargetId: string | null;
  onDragStartNode: (node: TreeNode, event: DragEvent<HTMLElement>) => void;
  onDragEndNode: () => void;
  onDragOverNode: (node: TreeNode, event: DragEvent<HTMLElement>) => void;
  onDragLeaveNode: (node: TreeNode, event: DragEvent<HTMLElement>) => void;
  onDropNode: (node: TreeNode, event: DragEvent<HTMLElement>) => void;
  onOpen: (taskId: string) => void;
  onOpenCard: (cardId: string) => void;
  onClaim: (task: TreeNode) => void;
  onRelease: (task: TreeNode, token: string) => void;
  onAddChild: (parent: TreeNode, title: string) => Promise<boolean>;
}): ReactElement {
  const token = tokens[node.id];
  const hasChildren = node.children.length > 0;
  // 默认展开：任务树的第一眼应该看到全貌；收起是用户主动做的聚焦动作。
  const [expanded, setExpanded] = useState(true);
  const openDescendants = countOpenDescendants(node);
  const hasLeftover = isClosed(node.status) && openDescendants > 0;
  const relatedCards = questionsByTask[node.id] ?? [];
  // 当前状态对应的时间：完成看 completed_at，阻塞看 blocked_at，而不是会被编辑刷新的 updated_at。
  const statusTime = taskStatusTime(node);
  const timeTitle = [
    `ID ${node.id}`,
    `创建 ${formatAbsolute(node.created_at)}`,
    statusTime ? `${statusTime.label} ${formatAbsolute(statusTime.value)}` : null,
    node.defer_reason ? `暂缓：${node.defer_reason}` : null,
    node.deferred_until ? `计划恢复 ${formatAbsolute(node.deferred_until)}` : null,
    node.risk_note ? `隐患：${node.risk_note}` : null,
    node.risk_resolved_at ? `隐患解除 ${formatAbsolute(node.risk_resolved_at)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const canClaim = node.status === 'pending';
  // 服务端认领接口对“同一 harness + 未过期租约”是续租语义：
  // 传不传旧令牌都会沿用原 claim_token，所以这里可以把令牌取回到当前会话。
  const canRenew =
    Boolean(harnessId) &&
    RELEASABLE.includes(node.status) &&
    node.claimed_by === harnessId;
  const canRelease = Boolean(token) && RELEASABLE.includes(node.status);

  const [adding, setAdding] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const submitAdd = async (): Promise<void> => {
    const title = draftTitle.trim();
    if (!title || addBusy) return;
    setAddBusy(true);
    const ok = await onAddChild(node, title);
    setAddBusy(false);
    if (!ok) return;
    // 成功后清空并保留输入框，方便连续给同一节点补几条草稿。
    setDraftTitle('');
  };

  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitAdd();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setAdding(false);
      setDraftTitle('');
    }
  };

  const activate = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(node.id);
    }
  };

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        className={[
          'task-row',
          activeTaskId === node.id ? 'active' : '',
          // 结束通知：任务刚进入终态、用户还没点过这一行时，整行用背景色标出来。
          // 类名独立于 status，避免“已完成”本身被误读成“必须处理”。
          node.end_notice_pending ? 'end-notice' : '',
          // 拖拽时：源行淡出、合法目标行画虚线框。非法目标不加类，
          // 用户从光标（none）和没有高亮两处都能判断“这里不能放”。
          dragging?.id === node.id ? 'dragging' : '',
          dropTargetId === node.id ? 'drop-target' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="button"
        tabIndex={0}
        data-task-id={node.id}
        aria-current={activeTaskId === node.id ? 'true' : undefined}
        title={node.end_notice_pending ? '任务已结束，点一下确认这条结束通知' : undefined}
        onClick={() => onOpen(node.id)}
        onKeyDown={activate}
        onDragOver={(event) => onDragOverNode(node, event)}
        onDragLeave={(event) => onDragLeaveNode(node, event)}
        onDrop={(event) => onDropNode(node, event)}
      >
        {/* 状态与类型分开两列：状态回答“做到哪了”，类型回答“这是活还是建议”。 */}
        <span className="task-cell task-cell-status">
          <TaskStatusBadge status={node.status} />
          {/* “待认领”和“已暂缓”同时成立：前者说明没人接，后者说明已决定先不做。 */}
          {node.defer_reason ? (
            <TaskDeferBadge reason={node.defer_reason} until={node.deferred_until} />
          ) : null}
          {/* 隐患只在未解除时进树：已解除的留在详情里复盘，避免日常视图变噪音。 */}
          {node.risk_note && !node.risk_resolved_at ? (
            <TaskRiskBadge note={node.risk_note} />
          ) : null}
          {hasLeftover ? <TaskLeftoverBadge openCount={openDescendants} /> : null}
        </span>
        <span className="task-cell">
          <TaskKindBadge kind={node.kind} />
        </span>
        {/* 分类是单值归属：空值显示破折号，不用空标签占位，避免误读成“分类叫空字符串”。 */}
        <span className="task-cell task-col-category" title={node.category ?? '未分类'}>
          {node.category ? (
            <span className="task-category">{node.category}</span>
          ) : (
            <span className="muted small">—</span>
          )}
        </span>
        <span className="task-cell">
          {/* 已完成/取消的节点把优先级降成灰色：它们不再需要动手，彩色会误导注意力。 */}
          <PriorityBadge priority={node.priority} muted={CLOSED_STATUSES.includes(node.status)} />
        </span>

        <span
          className={
            hasChildren
              ? `task-title-cell has-children${expanded ? ' expanded' : ''}`
              : 'task-title-cell'
          }
          style={{ '--task-depth': depth } as CSSProperties}
        >
          {/*
            层级线：每行只画“自己到直接父节点”的一条竖线 + 一个横向分支。
            用独立缩进块而不是给整行加 padding，是为了让状态/类型/时间列
            在所有层级上保持对齐；缩进只发生在标题列内部。

            不再补画祖先延续线：一条竖线只要能把当前行接到直接父节点就够了；
            把每一级祖先都竖直贯穿下来，三级行左侧会同时出现两条平行竖线，
            其中靠外那条与当前行的父子关系无关，反而让层级更难读。
            自己那一段在 isLast 时只画上半截，
            和父节点下来的线在行中线接成 └ 形。
          */}
          {depth > 0 ? (
            <span
              className="task-indent"
              style={{ width: `${depth * 18}px` }}
              aria-hidden="true"
            >
              <span
                className={isLast ? 'task-branch task-branch-last' : 'task-branch'}
                style={{ left: `${depth * 18 - 4}px` }}
              />
              <span className="task-elbow" />
            </span>
          ) : null}
          {hasChildren ? (
            <button
              type="button"
              className="task-toggle"
              aria-expanded={expanded}
              aria-label={expanded ? '收起子任务' : '展开子任务'}
              title={expanded ? '收起子任务' : '展开子任务'}
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((value) => !value);
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {expanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="task-toggle-spacer" aria-hidden="true" />
          )}
          {/*
            只有标题是拖拽把手，不是整行：整行 draggable 会让点击打开详情、
            选中文字、拖滚动条都变得别扭；标题是用户按住时的自然目标。
          */}
          <span
            className="task-title"
            title={`${node.title}（按住可拖动到其他任务下）`}
            draggable={busyId !== node.id}
            onDragStart={(event) => onDragStartNode(node, event)}
            onDragEnd={onDragEndNode}
          >
            <MarkdownInline source={node.title} />
          </span>
          {/*
            未读红点放在标题后面，而不是单独一列：
            它的作用是“这条任务有新消息”，和标题是同一个判断动作；
            单独成列会让本来就紧张的横向空间再挤掉一截。
          */}
          {node.unread_count > 0 ? (
            <span
              className="task-unread-dot"
              title={`${node.unread_count} 条未读信息`}
              aria-label={`${node.unread_count} 条未读信息`}
            >
              {node.unread_count > 99 ? '99+' : node.unread_count}
            </span>
          ) : null}
          {/*
            背景色之外再留一个小圆点：色觉差异或高对比度主题下，
            纯背景高亮可能不够明显；圆点带 title，仍属于“点整行确认”。
          */}
          {node.end_notice_pending ? (
            <span
              className="task-end-notice-dot"
              title="任务已结束，点一下确认"
              aria-label="任务已结束，点一下确认"
            />
          ) : null}
        </span>

        <span className="task-cell task-col-assignee">
          {node.assignee ? (
            <span className="tag">{node.assignee}</span>
          ) : (
            <span className="muted small">—</span>
          )}
        </span>

        {/* 正文只放相对时间，避免任务行被绝对时间撑爆；悬停看精确值与 ID。 */}
        <span className="task-time task-col-time" title={timeTitle}>
          <span>创建 {formatRelative(node.created_at)}</span>
          <span className="muted small">
            {statusTime ? `${statusTime.label} ${formatRelative(statusTime.value)}` : shortId(node.id)}
          </span>
        </span>

        <span className="task-row-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={addBusy}
            title={`在「${node.title}」下新增草稿子任务`}
            aria-label={`在「${node.title}」下新增草稿子任务`}
            onClick={() => {
              setAdding((value) => !value);
              setDraftTitle('');
            }}
          >
            +
          </button>
          {canClaim ? (
            <button
              type="button"
              className="btn btn-small"
              disabled={busyId === node.id}
              onClick={() => onClaim(node)}
            >
              {busyId === node.id ? '认领中…' : '认领'}
            </button>
          ) : null}
          {canRenew ? (
            <button
              type="button"
              className="btn btn-small"
              disabled={busyId === node.id}
              title="同一 harness 续租会沿用原 claim_token"
              onClick={() => onClaim(node)}
            >
              {busyId === node.id ? '处理中…' : token ? '续租' : '取回令牌'}
            </button>
          ) : null}
          {canRelease ? (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={busyId === node.id}
              onClick={() => onRelease(node, token ?? '')}
            >
              释放
            </button>
          ) : null}
        </span>
      </div>

      {/*
        决策条目直接挂在任务行下面：用户看任务时就知道“这条任务卡在哪个决策上”，
        不用再去决策台按标题猜它属于哪件事。点开仍走全局卡片抽屉/模态框。
      */}
      {relatedCards.length > 0 ? (
        <div
          className="task-decisions"
          style={{ paddingLeft: `${8 + depth * 18}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="task-decisions-label">决策</span>
          {relatedCards.slice(0, 4).map((card) => (
            <button
              type="button"
              key={card.id}
              className={`task-decision-chip card-status-${card.status}`}
              title={`${card.title ?? '未命名决策'} · ${CARD_STATUS_LABELS[card.status]}`}
              onClick={() => onOpenCard(card.id)}
            >
              <span className="task-decision-dot" aria-hidden="true" />
              <span className="task-decision-status">{CARD_STATUS_LABELS[card.status]}</span>
              <span className="task-decision-title">
                <MarkdownInline source={card.title ?? '未命名决策'} />
              </span>
            </button>
          ))}
          {relatedCards.length > 4 ? (
            <span className="muted small">还有 {relatedCards.length - 4} 条</span>
          ) : null}
        </div>
      ) : null}

      {adding ? (
        <div
          className="task-add-inline"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <input
            autoFocus
            value={draftTitle}
            maxLength={200}
            placeholder={`在「${node.title}」下新增草稿子任务，一句话即可`}
            aria-label="草稿子任务标题"
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={onDraftKeyDown}
          />
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={addBusy || !draftTitle.trim()}
            onClick={() => void submitAdd()}
          >
            {addBusy ? '保存中…' : '保存草稿'}
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => {
              setAdding(false);
              setDraftTitle('');
            }}
          >
            取消
          </button>
          <span className="muted small">Enter 保存 · Esc 取消 · 默认停在草稿，不会自动派发</span>
        </div>
      ) : null}

      {hasChildren && expanded ? (
        <ul role="group">
          {node.children.map((child, index) => (
            <TaskNode
              key={child.id}
              node={child}
              depth={depth + 1}
              isLast={index === node.children.length - 1}
              tokens={tokens}
              busyId={busyId}
              harnessId={harnessId}
              activeTaskId={activeTaskId}
              questionsByTask={questionsByTask}
              dragging={dragging}
              dropTargetId={dropTargetId}
              onDragStartNode={onDragStartNode}
              onDragEndNode={onDragEndNode}
              onDragOverNode={onDragOverNode}
              onDragLeaveNode={onDragLeaveNode}
              onDropNode={onDropNode}
              onOpen={onOpen}
              onOpenCard={onOpenCard}
              onClaim={onClaim}
              onRelease={onRelease}
              onAddChild={onAddChild}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** 已结束的状态。只在展示层用：失败仍留在“未结束”组里，避免失败任务被藏起来。 */
const CLOSED_STATUSES: TaskStatus[] = ['done', 'cancelled'];

function isClosed(status: TaskStatus): boolean {
  return CLOSED_STATUSES.includes(status);
}

/**
 * 后代里还有多少条没结束（既没完成也没取消）。
 *
 * 只看后代、不看自己：父任务已经完成时，这个数字就是“还有多少遗留”。
 * 失败也算遗留——失败不是收口，用户需要看到并决定重试还是取消。
 */
function countOpenDescendants(node: TreeNode): number {
  let count = 0;
  const walk = (items: TreeNode[]): void => {
    for (const item of items) {
      if (!isClosed(item.status)) count += 1;
      walk(item.children);
    }
  };
  walk(node.children);
  return count;
}

