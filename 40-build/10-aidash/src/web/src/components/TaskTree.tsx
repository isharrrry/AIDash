import { useState } from 'react';
import type { DragEvent, ReactElement } from 'react';
import { canMoveTask, sortTree } from '../lib/task-tree';
// 排序是纯数据逻辑，放在 lib 里便于单测；这里继续导出，TaskBoard 的导入路径不变。
export { sortTree };
import type { CardView, TreeNode } from '../types';
import { TaskNode } from './TaskTreeNode';

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
            trunks={[]}
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
