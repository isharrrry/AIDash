import { AppError } from '../../shared/errors.js';
import type { Page, Task, TaskStatus, TaskView, TreeNode } from '../../shared/types.js';
import type { CardRepo } from '../repos/card-repo.js';
import type { TaskRepo } from '../repos/task-repo.js';
import { toTaskView } from '../repos/task-repo.js';
import type { ChannelService } from './channel-service.js';

/**
 * TaskService 的查询投影。
 *
 * 为什么单独拆出来：列表/树要一次算完未读数与通道 key，避免 N+1；
 * 这段逻辑只依赖 repos + channel service，不需要事务、状态机或审计，
 * 放进子模块后主服务只剩编排，测试也仍从 TaskService 的公开方法进入。
 */
export interface TaskQueryDeps {
  tasks: TaskRepo;
  cards: CardRepo;
  channels: ChannelService;
}

export function requireTask(tasks: TaskRepo, id: string): Task {
  const task = tasks.get(id);
  if (!task) throw new AppError('NOT_FOUND', 'TASK_NOT_FOUND', { task_id: id });
  return task;
}

export function taskToView(
  deps: TaskQueryDeps,
  task: Task,
  channelKey?: string,
  includeDescription = true,
  unreadCount?: number,
): TaskView {
  const key = channelKey ?? deps.channels.getOrThrow(task.channel_id).channel_key;
  // 单任务详情/写操作响应没批量上下文，这里补一次计数；
  // 列表与树已经批量算好，传进来避免重复查询。
  const count = unreadCount ?? deps.cards.countUnreadForTask(task.id);
  return toTaskView(task, key, includeDescription, count);
}

export function getTaskView(deps: TaskQueryDeps, id: string): TaskView {
  return taskToView(deps, requireTask(deps.tasks, id));
}

export interface TaskListFilter {
  channel_key?: string;
  status?: TaskStatus[];
  assignee?: string;
  /** true=曾经标记过隐患（含已解除）；复盘用。 */
  has_risk?: boolean;
  /** true=只看仍未解除的隐患。 */
  risk_open?: boolean;
  page?: number;
  page_size?: number;
}

export function listTaskViews(
  deps: TaskQueryDeps,
  filter: TaskListFilter = {},
  includeDescription = false,
): Page<TaskView> {
  const channel = filter.channel_key
    ? deps.channels.getByKeyOrThrow(filter.channel_key)
    : undefined;
  const page = deps.tasks.list(
    {
      channelId: channel?.id,
      statuses: filter.status,
      assignee: filter.assignee,
      hasRisk: filter.has_risk,
      riskOpen: filter.risk_open,
      page: filter.page,
      page_size: filter.page_size,
    },
    // 把“要不要正文”一路传到 SQL：repo 层不选 description_md，
    // 数据库就不会把 base64 截图读进内存，而不只是响应体里丢掉。
    includeDescription,
  );
  // 一页任务一次算完未读数，避免每个任务一次 COUNT。
  const unread = deps.cards.countUnreadForTasks(page.items.map((task) => task.id));
  // 未按通道筛选时，一页任务可能来自多个通道：一次批量取回 channel_key，
  // 避免 toView 对每个任务各查一次通道（N+1）。
  const channelKeys = channel
    ? undefined
    : deps.channels.keysById(page.items.map((task) => task.channel_id));
  return {
    ...page,
    items: page.items.map((task) =>
      taskToView(
        deps,
        task,
        channel?.channel_key ?? channelKeys?.get(task.channel_id),
        includeDescription,
        unread.get(task.id) ?? 0,
      ),
    ),
  };
}

export function taskTree(
  deps: TaskQueryDeps,
  channelKey: string,
  maxDepth?: number,
  includeDescription = false,
): TreeNode[] {
  const channel = deps.channels.getByKeyOrThrow(channelKey);
  const roots = deps.tasks.tree(channel.id, includeDescription);
  // 整条通道的未读数一次取出，按 task_id 填到节点上；
  // 树可能有上千个节点，逐节点查会把一次树请求放大成 N+1。
  const unread = deps.cards.countUnreadByTask(channel.id);
  const fill = (nodes: TreeNode[], level: number): TreeNode[] => {
    if (maxDepth !== undefined && level > maxDepth) return [];
    return nodes.map((node) => ({
      ...node,
      channel_key: channel.channel_key,
      unread_count: unread.get(node.id) ?? 0,
      children: fill(node.children, level + 1),
    }));
  };
  return fill(roots, 1);
}
