import { useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactElement } from 'react';
import { formatAbsolute, formatRelative, shortId, taskStatusTime } from '../lib/format';
import type { CardView, TaskStatus, TreeNode } from '../types';
import {
  PriorityBadge,
  TaskDeferBadge,
  TaskKindBadge,
  TaskLeftoverBadge,
  TaskRiskBadge,
  TaskStatusBadge,
} from './Badge';
import { TaskAddChildForm, TaskDecisionChips } from './TaskTreeNodeExtras';
import { TaskTitleCell } from './TaskTitleCell';

const RELEASABLE: TaskStatus[] = ['claimed', 'in_progress', 'blocked'];

export interface TaskNodeProps {
  node: TreeNode;
  depth: number;
  /** 在当前层的兄弟节点里是不是最后一个；决定“自己那根竖线”画半截还是贯通。 */
  isLast: boolean;
  /**
   * 祖先里「还有下一个兄弟」的层级（从 1 开始）。
   *
   * 深度优先展开后，两个兄弟之间夹着前一个兄弟的整棵子树；
   * 只在每个节点自己那一行画线，中间那段树干就会断掉。
   * 这些层级对应的竖线必须贯穿当前行，兄弟的连线才不会缺一段。
   */
  trunks: number[];
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
}

/** 递归任务行：一次任务树渲染中的单个节点及其子树。 */
export function TaskNode({
  node,
  depth,
  isLast,
  trunks,
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
}: TaskNodeProps): ReactElement {
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

        <TaskTitleCell
          node={node}
          depth={depth}
          isLast={isLast}
          trunks={trunks}
          hasChildren={hasChildren}
          expanded={expanded}
          busyId={busyId}
          onToggle={() => setExpanded((value) => !value)}
          onDragStart={onDragStartNode}
          onDragEnd={onDragEndNode}
        />

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
            title={`在「${node.title}」下新增草稿子任务`}
            aria-label={`在「${node.title}」下新增草稿子任务`}
            onClick={() => setAdding((value) => !value)}
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

      <TaskDecisionChips cards={relatedCards} depth={depth} onOpenCard={onOpenCard} />

      {adding ? (
        <TaskAddChildForm
          node={node}
          depth={depth}
          onAddChild={onAddChild}
          onClose={() => setAdding(false)}
        />
      ) : null}

      {hasChildren && expanded ? (
        <ul role="group">
          {node.children.map((child, index) => (
            <TaskNode
              key={child.id}
              node={child}
              depth={depth + 1}
              isLast={index === node.children.length - 1}
              // 当前节点（depth≥1）还有下一个兄弟时，它的树干要贯穿整棵子树；
              // 根层的兄弟不画连线（根行没有缩进和横臂），所以不登记 level 0。
              trunks={depth >= 1 && !isLast ? [...trunks, depth] : trunks}
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
