import type { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { assertNoSecrets } from '../../shared/secrets.js';
import { taskCreateSchema } from '../../shared/schemas.js';
import type { Clock } from '../../shared/time.js';
import type { Ctx, Page, Task, TaskStatus, TaskView, TreeNode } from '../../shared/types.js';
import { txImmediate, type Db } from '../db/connection.js';
import type { CardRepo } from '../repos/card-repo.js';
import type { EventRepo, HarnessRepo } from '../repos/support-repos.js';
import type { TaskRepo } from '../repos/task-repo.js';
import type { AuditService } from './audit-service.js';
import type { ChannelService } from './channel-service.js';
import {
  assertTaskDepth,
  claimTask,
  depthOf,
  expireTaskLeases,
  type TaskClaimInput,
} from './task-service-lease.js';
import {
  getTaskView,
  listTaskViews,
  requireTask,
  taskToView,
  taskTree,
} from './task-service-query.js';
import {
  applyTaskRelease,
  applyTaskUpdate,
  isTerminalTaskStatus,
  type TaskReleaseInput,
  type TaskUpdateInput,
} from './task-service-state-events.js';

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type { TaskClaimInput, TaskReleaseInput, TaskUpdateInput };

export interface TaskServiceDeps {
  db: Db;
  tasks: TaskRepo;
  cards: CardRepo;
  harnesses: HarnessRepo;
  events: EventRepo;
  channels: ChannelService;
  audit: AuditService;
  clock: Clock;
  leaseSeconds: number;
  maxDepth?: number;
}

const MAX_DEPTH_DEFAULT = 20;

/**
 * TaskService 的运行时依赖袋。
 *
 * 子模块只接受结构化的 deps，而不是 TaskService 实例：
 * 这样“状态事件 / 查询投影 / 租约与深度”之间没有反向依赖，
 * 主类仍然持有唯一的事务编排入口。
 */
interface TaskServiceRuntime extends TaskServiceDeps {
  maxDepth: number;
}

export class TaskService {
  private readonly db: Db;
  private readonly tasks: TaskRepo;
  private readonly cards: CardRepo;
  private readonly harnesses: HarnessRepo;
  private readonly events: EventRepo;
  private readonly channels: ChannelService;
  private readonly audit: AuditService;
  private readonly clock: Clock;
  private readonly leaseSeconds: number;
  private readonly maxDepth: number;
  private readonly runtime: TaskServiceRuntime;

  constructor(deps: TaskServiceDeps) {
    this.db = deps.db;
    this.tasks = deps.tasks;
    this.cards = deps.cards;
    this.harnesses = deps.harnesses;
    this.events = deps.events;
    this.channels = deps.channels;
    this.audit = deps.audit;
    this.clock = deps.clock;
    this.leaseSeconds = deps.leaseSeconds;
    this.maxDepth = deps.maxDepth ?? MAX_DEPTH_DEFAULT;
    this.runtime = {
      db: this.db,
      tasks: this.tasks,
      cards: this.cards,
      harnesses: this.harnesses,
      events: this.events,
      channels: this.channels,
      audit: this.audit,
      clock: this.clock,
      leaseSeconds: this.leaseSeconds,
      maxDepth: this.maxDepth,
    };
  }

  create(
    input: TaskCreateInput,
    ctx: Ctx,
    options: { submit?: boolean } = {},
  ): { task: TaskView; created: boolean } {
    const { channel } = this.channels.ensure({ channel_key: input.channel_key }, ctx);
    if (input.idempotency_key) {
      // 幂等键只在「本通道」内生效（D-1）。跨通道用同一个键是另一件事：
      // 否则会返回别的通道的任务，并把这里刚 ensure 的通道留成空记录。
      const existing = this.tasks.findByIdem(channel.id, input.idempotency_key);
      if (existing) {
        this.audit.record(ctx, 'task.create', 'ok', 'task', existing.id, { idempotent: true });
        return { task: this.toView(existing, channel.channel_key), created: false };
      }
    }

    // 任务标题与描述会进入 MCP、Web、任务树，甚至被导出；与卡片正文共用同一套
    // 敏感模式扫描，避免令牌绕开 card.post 从“建任务”入口落库。
    assertNoSecrets({
      title: input.title,
      description_md: input.description_md ?? '',
    });

    const parent = input.parent_id ? this.requireTask(input.parent_id) : null;
    if (parent && parent.channel_id !== channel.id) {
      throw new AppError('INVALID_ARGUMENT', 'TASK_CHANNEL_MISMATCH', { task_id: parent.id });
    }
    const depth = parent ? depthOf(parent.path) + 1 : 1;
    if (depth > this.maxDepth) {
      throw new AppError('INVALID_ARGUMENT', 'TASK_DEPTH_EXCEEDED', { max_depth: this.maxDepth });
    }

    const now = this.clock.now();
    const id = newId('tk');
    const task: Task = {
      id,
      channel_id: channel.id,
      parent_id: parent?.id ?? null,
      path: `${parent?.path ?? '/'}${id}/`,
      title: input.title,
      description_md: input.description_md ?? null,
      // 建议任务默认停在 draft：draft → pending 由用户“批准”触发，
      // 不需要 agent 认领后再挂起（blocked 的 unblock 必须带 claim_token，令牌活不过会话）。
      kind: input.kind,
      // 空白分类按“未分类”处理：避免任务树出现一个看不见内容、却占着分类列的标签。
      category: input.category?.trim() || null,
      status: options.submit ? 'pending' : 'draft',
      priority: input.priority,
      assignee: input.assignee ?? null,
      tags_json: input.tags?.length ? JSON.stringify(input.tags) : null,
      due_at: input.due_at ? Date.parse(input.due_at) : null,
      claimed_by: null,
      claim_token: null,
      claim_expires_at: null,
      // 新建任务还没有经历任何状态事件，时间线全部为空；
      // 后续由 task-repo.claim / task-service.update 在事件发生时写入。
      claimed_at: null,
      started_at: null,
      blocked_at: null,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      blocked_reason: null,
      fail_reason: null,
      cancel_reason: null,
      // 新任务还没结束，自然没有“结束通知”可确认。
      end_notice_read_at: null,
      defer_reason: null,
      deferred_at: null,
      deferred_until: null,
      // 新任务还没有冒险记录；隐患由 flag_risk 事件写入，可发生在任何状态。
      risk_note: null,
      risk_flagged_at: null,
      risk_resolved_at: null,
      risk_resolution: null,
      evidence_json: null,
      idempotency_key: input.idempotency_key ?? null,
      created_by: ctx.actorLabel,
      created_at: now,
      updated_at: now,
    };

    txImmediate(this.db, () => {
      this.tasks.insert(task);
      this.events.task(id, 'created', ctx.actorLabel, { parent_id: task.parent_id }, now);
      if (options.submit) this.events.task(id, 'submitted', ctx.actorLabel, undefined, now);
      this.channels.touch(channel.id, now);
    });
    this.audit.record(ctx, 'task.create', 'ok', 'task', id, { channel_key: channel.channel_key });
    return { task: this.toView(task, channel.channel_key), created: true };
  }

  get(id: string): TaskView {
    return getTaskView(this.runtime, id);
  }

  list(
    filter: {
      channel_key?: string;
      status?: TaskStatus[];
      assignee?: string;
      /** true=曾经标记过隐患（含已解除）；复盘用。 */
      has_risk?: boolean;
      /** true=只看仍未解除的隐患。 */
      risk_open?: boolean;
      page?: number;
      page_size?: number;
    } = {},
    includeDescription = false,
  ): Page<TaskView> {
    return listTaskViews(this.runtime, filter, includeDescription);
  }

  tree(channelKey: string, maxDepth?: number, includeDescription = false): TreeNode[] {
    return taskTree(this.runtime, channelKey, maxDepth, includeDescription);
  }

  /**
   * 原子认领。失败语义：
   * - 别人正持有 → ALREADY_CLAIMED（可重试/换任务）
   * - 状态不是 pending 也不是过期租约 → CONFLICT
   * - 同一 harness 续租 → 沿用原令牌
   */
  claim(
    input: TaskClaimInput,
    ctx: Ctx,
  ): { task: TaskView; claim_token: string; lease_expires_at: string; renewed: boolean } {
    return claimTask(this.runtime, input, ctx);
  }

  update(input: TaskUpdateInput, ctx: Ctx): TaskView {
    return applyTaskUpdate(this.runtime, input, ctx);
  }

  release(input: TaskReleaseInput, ctx: Ctx): TaskView {
    return applyTaskRelease(this.runtime, input, ctx);
  }

  move(taskId: string, newParentId: string | null, ctx: Ctx): TaskView {
    const task = this.requireTask(taskId);
    const newParent = newParentId ? this.requireTask(newParentId) : null;
    if (newParent) {
      if (newParent.channel_id !== task.channel_id) {
        throw new AppError('INVALID_ARGUMENT', 'TASK_CHANNEL_MISMATCH', { task_id: newParent.id });
      }
      // 移到自己的子树里会让物化路径变成环，必须挡在写库之前。
      if (newParent.path.startsWith(task.path)) {
        throw new AppError('INVALID_ARGUMENT', 'TASK_CYCLE', { task_id: task.id });
      }
    }

    this.assertDepth(task, newParent);

    const now = this.clock.now();
    const oldPath = task.path;
    const newPath = `${newParent?.path ?? '/'}${task.id}/`;
    txImmediate(this.db, () => {
      this.tasks.rewriteSubtreePath(oldPath, newPath);
      this.tasks.updateFields(task.id, { parent_id: newParent?.id ?? null, updated_at: now });
      this.events.task(
        task.id,
        'moved',
        ctx.actorLabel,
        { from_parent: task.parent_id, to_parent: newParent?.id ?? null },
        now,
      );
    });
    this.audit.record(ctx, 'task.move', 'ok', 'task', task.id);
    return this.toView(this.tasks.get(task.id)!);
  }

  /** 复制子树：新节点一律 draft、无租约、无证据，避免“复制一份完成状态”的假象。 */
  copy(taskId: string, newParentId: string | null, ctx: Ctx): { task: TaskView; copied: number } {
    const source = this.requireTask(taskId);
    const newParent = newParentId ? this.requireTask(newParentId) : null;
    if (newParent && newParent.channel_id !== source.channel_id) {
      throw new AppError('INVALID_ARGUMENT', 'TASK_CHANNEL_MISMATCH', { task_id: newParent.id });
    }
    if (newParent && newParent.path.startsWith(source.path)) {
      throw new AppError('INVALID_ARGUMENT', 'TASK_CYCLE', { task_id: source.id });
    }
    this.assertDepth(source, newParent);

    const subtree = this.tasks.findSubtree(source.id);
    const now = this.clock.now();
    const idMap = new Map<string, string>();
    for (const node of subtree) idMap.set(node.id, newId('tk'));
    const newRootId = idMap.get(source.id)!;

    txImmediate(this.db, () => {
      // subtree 按 path 排序，父节点一定先于子节点插入，pathMap 可以边插边填。
      const pathMap = new Map<string, string>();
      for (const node of subtree) {
        const id = idMap.get(node.id)!;
        const mappedParent = node.parent_id ? idMap.get(node.parent_id) ?? null : null;
        const parentPath =
          node.id === source.id
            ? (newParent?.path ?? '/')
            : (pathMap.get(mappedParent ?? '') ?? '/');
        const path = `${parentPath}${id}/`;
        pathMap.set(id, path);
        const copy: Task = {
          ...node,
          id,
          parent_id: node.id === source.id ? (newParent?.id ?? null) : mappedParent,
          path,
          status: 'draft',
          claimed_by: null,
          claim_token: null,
          claim_expires_at: null,
          // 复制出来的任务是全新草稿：时间线必须从零开始，
          // 不能继承源任务的“已完成”“曾阻塞”等历史。
          claimed_at: null,
          started_at: null,
          blocked_at: null,
          completed_at: null,
          failed_at: null,
          cancelled_at: null,
          blocked_reason: null,
          fail_reason: null,
          cancel_reason: null,
          // 结束通知属于“源任务那一次结束”，复制出的草稿从未结束，不能继承已读/未读状态。
          end_notice_read_at: null,
          // 复制出来的是全新草稿：不继承“暂缓”，否则新任务一出生就带着旧排期。
          defer_reason: null,
          deferred_at: null,
          deferred_until: null,
          // 隐患是“当时那次交付”的历史，不是任务模板的一部分。
          // 若整列复制，新草稿会凭空出现早于 created_at 的隐患时间线，
          // 并被 has_risk/risk_open 统计成一条从未发生过的带病交付。
          risk_note: null,
          risk_flagged_at: null,
          risk_resolved_at: null,
          risk_resolution: null,
          evidence_json: null,
          idempotency_key: null,
          created_by: ctx.actorLabel,
          created_at: now,
          updated_at: now,
        };
        this.tasks.insert(copy);
        this.events.task(id, 'created', ctx.actorLabel, { copied_from: node.id }, now);
      }
    });
    this.audit.record(ctx, 'task.copy', 'ok', 'task', newRootId, {
      source_task_id: source.id,
      copied: subtree.length,
    });
    return { task: this.toView(this.tasks.get(newRootId)!), copied: subtree.length };
  }

  /**
   * 确认某条已结束任务的“结束通知”。
   *
   * 只允许终态任务：未结束的任务没有结束通知，静默成功会让调用方误以为
   * 自己确认了什么。重复确认是幂等的——保留第一次的已读时间，不刷新，
   * 这样“我是什么时候看到它结束的”不会被第二次点击覆盖。
   *
   * 不更新 updated_at：已读是查看回执，不是任务内容变化；
   * 刷新它会让任务在“最近更新”里跳动，并让用户误以为任务被改过。
   */
  ackEndNotice(taskId: string, ctx: Ctx): TaskView {
    const task = this.requireTask(taskId);
    if (!isTerminalTaskStatus(task.status)) {
      throw new AppError('CONFLICT', 'TASK_NOT_ENDED', {
        task_id: task.id,
        status: task.status,
      });
    }
    if (task.end_notice_read_at !== null) return this.toView(task);

    const now = this.clock.now();
    txImmediate(this.db, () => {
      this.tasks.updateFields(task.id, { end_notice_read_at: now });
      this.events.task(task.id, 'end_notice_acked', ctx.actorLabel, undefined, now);
    });
    this.audit.record(ctx, 'task.ack_end_notice', 'ok', 'task', task.id);
    return this.toView(this.tasks.get(task.id)!);
  }

  /** 租约回收 worker 调用；返回被回收的数量。 */
  expireLeases(now: number): number {
    return expireTaskLeases(this.tasks, now);
  }

  private assertDepth(task: Task, newParent: Task | null): void {
    assertTaskDepth(this.runtime, task, newParent);
  }

  private requireTask(id: string): Task {
    return requireTask(this.tasks, id);
  }

  private toView(
    task: Task,
    channelKey?: string,
    includeDescription = true,
    unreadCount?: number,
  ): TaskView {
    return taskToView(this.runtime, task, channelKey, includeDescription, unreadCount);
  }
}
