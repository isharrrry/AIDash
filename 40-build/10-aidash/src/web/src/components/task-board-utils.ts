import { matchesTaskKeyword } from '../lib/task-tree';
import type { CardView, TaskStatus, TaskView, TreeNode } from '../types';

/** 看板头部统计；与通道的 open_task_count 口径保持同一套定义。 */
export interface TaskBoardStats {
  total: number;
  open: number;
  active: number;
  pending: number;
  draft: number;
  blocked: number;
  done: number;
  cancelled: number;
  deferred: number;
  riskOpen: number;
}

/**
 * 头部统计按整棵树算，不受状态/负责人筛选影响。
 *
 * 筛选是“临时聚焦”，统计是“这条通道还有多少活”；
 * 两者口径混在一起会让用户误判还有多少任务待认领。
 */
export function computeTaskStats(tasks: readonly TaskView[]): TaskBoardStats {
  let open = 0;
  let active = 0;
  let pending = 0;
  let draft = 0;
  let blocked = 0;
  let done = 0;
  let cancelled = 0;
  let deferred = 0;
  let riskOpen = 0;
  for (const task of tasks) {
    // “进行中”= 已被认领且正在做。claimed 也是有人接了，只差还没点开始，
    // 对用户来说都属于“正在处理”，所以和 in_progress 一起算，不让进度条空转。
    if (task.status === 'claimed' || task.status === 'in_progress') active += 1;
    if (task.status === 'pending') pending += 1;
    if (task.status === 'draft') draft += 1;
    if (task.status === 'blocked') blocked += 1;
    if (task.status === 'done') done += 1;
    if (task.status === 'cancelled') cancelled += 1;
    // 暂缓是独立维度：任务可能同时是 pending 且已暂缓，两个统计都要计入。
    if (task.defer_reason) deferred += 1;
    // 隐患同样是独立维度：它可能挂在已完成的任务上，只统计仍未解除的。
    if (task.risk_note && !task.risk_resolved_at) riskOpen += 1;
    // 口径必须与服务端 channel.open_task_count 完全一致：pending/claimed/in_progress/blocked。
    // draft 还没提交（不可认领），不计“有活待干”；
    // 两边定义不同会让通道 chip 的“未结束”和看板头部的“未结束”对不上。
    if (
      task.status === 'pending' ||
      task.status === 'claimed' ||
      task.status === 'in_progress' ||
      task.status === 'blocked'
    ) {
      open += 1;
    }
  }
  return {
    total: tasks.length,
    open,
    active,
    pending,
    draft,
    blocked,
    done,
    cancelled,
    deferred,
    riskOpen,
  };
}

/** 把树拍平成详情/父任务下拉使用的先序列表。 */
export function flattenTree(nodes: TreeNode[]): TaskView[] {
  const result: TaskView[] = [];
  const walk = (items: TreeNode[]): void => {
    for (const node of items) {
      result.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return result;
}

/** 把当前通道的 question 卡按 task_id 归组；没有关联任务的卡不进树。 */
export function groupQuestionsByTask(
  cards: readonly CardView[],
): Record<string, CardView[]> {
  const grouped: Record<string, CardView[]> = {};
  for (const card of cards) {
    if (!card.task_id) continue;
    const list = grouped[card.task_id];
    if (list) list.push(card);
    else grouped[card.task_id] = [card];
  }
  return grouped;
}

/**
 * 用详情信息流算出的未读数覆盖节点上的服务端值。
 *
 * 只覆盖显式出现过的任务 id；没有覆盖的节点继续用 tree 接口返回的值。
 * 递归时保持不可变：返回新节点/新 children，不原地改 useAsync 缓存的数据。
 */
export function applyUnreadOverrides(
  nodes: TreeNode[],
  overrides: Record<string, number>,
): TreeNode[] {
  return nodes.map((node) => {
    const overridden = overrides[node.id];
    const next =
      overridden === undefined ? node : { ...node, unread_count: overridden };
    return next.children.length > 0
      ? { ...next, children: applyUnreadOverrides(next.children, overrides) }
      : next;
  });
}

/** 把本地已确认的结束通知标成已读；不改服务端返回的原始树。 */
export function applyEndNoticeOverrides(
  nodes: TreeNode[],
  acked: Record<string, true>,
): TreeNode[] {
  return nodes.map((node) => {
    const next = acked[node.id] ? { ...node, end_notice_pending: false } : node;
    return next.children.length > 0
      ? { ...next, children: applyEndNoticeOverrides(next.children, acked) }
      : next;
  });
}

/**
 * 保留“命中节点及其祖先/后代”，避免筛选把树拆得看不出层级。
 *
 * 三个条件取交集：状态、负责人、搜索关键字。任一条件为空表示不限制。
 * 关键字命中父节点时保留整棵子树——用户搜的是“这条线”，
 * 而不是只要一条光秃秃的父节点；命中子节点时保留路径祖先，层级才不会断。
 */
export function filterTree(
  nodes: TreeNode[],
  statuses: Set<TaskStatus>,
  assignee: string,
  keyword: string,
): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    const matches =
      (statuses.size === 0 || statuses.has(node.status)) &&
      (!assignee || (node.assignee ?? '').toLowerCase().includes(assignee)) &&
      matchesTaskKeyword(node, keyword);
    // 命中节点保留整棵子树；未命中但有命中后代的节点作为“路径祖先”保留。
    const children = matches
      ? node.children
      : filterTree(node.children, statuses, assignee, keyword);
    if (matches || children.length > 0) {
      result.push({ ...node, children });
    }
  }
  return result;
}

/**
 * 默认筛选：只保留“未结束”或“带未确认结束通知”的节点。
 *
 * 不能简单地把 done 节点连子树整段删掉：常见情况是“父任务已完成，验收时又拆出一条
 * 待办子任务”，整段删会把仍然活跃的子任务一起藏没。这里把已结束节点的子代提升一级，
 * 让活着的后代继续出现在树上；层级缩进会少一层，但仍能顺着标题找到源头。
 *
 * keepStatuses 是用户显式勾选的状态 chip：勾了“完成”就保持完成节点可见，
 * 否则默认筛选会让状态筛选看起来失效（勾完一条都没有）。
 */
export function withoutClosed(
  nodes: TreeNode[],
  keepStatuses: Set<TaskStatus>,
): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    const children = withoutClosed(node.children, keepStatuses);
    const isClosed = node.status === 'done' || node.status === 'cancelled';
    // 带未确认结束通知的节点即使已完成也保留：用户正是要看到“它结束了”。
    // 先确认再隐藏，提醒不会被默认筛选吞掉。
    if (isClosed && !node.end_notice_pending && !keepStatuses.has(node.status)) {
      result.push(...children);
      continue;
    }
    result.push({ ...node, children });
  }
  return result;
}
