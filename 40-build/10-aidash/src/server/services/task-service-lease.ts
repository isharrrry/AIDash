import type { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { newClaimToken } from '../../shared/ids.js';
import { taskClaimSchema } from '../../shared/schemas.js';
import type { Clock } from '../../shared/time.js';
import type { Ctx, Task, TaskView } from '../../shared/types.js';
import { txImmediate, type Db } from '../db/connection.js';
import type { EventRepo, HarnessRepo } from '../repos/support-repos.js';
import type { TaskRepo } from '../repos/task-repo.js';
import type { AuditService } from './audit-service.js';
import { requireTask, taskToView, type TaskQueryDeps } from './task-service-query.js';

/**
 * TaskService 的认领与租约、以及树深度校验。
 *
 * 为什么拆出来：认领是“校验 harness + 原子 UPDATE + 写事件 + 审计”的独立事务链；
 * 深度校验只读物化路径。两者都不碰状态事件表，放在主服务里会把
 * “改状态”和“抢任务”两种失败语义混在一起。
 */

export type TaskClaimInput = z.infer<typeof taskClaimSchema>;

export interface TaskLeaseDeps extends TaskQueryDeps {
  db: Db;
  harnesses: HarnessRepo;
  events: EventRepo;
  audit: AuditService;
  clock: Clock;
  leaseSeconds: number;
  maxDepth: number;
}

/**
 * 原子认领。失败语义：
 * - 别人正持有 → ALREADY_CLAIMED（可重试/换任务）
 * - 状态不是 pending 也不是过期租约 → CONFLICT
 * - 同一 harness 续租 → 沿用原令牌
 */
export function claimTask(
  deps: TaskLeaseDeps,
  input: TaskClaimInput,
  ctx: Ctx,
): { task: TaskView; claim_token: string; lease_expires_at: string; renewed: boolean } {
  const task = requireTask(deps.tasks, input.task_id);
  if (!deps.harnesses.get(input.harness_id)) {
    throw new AppError('INVALID_ARGUMENT', 'HARNESS_NOT_REGISTERED', {
      harness_id: input.harness_id,
    });
  }
  const lease = clamp(input.lease_seconds ?? deps.leaseSeconds, 1, 86_400);
  const now = deps.clock.now();
  const token = input.claim_token?.trim() || newClaimToken();
  const outcome = deps.tasks.claim(task.id, input.harness_id, token, now, lease);
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
  txImmediate(deps.db, () => {
    deps.events.task(
      task.id,
      outcome.renewed ? 'lease_renewed' : 'claimed',
      ctx.actorLabel,
      { harness_id: input.harness_id, lease_seconds: lease },
      now,
    );
  });
  deps.audit.record(ctx, outcome.renewed ? 'task.renew' : 'task.claim', 'ok', 'task', task.id, {
    harness_id: input.harness_id,
  });
  return {
    task: taskToView(deps, claimed),
    claim_token: outcome.claimToken!,
    lease_expires_at: new Date(claimed.claim_expires_at!).toISOString(),
    renewed: outcome.renewed ?? false,
  };
}

/** 租约回收 worker 调用；返回被回收的数量。 */
export function expireTaskLeases(tasks: TaskRepo, now: number): number {
  return tasks.expireLeases(now);
}

export interface TaskDepthDeps {
  tasks: TaskRepo;
  maxDepth: number;
}

export function assertTaskDepth(
  deps: TaskDepthDeps,
  task: Task,
  newParent: Task | null,
): void {
  // 只取路径：深度校验不需要任务正文，走 findSubtree 会把每个后代的
  // description_md（可能内嵌截图）一起读进内存。
  const paths = deps.tasks.findSubtreePaths(task.id);
  const taskDepth = depthOf(task.path);
  const maxDescendantDepth = Math.max(...paths.map((path) => depthOf(path)));
  const newDepth = (newParent ? depthOf(newParent.path) : 0) + 1;
  if (newDepth + (maxDescendantDepth - taskDepth) > deps.maxDepth) {
    throw new AppError('INVALID_ARGUMENT', 'TASK_DEPTH_EXCEEDED', { max_depth: deps.maxDepth });
  }
}

export function depthOf(path: string): number {
  return path.split('/').filter(Boolean).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
