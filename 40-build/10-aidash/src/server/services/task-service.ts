import type { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { newClaimToken, newId } from '../../shared/ids.js';
import {
  taskClaimSchema,
  taskCreateSchema,
  taskReleaseSchema,
  taskUpdateSchema,
} from '../../shared/schemas.js';
import type { Clock } from '../../shared/time.js';
import type { Card, Ctx, Page, Task, TaskStatus, TaskView, TreeNode } from '../../shared/types.js';
import { txImmediate, type Db } from '../db/connection.js';
import type { CardRepo } from '../repos/card-repo.js';
import type { EventRepo, HarnessRepo } from '../repos/support-repos.js';
import type { TaskRepo } from '../repos/task-repo.js';
import { toTaskView } from '../repos/task-repo.js';
import type { AuditService } from './audit-service.js';
import type { ChannelService } from './channel-service.js';
import {
  assertClaimToken,
  assertTaskTransition,
  cancelNeedsToken,
  isDeferEvent,
  isRiskEvent,
  type TaskDeferEvent,
  type TaskRiskEvent,
  type TaskStatusEvent,
} from './state-machine.js';

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
export type TaskClaimInput = z.infer<typeof taskClaimSchema>;
export type TaskReleaseInput = z.infer<typeof taskReleaseSchema>;

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

/** 哪些事件必须带令牌；cancel 只在已认领状态下需要，单独判断。 */
const TASK_EVENT_NEEDS_TOKEN: Record<TaskStatusEvent, boolean> = {
  submit: false,
  start: true,
  block: true,
  unblock: true,
  complete: true,
  fail: true,
  cancel: true,
  release: true,
};

/**
 * task_event 只记录“改了哪些字段”，不复制字段全文。
 *
 * description_md 可以内嵌 base64 截图（单条上限 2,000,000 字符）。原样把 patch 写进
 * detail_json，等于用户每点一次“保存字段”就在事件表里再存一份截图，数据库会迅速膨胀；
 * 审计真正需要的是“描述被改过、改成了多长”，正文本身已经在 task 行上。
 */
function summarizePatch(patch: Partial<Task>): Record<string, unknown> {
  const detail: Record<string, unknown> = { ...patch };
  if (typeof detail.description_md === 'string') {
    detail.description_md = `[omitted ${detail.description_md.length} chars]`;
  }
  return detail;
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
  }

  create(
    input: TaskCreateInput,
    ctx: Ctx,
    options: { submit?: boolean } = {},
  ): { task: TaskView; created: boolean } {
    const { channel } = this.channels.ensure({ channel_key: input.channel_key }, ctx);
    if (input.idempotency_key) {
      const existing = this.tasks.findByIdem(input.idempotency_key);
      if (existing) {
        this.audit.record(ctx, 'task.create', 'ok', 'task', existing.id, { idempotent: true });
        return { task: this.toView(existing, channel.channel_key), created: false };
      }
    }

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
    return this.toView(this.requireTask(id));
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
    const channel = filter.channel_key
      ? this.channels.getByKeyOrThrow(filter.channel_key)
      : undefined;
    const page = this.tasks.list(
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
    const unread = this.cards.countUnreadForTasks(page.items.map((task) => task.id));
    return {
      ...page,
      items: page.items.map((task) =>
        this.toView(task, channel?.channel_key, includeDescription, unread.get(task.id) ?? 0),
      ),
    };
  }

  tree(channelKey: string, maxDepth?: number, includeDescription = false): TreeNode[] {
    const channel = this.channels.getByKeyOrThrow(channelKey);
    const roots = this.tasks.tree(channel.id, includeDescription);
    // 整条通道的未读数一次取出，按 task_id 填到节点上；
    // 树可能有上千个节点，逐节点查会把一次树请求放大成 N+1。
    const unread = this.cards.countUnreadByTask(channel.id);
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
    const task = this.requireTask(input.task_id);
    if (!this.harnesses.get(input.harness_id)) {
      throw new AppError('INVALID_ARGUMENT', 'HARNESS_NOT_REGISTERED', {
        harness_id: input.harness_id,
      });
    }
    const lease = clamp(input.lease_seconds ?? this.leaseSeconds, 1, 86_400);
    const now = this.clock.now();
    const token = input.claim_token?.trim() || newClaimToken();
    const outcome = this.tasks.claim(task.id, input.harness_id, token, now, lease);
    if (!outcome.ok) {
      if (outcome.reason === 'ALREADY_CLAIMED') {
        throw new AppError('ALREADY_CLAIMED', 'TASK_ALREADY_CLAIMED', { task_id: task.id });
      }
      if (outcome.reason === 'NOT_CLAIMABLE') {
        throw new AppError('CONFLICT', 'TASK_NOT_CLAIMABLE', {
          task_id: task.id,
          status: outcome.task?.status,
        });
      }
      throw new AppError('NOT_FOUND', 'TASK_NOT_FOUND', { task_id: task.id });
    }

    const claimed = outcome.task!;
    txImmediate(this.db, () => {
      this.events.task(
        task.id,
        outcome.renewed ? 'lease_renewed' : 'claimed',
        ctx.actorLabel,
        { harness_id: input.harness_id, lease_seconds: lease },
        now,
      );
    });
    this.audit.record(ctx, outcome.renewed ? 'task.renew' : 'task.claim', 'ok', 'task', task.id, {
      harness_id: input.harness_id,
    });
    return {
      task: this.toView(claimed),
      claim_token: outcome.claimToken!,
      lease_expires_at: new Date(claimed.claim_expires_at!).toISOString(),
      renewed: outcome.renewed ?? false,
    };
  }

  update(input: TaskUpdateInput, ctx: Ctx): TaskView {
    const task = this.requireTask(input.task_id);
    const now = this.clock.now();
    const patch = this.buildPatch(input);

    if (!input.event) {
      if (Object.keys(patch).length === 0) {
        throw new AppError('INVALID_ARGUMENT', 'NOTHING_TO_UPDATE');
      }
      txImmediate(this.db, () => {
        this.tasks.updateFields(task.id, { ...patch, updated_at: now });
        this.events.task(task.id, 'updated', ctx.actorLabel, summarizePatch(patch), now);
      });
      this.audit.record(ctx, 'task.update', 'ok', 'task', task.id);
      return this.toView(this.tasks.get(task.id)!);
    }

    if (input.event === 'release') {
      return this.release(
        {
          task_id: task.id,
          claim_token: input.claim_token ?? '',
          reason: input.reason ?? 'released',
        },
        ctx,
      );
    }

    // defer/undefer、flag_risk/unflag_risk 都不改变状态，必须在状态转移校验
    // 之前分流：它们不是 TASK_TRANSITIONS 里的边，硬塞进去会变成
    // “自己指向自己”的假状态机。
    const rawEvent = input.event;
    if (isDeferEvent(rawEvent)) {
      return this.updateDeferral(task, rawEvent, input, patch, ctx);
    }
    if (isRiskEvent(rawEvent)) {
      return this.updateRisk(task, rawEvent, input, patch, ctx);
    }
    const event = rawEvent;
    const target = assertTaskTransition(task, event);

    const tokenApplies =
      event === 'cancel' ? cancelNeedsToken(task.status) : TASK_EVENT_NEEDS_TOKEN[event];
    if (tokenApplies) assertClaimToken(task, input.claim_token);

    // 三种“非正常结束/暂停”都必须写原由：阻塞、失败、取消。
    // 没有原由的任务在任务树里只是一个状态词，用户无法判断该不该继续或忽略它。
    if ((event === 'block' || event === 'fail' || event === 'cancel') && !input.reason?.trim()) {
      throw new AppError('INVALID_ARGUMENT', 'REASON_REQUIRED', { event });
    }

    if (event === 'complete') {
      patch.evidence_json = JSON.stringify(this.resolveEvidence(task, input.evidence_card_ids));
    }
    // 状态时间线：每个事件写自己的时刻，而不是依赖 updated_at。
    // 原因：updated_at 会被改名/改优先级等无关操作刷新，无法回答“什么时候开始干的”。
    if (event === 'start') patch.started_at = now;
    if (event === 'block') {
      patch.blocked_reason = input.reason!.trim();
      patch.blocked_at = now;
    }
    // unblock 刻意不改写 blocked_at：它记录“最近一次被阻塞”的历史，
    // 页面需要用它算阻塞时长；清空会让这段历史丢失。
    if (event === 'complete') patch.completed_at = now;
    if (event === 'fail') {
      patch.fail_reason = input.reason!.trim();
      patch.failed_at = now;
    }
    // cancel 可能从 draft/pending 直接发生（没有 claim_token），
    // 因此不能只在 claim 路径写时间，必须在这里兜底。
    // 原因也要落库：与 blocked/fail 一致，终态必须能回答“为什么”。
    if (event === 'cancel') {
      patch.cancelled_at = now;
      patch.cancel_reason = input.reason!.trim();
    }

    const isTerminal = target === 'done' || target === 'failed' || target === 'cancelled';
    txImmediate(this.db, () => {
      this.tasks.updateFields(task.id, {
        ...patch,
        status: target,
        ...(isTerminal
          ? {
              claim_token: null,
              claim_expires_at: null,
              // 每次进入终态都重新产生一条结束通知：即使任务以前结束过又被人改写状态，
              // 用户也需要看到“这次真的结束了”，不能沿用上一次的已读时间。
              end_notice_read_at: null,
              // 终态不再需要“暂缓”标记；留着会让已取消/已完成的任务仍显示“已暂缓”。
              defer_reason: null,
              deferred_at: null,
              deferred_until: null,
            }
          : { claim_token: task.claim_token, claim_expires_at: task.claim_expires_at }),
        updated_at: now,
      });
      this.events.task(task.id, event, ctx.actorLabel, { reason: input.reason ?? null }, now);
      this.channels.touch(task.channel_id, now);
    });
    this.audit.record(ctx, `task.${event}`, 'ok', 'task', task.id, {
      from: task.status,
      to: target,
    });
    return this.toView(this.tasks.get(task.id)!);
  }

  release(input: TaskReleaseInput, ctx: Ctx): TaskView {
    const task = this.requireTask(input.task_id);
    const now = this.clock.now();
    if (!this.tasks.release(task.id, input.claim_token, now)) {
      throw new AppError('FORBIDDEN', 'CLAIM_TOKEN_MISMATCH', { guard: 'G-T02' });
    }
    this.events.task(task.id, 'released', ctx.actorLabel, { reason: input.reason }, now);
    this.audit.record(ctx, 'task.release', 'ok', 'task', task.id, { reason: input.reason });
    return this.toView(this.tasks.get(task.id)!);
  }

  /**
   * 暂缓/取消暂缓：只改覆盖层，不改状态。
   *
   * 为什么允许 draft：用户可能先记一条草稿、决定“这周不做”，
   * 但草稿还没提交，用 blocked 会伪造“有人认领过”。
   * 为什么不允许 in_progress：正在执行的任务想暂停应走 block，
   * 否则会出现“正在做”和“已暂缓”同时成立。
   */
  private updateDeferral(
    task: Task,
    event: TaskDeferEvent,
    input: TaskUpdateInput,
    patch: Partial<Task>,
    ctx: Ctx,
  ): TaskView {
    const now = this.clock.now();

    if (event === 'defer') {
      if (task.status !== 'draft' && task.status !== 'pending') {
        throw new AppError('CONFLICT', 'TASK_STATE_INVALID', {
          guard: 'G-T01',
          event,
          from: task.status,
          allowed_from: ['draft', 'pending'],
        });
      }
      const reason = input.reason?.trim();
      if (!reason) {
        throw new AppError('INVALID_ARGUMENT', 'REASON_REQUIRED', { event });
      }
      const until = input.deferred_until ? Date.parse(input.deferred_until) : null;

      txImmediate(this.db, () => {
        this.tasks.updateFields(task.id, {
          // 覆盖层事件不改变 status，但允许同一次调用顺带改标题/优先级等字段。
          // 契约 04 明确 event 与 patch 可以同时给出；静默丢弃会让调用方以为改成功了。
          ...patch,
          defer_reason: reason,
          deferred_at: now,
          deferred_until: until,
          updated_at: now,
        });
        this.events.task(
          task.id,
          'deferred',
          ctx.actorLabel,
          { reason, deferred_until: until === null ? null : new Date(until).toISOString() },
          now,
        );
        this.channels.touch(task.channel_id, now);
      });
      this.audit.record(ctx, 'task.defer', 'ok', 'task', task.id, {
        reason,
        deferred_until: until === null ? null : new Date(until).toISOString(),
      });
      return this.toView(this.tasks.get(task.id)!);
    }

    if (!task.defer_reason) {
      throw new AppError('CONFLICT', 'TASK_NOT_DEFERRED', { task_id: task.id });
    }
    txImmediate(this.db, () => {
      this.tasks.updateFields(task.id, {
        ...patch,
        defer_reason: null,
        deferred_at: null,
        deferred_until: null,
        updated_at: now,
      });
      this.events.task(task.id, 'undeferred', ctx.actorLabel, undefined, now);
      this.channels.touch(task.channel_id, now);
    });
    this.audit.record(ctx, 'task.undefer', 'ok', 'task', task.id);
    return this.toView(this.tasks.get(task.id)!);
  }

  /**
   * 标记/解除“隐患”（带病完成的风险留档）。
   *
   * 与 defer 相反：
   * - 可作用于任何状态，包括 done/failed——复盘时补记“当时是带隐患交付”；
   * - 不改 status，也不需要 claim_token：任务完成后令牌早已释放，
   *   若仍要求令牌，事后复盘就无法标记；
   * - 解除只写 risk_resolved_at，不删 note 与原始标记时间：判断留档，
   *   列表仍能按“曾经带隐患”筛出历史。
   */
  private updateRisk(
    task: Task,
    event: TaskRiskEvent,
    input: TaskUpdateInput,
    patch: Partial<Task>,
    ctx: Ctx,
  ): TaskView {
    const now = this.clock.now();

    if (event === 'flag_risk') {
      const note = input.reason?.trim();
      if (!note) {
        throw new AppError('INVALID_ARGUMENT', 'REASON_REQUIRED', { event });
      }
      txImmediate(this.db, () => {
        this.tasks.updateFields(task.id, {
          // 同一次调用允许顺带改标题/优先级等字段；覆盖层事件不应吞掉 patch。
          ...patch,
          risk_note: note,
          risk_flagged_at: now,
          // 重新标记表示风险再次出现（或上次解除判断有误），
          // 把解除时间与旧结论一起清掉：新一轮风险需要新的复盘。
          risk_resolved_at: null,
          risk_resolution: null,
          updated_at: now,
        });
        this.events.task(task.id, 'risk_flagged', ctx.actorLabel, { reason: note }, now);
        this.channels.touch(task.channel_id, now);
      });
      this.audit.record(ctx, 'task.flag_risk', 'ok', 'task', task.id, { status: task.status });
      return this.toView(this.tasks.get(task.id)!);
    }

    if (!task.risk_note) {
      throw new AppError('CONFLICT', 'TASK_RISK_NOT_FLAGGED', { task_id: task.id });
    }
    if (task.risk_resolved_at !== null) {
      throw new AppError('CONFLICT', 'TASK_RISK_ALREADY_RESOLVED', { task_id: task.id });
    }
    // 解除说明可选：允许只点“解除”，也允许顺手写一句复盘结论
    //（例如“风险未发生，判断正确”），两种都要能落库。
    const resolution = input.reason?.trim() || null;
    txImmediate(this.db, () => {
      this.tasks.updateFields(task.id, {
        ...patch,
        risk_resolved_at: now,
        // 结论落任务行，Web 详情与复盘列表才能直接读到；
        // 同时仍写进事件 payload，保留不可变的审计流水。
        risk_resolution: resolution,
        updated_at: now,
      });
      this.events.task(
        task.id,
        'risk_unflagged',
        ctx.actorLabel,
        { note: task.risk_note, resolution },
        now,
      );
      this.channels.touch(task.channel_id, now);
    });
    this.audit.record(ctx, 'task.unflag_risk', 'ok', 'task', task.id, { resolution });
    return this.toView(this.tasks.get(task.id)!);
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
    return this.tasks.expireLeases(now);
  }

  private assertDepth(task: Task, newParent: Task | null): void {
    const subtree = this.tasks.findSubtree(task.id);
    const taskDepth = depthOf(task.path);
    const maxDescendantDepth = Math.max(...subtree.map((node) => depthOf(node.path)));
    const newDepth = (newParent ? depthOf(newParent.path) : 0) + 1;
    if (newDepth + (maxDescendantDepth - taskDepth) > this.maxDepth) {
      throw new AppError('INVALID_ARGUMENT', 'TASK_DEPTH_EXCEEDED', { max_depth: this.maxDepth });
    }
  }

  private resolveEvidence(task: Task, provided: string[] | undefined): string[] {
    if (provided?.length) {
      const cards = this.cards.findByIds(provided);
      if (cards.length !== provided.length) {
        const found = new Set(cards.map((card) => card.id));
        throw new AppError('INVALID_ARGUMENT', 'EVIDENCE_CARD_NOT_FOUND', {
          missing: provided.filter((id) => !found.has(id)),
        });
      }
      for (const card of cards) assertEvidenceCard(task, card);
      return provided;
    }

    const linked = this.cards.findEvidenceCards(task.id).filter(isEvidenceCard);
    if (linked.length === 0) {
      throw new AppError('EVIDENCE_REQUIRED', 'EVIDENCE_REQUIRED', { guard: 'G-T08' });
    }
    return linked.map((card) => card.id);
  }

  private buildPatch(input: TaskUpdateInput): Partial<Task> {
    const patch: Partial<Task> = {};
    if (!input.patch) return patch;
    if (input.patch.title !== undefined) patch.title = input.patch.title;
    if (input.patch.description_md !== undefined) patch.description_md = input.patch.description_md;
    // null 与空串都落到 NULL：分类是单值列，空字符串会让任务树显示一个空标签。
    if (input.patch.category !== undefined) patch.category = input.patch.category?.trim() || null;
    if (input.patch.priority !== undefined) patch.priority = input.patch.priority;
    if (input.patch.assignee !== undefined) patch.assignee = input.patch.assignee;
    if (input.patch.tags !== undefined) {
      patch.tags_json = input.patch.tags.length ? JSON.stringify(input.patch.tags) : null;
    }
    if (input.patch.due_at !== undefined) {
      patch.due_at = input.patch.due_at === null ? null : Date.parse(input.patch.due_at);
    }
    return patch;
  }

  private requireTask(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new AppError('NOT_FOUND', 'TASK_NOT_FOUND', { task_id: id });
    return task;
  }

  private toView(
    task: Task,
    channelKey?: string,
    includeDescription = true,
    unreadCount?: number,
  ): TaskView {
    const key = channelKey ?? this.channels.getOrThrow(task.channel_id).channel_key;
    // 单任务详情/写操作响应没批量上下文，这里补一次计数；
    // 列表与树已经批量算好，传进来避免重复查询。
    const count = unreadCount ?? this.cards.countUnreadForTask(task.id);
    return toTaskView(task, key, includeDescription, count);
  }
}

function depthOf(path: string): number {
  return path.split('/').filter(Boolean).length;
}

/** 终态判定只在服务内使用；与 task-repo 的视图派生保持同一组状态。 */
function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isEvidenceCard(card: Card): boolean {
  if (card.status === 'archived') return false;
  if (card.type === 'status') return Boolean(card.summary?.trim());
  if (card.type === 'artifact') return Boolean(card.artifact_url?.trim());
  return false;
}

function assertEvidenceCard(task: Task, card: Card): void {
  if (card.task_id !== task.id) {
    throw new AppError('INVALID_ARGUMENT', 'EVIDENCE_INVALID', {
      card_id: card.id,
      reason: 'not_linked_to_task',
    });
  }
  if (!isEvidenceCard(card)) {
    throw new AppError('INVALID_ARGUMENT', 'EVIDENCE_INVALID', {
      card_id: card.id,
      reason: 'must_be_status_with_summary_or_artifact_with_url',
    });
  }
}
