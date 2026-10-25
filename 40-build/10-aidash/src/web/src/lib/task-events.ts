/**
 * 任务状态事件的“前端规则镜像”。
 *
 * 服务端才是唯一权威（state-machine.ts）；这里只用于：
 * 1. 决定当前状态下该显示哪些按钮；
 * 2. 提前禁用必然缺令牌的事件，减少一次无意义的 400。
 * 规则若与服务端漂移，最终仍会被服务端的 CONFLICT/INVALID_ARGUMENT 拦住。
 */
import type { TaskStatus } from '../types';

export type TaskEvent =
  | 'submit'
  | 'start'
  | 'block'
  | 'unblock'
  | 'complete'
  | 'fail'
  | 'cancel'
  | 'retry'
  | 'defer'
  | 'undefer'
  | 'flag_risk'
  | 'unflag_risk';

export const EVENT_LABELS: Record<TaskEvent, string> = {
  submit: '提交待认领',
  start: '开始',
  block: '阻塞',
  unblock: '解除阻塞',
  complete: '完成',
  fail: '失败',
  cancel: '取消',
  retry: '重新排队',
  defer: '暂缓 / 排期',
  undefer: '取消暂缓',
  flag_risk: '标记隐患',
  unflag_risk: '解除隐患',
};

/**
 * 按状态机给出当前状态下合法的事件（见 AGENTS.md §5.1）。
 *
 * defer 只出现在 draft/pending：已认领的任务要暂停应走 block，
 * 否则页面会同时显示“进行中”和“已暂缓”。undefer 不在此表，
 * 由详情页根据 defer_reason 是否存在单独渲染。
 */
export const ALLOWED_EVENTS: Record<TaskStatus, TaskEvent[]> = {
  draft: ['submit', 'defer', 'cancel'],
  pending: ['defer', 'cancel'],
  claimed: ['start', 'cancel'],
  in_progress: ['complete', 'block', 'fail', 'cancel'],
  blocked: ['unblock', 'cancel'],
  done: [],
  // failed 不是死状态：允许“重新排队”回到 pending（服务端只接受这一条出口）。
  // done/cancelled 仍没有状态事件；两者只能靠覆盖层补记隐患等事后信息。
  failed: ['retry'],
  cancelled: [],
};

const TOKEN_EVENTS: TaskEvent[] = ['start', 'block', 'unblock', 'complete', 'fail'];
/**
 * flag_risk 必须写清“留了什么隐患”，否则复盘时无从判断。unflag_risk 的说明可选。
 * retry 也必须写理由：重新排队会让任务再次被认领，下一位执行者需要知道上一轮为什么失败。
 */
export const REASON_EVENTS: TaskEvent[] = ['block', 'fail', 'retry', 'defer', 'flag_risk'];
/** cancel 只在已认领状态下需要令牌（同 state-machine.cancelNeedsToken）。 */
const CLAIMED_STATUSES: TaskStatus[] = ['claimed', 'in_progress', 'blocked'];

export function eventNeedsToken(event: TaskEvent, status: TaskStatus): boolean {
  return (
    TOKEN_EVENTS.includes(event) ||
    (event === 'cancel' && CLAIMED_STATUSES.includes(status))
  );
}
