import type { TaskView } from '../types';

export interface TimelineEntry {
  label: string;
  value: string;
}

/**
 * 状态时间线只列“真正发生过”的节点。
 *
 * created_at / updated_at 一定有值；其余字段由 task-service 在状态事件里写入，
 * 为空表示该事件没发生过。不能拿 updated_at 去补，否则会伪造一个不存在的时间点。
 */
export function timelineEntries(task: TaskView): TimelineEntry[] {
  const candidates: Array<{ label: string; value: string | null }> = [
    { label: '创建', value: task.created_at },
    { label: '认领', value: task.claimed_at },
    { label: '开始', value: task.started_at },
    { label: '阻塞', value: task.blocked_at },
    { label: '暂缓', value: task.deferred_at },
    { label: '隐患标记', value: task.risk_flagged_at },
    { label: '隐患解除', value: task.risk_resolved_at },
    { label: '完成', value: task.completed_at },
    { label: '失败', value: task.failed_at },
    { label: '取消', value: task.cancelled_at },
    { label: '更新', value: task.updated_at },
  ];

  const entries: TimelineEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.value) entries.push({ label: candidate.label, value: candidate.value });
  }
  // 不能按固定生命周期顺序展示：隐患允许在任务完成/取消之后补记，
  // 固定顺序会把“完成后的隐患标记”排到“完成”上方，读起来像时间倒流。
  // ISO 时间可直接字典序比较；同刻保持上面的稳定顺序。
  return entries.sort((a, b) => a.value.localeCompare(b.value));
}
