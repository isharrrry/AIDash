import type { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { assertNoSecrets } from '../../shared/secrets.js';
import { taskReleaseSchema, taskUpdateSchema } from '../../shared/schemas.js';
import type { Clock } from '../../shared/time.js';
import type { Card, Ctx, Task, TaskStatus, TaskView } from '../../shared/types.js';
import { txImmediate, type Db } from '../db/connection.js';
import type { EventRepo } from '../repos/support-repos.js';
import type { AuditService } from './audit-service.js';
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
import {
  requireTask,
  taskToView,
  type TaskQueryDeps,
} from './task-service-query.js';

/**
 * TaskService 的状态事件。
 *
 * 为什么单独拆出来：update 是一种事务脚本——先校验状态/令牌/原因，
 * 再把字段、时间线、事件与审计一次写入。defer / risk 是覆盖层事件，
 * 必须在状态转移校验之前分流。把它们与查询、认领分开，
 * 失败语义（CONFLICT / INVALID_ARGUMENT / FORBIDDEN）才能一眼看清。
 */

export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
export type TaskReleaseInput = z.infer<typeof taskReleaseSchema>;

export interface TaskStateDeps extends TaskQueryDeps {
  db: Db;
  events: EventRepo;
  audit: AuditService;
  clock: Clock;
}

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
  // failed 进入终态时令牌已清空；重排若再要求令牌，就永远无法从 failed 出来。
  retry: false,
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

export function applyTaskUpdate(
  deps: TaskStateDeps,
  input: TaskUpdateInput,
  ctx: Ctx,
): TaskView {
  const task = requireTask(deps.tasks, input.task_id);
  const now = deps.clock.now();
  const patch = buildPatch(input);

  // 所有 reason 最终都会落库：block/fail/cancel/retry 写原因列，defer/risk 写覆盖层
  // 或复盘结论；patch 里的标题/描述与创建走同一套规则。
  assertNoSecrets({
    title: patch.title ?? '',
    description_md: patch.description_md ?? '',
    reason: input.reason ?? '',
  });

  if (!input.event) {
    if (Object.keys(patch).length === 0) {
      throw new AppError('INVALID_ARGUMENT', 'NOTHING_TO_UPDATE');
    }
    txImmediate(deps.db, () => {
      deps.tasks.updateFields(task.id, { ...patch, updated_at: now });
      deps.events.task(task.id, 'updated', ctx.actorLabel, summarizePatch(patch), now);
    });
    deps.audit.record(ctx, 'task.update', 'ok', 'task', task.id);
    return taskToView(deps, deps.tasks.get(task.id)!);
  }

  if (input.event === 'release') {
    return applyTaskRelease(
      deps,
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
    return updateDeferral(deps, task, rawEvent, input, patch, ctx);
  }
  if (isRiskEvent(rawEvent)) {
    return updateRisk(deps, task, rawEvent, input, patch, ctx);
  }
  const event = rawEvent;
  const target = assertTaskTransition(task, event);

  const tokenApplies =
    event === 'cancel' ? cancelNeedsToken(task.status) : TASK_EVENT_NEEDS_TOKEN[event];
  if (tokenApplies) assertClaimToken(task, input.claim_token);

  // 三种“非正常结束/暂停”都必须写原由：阻塞、失败、取消。
  // 没有原由的任务在任务树里只是一个状态词，用户无法判断该不该继续或忽略它。
  // retry 同样要求理由：重排会让任务重新进入队列并消耗他人时间，
  // “为什么重做”必须留在时间线上，否则下一位认领者不知道上一轮为何失败。
  if (
    (event === 'block' || event === 'fail' || event === 'cancel' || event === 'retry') &&
    !input.reason?.trim()
  ) {
    throw new AppError('INVALID_ARGUMENT', 'REASON_REQUIRED', { event });
  }

  if (event === 'complete') {
    patch.evidence_json = JSON.stringify(resolveEvidence(deps, task, input.evidence_card_ids));
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
  // retry：把 failed 任务放回待认领队列。失败原因与租约都是“上一轮”的痕迹，
  // 必须清掉，否则任务回到 pending 仍显示失败原因；started_at/claimed_at 则保留——
  // 它们回答“上次谁在什么时候开工”，与 release 的语义一致，不能抹成“从未开始”。
  // 不能复用下方 isTerminal 分支：retry 的目标是 pending，且不应清空暂缓/结束通知字段。
  if (event === 'retry') {
    patch.fail_reason = null;
    patch.failed_at = null;
    patch.claimed_by = null;
    patch.claim_token = null;
    patch.claim_expires_at = null;
  }
  // cancel 可能从 draft/pending 直接发生（没有 claim_token），
  // 因此不能只在 claim 路径写时间，必须在这里兜底。
  // 原因也要落库：与 blocked/fail 一致，终态必须能回答“为什么”。
  if (event === 'cancel') {
    patch.cancelled_at = now;
    patch.cancel_reason = input.reason!.trim();
  }

  const isTerminal = target === 'done' || target === 'failed' || target === 'cancelled';
  txImmediate(deps.db, () => {
    deps.tasks.updateFields(task.id, {
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
        : event === 'retry'
          ? // 重排必须显式清空租约列，而不能沿用“非终态保持原值”的分支：
            // 即使历史上存在令牌未清干净的 failed 行（例如手工改库），
            // retry 之后也不能把旧令牌带进新的 pending 周期。
            { claim_token: null, claim_expires_at: null }
          : { claim_token: task.claim_token, claim_expires_at: task.claim_expires_at }),
      updated_at: now,
    });
    deps.events.task(task.id, event, ctx.actorLabel, { reason: input.reason ?? null }, now);
    deps.channels.touch(task.channel_id, now);
  });
  deps.audit.record(ctx, `task.${event}`, 'ok', 'task', task.id, {
    from: task.status,
    to: target,
  });
  return taskToView(deps, deps.tasks.get(task.id)!);
}

export function applyTaskRelease(
  deps: TaskStateDeps,
  input: TaskReleaseInput,
  ctx: Ctx,
): TaskView {
  const task = requireTask(deps.tasks, input.task_id);
  const now = deps.clock.now();
  if (!deps.tasks.release(task.id, input.claim_token, now)) {
    throw new AppError('FORBIDDEN', 'CLAIM_TOKEN_MISMATCH', { guard: 'G-T02' });
  }
  deps.events.task(task.id, 'released', ctx.actorLabel, { reason: input.reason }, now);
  deps.audit.record(ctx, 'task.release', 'ok', 'task', task.id, { reason: input.reason });
  return taskToView(deps, deps.tasks.get(task.id)!);
}

/**
 * 暂缓/取消暂缓：只改覆盖层，不改状态。
 *
 * 为什么允许 draft：用户可能先记一条草稿、决定“这周不做”，
 * 但草稿还没提交，用 blocked 会伪造“有人认领过”。
 * 为什么不允许 in_progress：正在执行的任务想暂停应走 block，
 * 否则会出现“正在做”和“已暂缓”同时成立。
 */
function updateDeferral(
  deps: TaskStateDeps,
  task: Task,
  event: TaskDeferEvent,
  input: TaskUpdateInput,
  patch: Partial<Task>,
  ctx: Ctx,
): TaskView {
  const now = deps.clock.now();

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

    txImmediate(deps.db, () => {
      deps.tasks.updateFields(task.id, {
        // 覆盖层事件不改变 status，但允许同一次调用顺带改标题/优先级等字段。
        // 契约 04 明确 event 与 patch 可以同时给出；静默丢弃会让调用方以为改成功了。
        ...patch,
        defer_reason: reason,
        deferred_at: now,
        deferred_until: until,
        updated_at: now,
      });
      deps.events.task(
        task.id,
        'deferred',
        ctx.actorLabel,
        { reason, deferred_until: until === null ? null : new Date(until).toISOString() },
        now,
      );
      deps.channels.touch(task.channel_id, now);
    });
    deps.audit.record(ctx, 'task.defer', 'ok', 'task', task.id, {
      reason,
      deferred_until: until === null ? null : new Date(until).toISOString(),
    });
    return taskToView(deps, deps.tasks.get(task.id)!);
  }

  if (!task.defer_reason) {
    throw new AppError('CONFLICT', 'TASK_NOT_DEFERRED', { task_id: task.id });
  }
  txImmediate(deps.db, () => {
    deps.tasks.updateFields(task.id, {
      ...patch,
      defer_reason: null,
      deferred_at: null,
      deferred_until: null,
      updated_at: now,
    });
    deps.events.task(task.id, 'undeferred', ctx.actorLabel, undefined, now);
    deps.channels.touch(task.channel_id, now);
  });
  deps.audit.record(ctx, 'task.undefer', 'ok', 'task', task.id);
  return taskToView(deps, deps.tasks.get(task.id)!);
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
function updateRisk(
  deps: TaskStateDeps,
  task: Task,
  event: TaskRiskEvent,
  input: TaskUpdateInput,
  patch: Partial<Task>,
  ctx: Ctx,
): TaskView {
  const now = deps.clock.now();

  if (event === 'flag_risk') {
    const note = input.reason?.trim();
    if (!note) {
      throw new AppError('INVALID_ARGUMENT', 'REASON_REQUIRED', { event });
    }
    txImmediate(deps.db, () => {
      deps.tasks.updateFields(task.id, {
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
      deps.events.task(task.id, 'risk_flagged', ctx.actorLabel, { reason: note }, now);
      deps.channels.touch(task.channel_id, now);
    });
    deps.audit.record(ctx, 'task.flag_risk', 'ok', 'task', task.id, { status: task.status });
    return taskToView(deps, deps.tasks.get(task.id)!);
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
  txImmediate(deps.db, () => {
    deps.tasks.updateFields(task.id, {
      ...patch,
      risk_resolved_at: now,
      // 结论落任务行，Web 详情与复盘列表才能直接读到；
      // 同时仍写进事件 payload，保留不可变的审计流水。
      risk_resolution: resolution,
      updated_at: now,
    });
    deps.events.task(
      task.id,
      'risk_unflagged',
      ctx.actorLabel,
      { note: task.risk_note, resolution },
      now,
    );
    deps.channels.touch(task.channel_id, now);
  });
  deps.audit.record(ctx, 'task.unflag_risk', 'ok', 'task', task.id, { resolution });
  return taskToView(deps, deps.tasks.get(task.id)!);
}

function resolveEvidence(deps: TaskStateDeps, task: Task, provided: string[] | undefined): string[] {
  if (provided?.length) {
    // 同一张卡传两次是调用方的冗余，不是「卡不存在」：先去重再比对。
    // 否则 findByIds 的结果集天然去重，`cards.length !== provided.length`
    // 会误报 EVIDENCE_CARD_NOT_FOUND，而 missing 又是空数组，
    // 错误码与详情自相矛盾（D-2）。
    const unique = [...new Set(provided)];
    const cards = deps.cards.findByIds(unique);
    if (cards.length !== unique.length) {
      const found = new Set(cards.map((card) => card.id));
      throw new AppError('INVALID_ARGUMENT', 'EVIDENCE_CARD_NOT_FOUND', {
        missing: unique.filter((id) => !found.has(id)),
      });
    }
    for (const card of cards) assertEvidenceCard(task, card);
    return unique;
  }

  const linked = deps.cards.findEvidenceCards(task.id).filter(isEvidenceCard);
  if (linked.length === 0) {
    throw new AppError('EVIDENCE_REQUIRED', 'EVIDENCE_REQUIRED', { guard: 'G-T08' });
  }
  return linked.map((card) => card.id);
}

function buildPatch(input: TaskUpdateInput): Partial<Task> {
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

/** 终态判定只在服务内使用；与 task-repo 的视图派生保持同一组状态。 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
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
