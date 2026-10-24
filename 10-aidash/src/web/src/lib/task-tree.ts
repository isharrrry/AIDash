import type { TaskView } from '../types';

/**
 * 任务树的纯函数工具。
 *
 * 为什么单独抽出来：层级关系由物化路径 `path` 决定，拖拽校验、父任务下拉、
 * 缩进深度都要用同一套判断。如果三处各写一份 `startsWith`，很容易出现
 * “下拉允许选自己、拖拽却拒绝”这种前后不一致。这里不依赖 React/DOM，可直接单测。
 */

/** 选项下拉需要的最小任务形状；不要求调用方传完整 TaskView。 */
export type TaskTreeItem = Pick<TaskView, 'id' | 'path' | 'title'>;

export interface TaskParentOption {
  id: string;
  title: string;
  /** 相对根节点的层级：根任务为 0。 */
  depth: number;
  /** 下拉里显示的一行文本，已带全角缩进，便于看出层级。 */
  label: string;
}

/** 排序所需的最小任务形状；`TreeNode` 结构上满足它，测试也不必构造完整 TaskView。 */
export type SortableTask = Pick<
  TaskView,
  | 'status'
  | 'end_notice_pending'
  | 'created_at'
  | 'updated_at'
  | 'claimed_at'
  | 'started_at'
  | 'blocked_at'
  | 'completed_at'
  | 'failed_at'
  | 'cancelled_at'
>;

/** 完成/取消是“这条路走完了”；失败不算结束，仍需处理。 */
const CLOSED_STATUSES: readonly string[] = ['done', 'cancelled'];

/**
 * 任务的“最近活动时间”。
 *
 * 为什么取这些字段的最大值，而不是只看 `updated_at`：
 * - `updated_at` 只在写操作时变化，但状态事件本身也是活动；
 * - 用户要的是“最近发生变化的排前面”，完成、开始、阻塞、取消都算变化；
 * - 服务端时间统一是 ISO 8601 字符串，同一时区下字典序等于时间序，
 *   直接用字符串比较即可，不需要逐个 `Date.parse`。
 */
/**
 * 搜索框需要的最小任务形状；`TreeNode` 结构上满足它。
 * 只取用户可能拿来搜的列，避免把描述正文拼进匹配串导致“搜一句话命中一整棵树”。
 */
export type SearchableTask = Pick<
  TaskView,
  'id' | 'title' | 'category' | 'assignee' | 'tags'
>;

/**
 * 任务关键字匹配（客户端过滤）。
 *
 * 为什么在浏览器里做而不是新增搜索接口：
 * - 任务树本来就一次性拉全（最多 depth=10），再发一次请求只会多一次往返；
 * - 过滤还要保留命中节点的祖先，服务端只回一个扁平列表反而要在前端重新拼树。
 *
 * 规则：
 * - 空白关键字 = 不筛选；
 * - 按空白切词，所有词都要出现在拼接串里（AND），比“任意命中”更接近
 *   用户输入两个限定词时的意图；
 * - null/空字段不参与拼接，否则搜索 “null” 会命中所有未分类任务。
 */
export function matchesTaskKeyword(task: SearchableTask, keyword: string): boolean {
  const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = [task.id, task.title, task.category, task.assignee, ...task.tags]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

export function lastActivityAt(task: SortableTask): string {
  return [
    task.updated_at,
    task.claimed_at,
    task.started_at,
    task.blocked_at,
    task.completed_at,
    task.failed_at,
    task.cancelled_at,
  ].reduce<string>((latest, value) => (value && value > latest ? value : latest), '');
}

/**
 * 同级排序。优先级（从高到低）：
 * 1. 带未确认结束通知的排最前——它是唯一需要用户动手消掉的状态；
 * 2. 最近活动时间倒序——刚完成/刚开始的条目先出现；
 * 3. 未结束的排在已结束之前；
 * 4. 同组内新建的在前。
 *
 * 注意第 2 条压过第 3 条：一条刚完成的任务会排到很久没动的待认领任务之前。
 * 这是用户明确要求的口径——“更新时间最近”比“非结束靠前”优先。
 */
export function sortTree<T extends SortableTask & { children: T[] }>(nodes: T[]): T[] {
  return [...nodes]
    .sort(compareNodes)
    .map((node) =>
      node.children.length > 0 ? { ...node, children: sortTree(node.children) } : node,
    );
}

function compareNodes(left: SortableTask, right: SortableTask): number {
  const noticeDiff =
    Number(right.end_notice_pending) - Number(left.end_notice_pending);
  if (noticeDiff !== 0) return noticeDiff;

  const activityDiff = lastActivityAt(right).localeCompare(lastActivityAt(left));
  if (activityDiff !== 0) return activityDiff;

  const closedDiff =
    Number(CLOSED_STATUSES.includes(left.status)) -
    Number(CLOSED_STATUSES.includes(right.status));
  if (closedDiff !== 0) return closedDiff;

  return right.created_at.localeCompare(left.created_at);
}

/** 从物化路径算层级：`/tk_a/` 是根（0），`/tk_a/tk_b/` 是第 1 层。 */
export function taskDepth(path: string): number {
  return Math.max(path.split('/').filter(Boolean).length - 1, 0);
}

/**
 * 判断候选节点是不是“自己或自己的后代”。
 *
 * 物化路径的设计就是让子树判断变成前缀比较：`/a/` 是 `/a/b/` 的前缀。
 * 注意必须比较 path 而不是 parent_id：只看直接父级会漏掉孙子节点。
 */
export function isSelfOrDescendant(candidatePath: string, taskPath: string): boolean {
  return candidatePath.startsWith(taskPath);
}

/**
 * 拖动任务时，能否把 source 挂到 target 下面。
 *
 * 两个禁止项：
 * - 不能挂到自己下面（形成环）；
 * - 不能挂到自己的后代下面（同样形成环，而且会让整棵子树从树里消失）。
 * 挂到自己的祖先/兄弟/无关节点下都是合法的。
 */
export function canMoveTask(
  source: Pick<TaskTreeItem, 'id' | 'path'>,
  target: Pick<TaskTreeItem, 'id' | 'path'>,
): boolean {
  return source.id !== target.id && !isSelfOrDescendant(target.path, source.path);
}

/**
 * 生成“新父任务”下拉选项。
 *
 * 排除自己与后代：这两个位置在服务端会被 `TASK_CYCLE` 拒绝，
 * 与其让用户选完再报错，不如一开始就不出现在列表里。
 * 保持传入顺序（调用方通常传 flatten 后的树序），这样选项顺序和左侧任务树一致。
 */
export function buildParentOptions(
  tasks: readonly TaskTreeItem[],
  taskId: string,
): TaskParentOption[] {
  const self = tasks.find((task) => task.id === taskId);
  if (!self) return [];

  return tasks
    .filter((task) => !isSelfOrDescendant(task.path, self.path))
    .map((task) => {
      const depth = taskDepth(task.path);
      return {
        id: task.id,
        title: task.title,
        depth,
        // 全角空格不会被 HTML 折叠，能在原生 select 里形成稳定的层级缩进。
        label: `${'　'.repeat(depth)}${task.title}`,
      };
    });
}
