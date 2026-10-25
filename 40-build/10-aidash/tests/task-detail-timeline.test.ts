import { describe, expect, it } from 'vitest';
import { timelineEntries } from '../src/web/src/components/task-detail-timeline.js';
import type { TaskView } from '../src/web/src/types.js';

/** 时间线只读这些字段；测试用断言收窄，避免构造无关的任务字段。 */
function task(times: {
  created_at?: string | null;
  claimed_at?: string | null;
  started_at?: string | null;
  blocked_at?: string | null;
  deferred_at?: string | null;
  risk_flagged_at?: string | null;
  risk_resolved_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  cancelled_at?: string | null;
  updated_at?: string | null;
}): TaskView {
  return {
    created_at: '2026-10-24T10:00:00.000Z',
    claimed_at: null,
    started_at: null,
    blocked_at: null,
    deferred_at: null,
    risk_flagged_at: null,
    risk_resolved_at: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    updated_at: '2026-10-24T10:00:00.000Z',
    ...times,
  } as unknown as TaskView;
}

describe('任务状态时间线', () => {
  it('只列出真正发生过的节点，空时间不补造', () => {
    const entries = timelineEntries(
      task({
        created_at: '2026-10-24T10:00:00.000Z',
        claimed_at: '2026-10-24T10:05:00.000Z',
        updated_at: '2026-10-24T10:30:00.000Z',
      }),
    );

    expect(entries.map((entry) => entry.label)).toEqual(['创建', '认领', '更新']);
  });

  it('按时间升序排列，完成后的隐患补记不会倒流到完成上方', () => {
    const entries = timelineEntries(
      task({
        created_at: '2026-10-24T10:00:00.000Z',
        completed_at: '2026-10-24T12:00:00.000Z',
        risk_flagged_at: '2026-10-24T13:00:00.000Z',
        updated_at: '2026-10-24T13:00:00.000Z',
      }),
    );

    expect(entries.map((entry) => entry.label)).toEqual(['创建', '完成', '隐患标记', '更新']);
  });
});
