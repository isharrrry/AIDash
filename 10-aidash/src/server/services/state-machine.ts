import { AppError } from '../../shared/errors.js';
import type { Task, TaskStatus } from '../../shared/types.js';

/**
 * 任务状态机（03 §3.4，T-001~T-019）。
 *
 * 为什么用表驱动而不是一堆 if：
 * - 合法转移只有一张表，测试可以逐条枚举；
 * - 新增状态时先改表，编译期就能发现漏写；
 * - 错误响应里的 allowed_from 直接来自表，便于调用方自我纠正。
 *
 * 注意：这不替代表上的 CHECK。CHECK 保证“存进去的值合法”，
 * 这里保证“值的变化合法”，两者缺一不可。
 */
export type TaskStatusEvent =
  | 'submit'
  | 'start'
  | 'block'
  | 'unblock'
  | 'complete'
  | 'fail'
  | 'cancel'
  | 'release';

/**
 * 不改变状态的事件。
 *
 * defer/undefer 只写“暂缓原因/计划恢复时间”，状态仍是 draft/pending；
 * flag_risk/unflag_risk 只写“隐患说明/解除时间”，可作用于任何状态（包括 done）——
 * 复盘时标记“这次是带隐患完成的”本身就是事后动作。
 * 用独立类型而不是塞进 TASK_TRANSITIONS，避免“转移目标 = 原状态”这种
 * 会让状态机图变成自环的假转移。
 */
export type TaskDeferEvent = 'defer' | 'undefer';
export type TaskRiskEvent = 'flag_risk' | 'unflag_risk';
export type TaskEvent = TaskStatusEvent | TaskDeferEvent | TaskRiskEvent;

interface TransitionRule {
  from: TaskStatus[];
  to: TaskStatus;
  /** 该事件是否必须带 claim_token。 */
  needsToken: boolean;
}

export const TASK_TRANSITIONS: Record<TaskStatusEvent, TransitionRule> = {
  submit: { from: ['draft'], to: 'pending', needsToken: false },
  start: { from: ['claimed'], to: 'in_progress', needsToken: true },
  block: { from: ['in_progress'], to: 'blocked', needsToken: true },
  unblock: { from: ['blocked'], to: 'in_progress', needsToken: true },
  complete: { from: ['in_progress'], to: 'done', needsToken: true },
  fail: { from: ['in_progress'], to: 'failed', needsToken: true },
  // 从 draft/pending 取消不需要令牌；一旦被认领，只有持有者能取消。
  cancel: {
    from: ['draft', 'pending', 'claimed', 'in_progress', 'blocked'],
    to: 'cancelled',
    needsToken: true,
  },
  release: { from: ['claimed', 'in_progress', 'blocked'], to: 'pending', needsToken: true },
};

/** 类型守卫：把联合事件缩窄到状态转移事件，TASK_TRANSITIONS 才可索引。 */
export function isDeferEvent(event: TaskEvent): event is TaskDeferEvent {
  return event === 'defer' || event === 'undefer';
}

/** 隐患标记也是覆盖层：不改 status，也不需要 claim_token。 */
export function isRiskEvent(event: TaskEvent): event is TaskRiskEvent {
  return event === 'flag_risk' || event === 'unflag_risk';
}

export function assertTaskTransition(task: Task, event: TaskStatusEvent): TaskStatus {
  const rule = TASK_TRANSITIONS[event];
  if (!rule.from.includes(task.status)) {
    throw new AppError('CONFLICT', 'TASK_STATE_INVALID', {
      guard: 'G-T01',
      event,
      from: task.status,
      allowed_from: rule.from,
    });
  }
  return rule.to;
}

export function assertClaimToken(task: Task, token: string | undefined): void {
  if (!task.claim_token) {
    throw new AppError('CONFLICT', 'CLAIM_TOKEN_REQUIRED', { guard: 'G-T02', status: task.status });
  }
  // 缺参数和参数不对是两类问题：前者调用方补上就能重试，后者说明拿错了令牌。
  // 分开报错能省掉一次“为什么 403 但我什么都没传”的排查。
  // 直接用等值比较：令牌本身是 32 字节随机串，不存在可被利用的时序差异。
  if (!token) {
    throw new AppError('INVALID_ARGUMENT', 'CLAIM_TOKEN_MISSING', { guard: 'G-T02' });
  }
  if (token !== task.claim_token) {
    throw new AppError('FORBIDDEN', 'CLAIM_TOKEN_MISMATCH', { guard: 'G-T02' });
  }
}

/** draft/pending 的取消不需要令牌；其余被认领状态必须带。 */
export function cancelNeedsToken(status: TaskStatus): boolean {
  return ['claimed', 'in_progress', 'blocked'].includes(status);
}
