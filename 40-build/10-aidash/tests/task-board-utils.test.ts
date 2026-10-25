import { describe, expect, it } from 'vitest';
import {
  applyEndNoticeOverrides,
  applyUnreadOverrides,
  computeTaskStats,
  filterTree,
  flattenTree,
  groupQuestionsByTask,
  withoutClosed,
} from '../src/web/src/components/task-board-utils.js';
import type { CardView, TaskView, TreeNode } from '../src/web/src/types.js';

/** 构造完整任务节点；只覆盖用例关心的字段，避免每个用例抄 40 行。 */
function task(overrides: Partial<TaskView> = {}): TreeNode {
  return {
    id: 'tk_1',
    channel_id: 'ch_1',
    channel_key: 'host/proj/topic',
    parent_id: null,
    path: '/tk_1/',
    title: '任务',
    description_md: null,
    kind: 'task',
    category: null,
    status: 'pending',
    priority: 'P2',
    assignee: null,
    tags: [],
    due_at: null,
    claimed_by: null,
    claim_expires_at: null,
    claimed_at: null,
    started_at: null,
    blocked_at: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    blocked_reason: null,
    fail_reason: null,
    cancel_reason: null,
    end_notice_read_at: null,
    end_notice_pending: false,
    defer_reason: null,
    deferred_at: null,
    deferred_until: null,
    risk_note: null,
    risk_flagged_at: null,
    risk_resolved_at: null,
    risk_resolution: null,
    evidence_ids: [],
    unread_count: 0,
    created_at: '2026-10-24T10:00:00.000Z',
    updated_at: '2026-10-24T10:00:00.000Z',
    children: [],
    ...overrides,
  };
}

describe('任务看板统计', () => {
  it('未结束口径与服务端一致，暂缓/隐患作为独立维度计数', () => {
    const stats = computeTaskStats([
      task({ id: 'a', status: 'pending', defer_reason: '等排期' }),
      task({ id: 'b', status: 'claimed' }),
      task({ id: 'c', status: 'done', risk_note: '临时方案', risk_resolved_at: null }),
      task({ id: 'd', status: 'cancelled' }),
      task({ id: 'e', status: 'draft' }),
    ]);

    expect(stats).toEqual({
      total: 5,
      open: 2,
      active: 1,
      pending: 1,
      draft: 1,
      blocked: 0,
      done: 1,
      cancelled: 1,
      deferred: 1,
      riskOpen: 1,
    });
  });
});

describe('任务树拍平与筛选', () => {
  it('拍平保持先序，父节点在子节点之前', () => {
    const grandchild = task({ id: 'grand', path: '/tk_root/tk_child/tk_grand/' });
    const child = task({
      id: 'child',
      path: '/tk_root/tk_child/',
      children: [grandchild],
    });
    const root = task({ id: 'root', path: '/tk_root/', children: [child] });

    expect(flattenTree([root]).map((item) => item.id)).toEqual(['root', 'child', 'grand']);
  });

  it('父节点命中时保留整棵子树，子节点命中时保留路径祖先', () => {
    const child = task({ id: 'child', title: '普通子任务' });
    const grandchild = task({ id: 'grand', title: '检查登录失败' });
    const root = task({ id: 'root', title: '修复登录', children: [child] });
    child.children = [grandchild];

    const parentHit = filterTree([root], new Set(), '', '登录');
    expect(parentHit[0]?.id).toBe('root');
    expect(parentHit[0]?.children[0]?.id).toBe('child');
    expect(parentHit[0]?.children[0]?.children[0]?.id).toBe('grand');

    const childHit = filterTree([root], new Set(), '', '检查');
    expect(childHit).toHaveLength(1);
    expect(childHit[0]?.id).toBe('root');
    expect(childHit[0]?.children[0]?.id).toBe('child');
    expect(childHit[0]?.children[0]?.children[0]?.id).toBe('grand');
  });

  it('默认收起已结束节点但提升其未结束子代，带结束通知或显式勾选时保留', () => {
    const active = task({ id: 'active', status: 'in_progress' });
    const noticed = task({ id: 'noticed', status: 'done', end_notice_pending: true });
    const root = task({ id: 'root', status: 'done', children: [active, noticed] });

    const hidden = withoutClosed([root], new Set());
    expect(hidden.map((item) => item.id)).toEqual(['active', 'noticed']);

    const kept = withoutClosed([root], new Set(['done']));
    expect(kept.map((item) => item.id)).toEqual(['root']);
    expect(kept[0]?.children.map((item) => item.id)).toEqual(['active', 'noticed']);
  });
});

describe('任务树本地覆盖', () => {
  it('未读数与结束通知只改目标节点，且不原地修改输入', () => {
    const child = task({ id: 'child', unread_count: 1 });
    const root = task({ id: 'root', unread_count: 3, end_notice_pending: true, children: [child] });
    const original = [root];

    const withUnread = applyUnreadOverrides(original, { child: 0 });
    const withAck = applyEndNoticeOverrides(withUnread, { root: true });

    expect(original[0]?.unread_count).toBe(3);
    expect(original[0]?.end_notice_pending).toBe(true);
    expect(withAck[0]?.end_notice_pending).toBe(false);
    expect(withAck[0]?.unread_count).toBe(3);
    expect(withAck[0]?.children[0]?.unread_count).toBe(0);
  });
});

describe('决策卡归组', () => {
  it('跳过未关联任务的卡，并按 task_id 聚合', () => {
    const card = (id: string, taskId: string | null): CardView =>
      ({ id, task_id: taskId }) as CardView;
    const grouped = groupQuestionsByTask([
      card('cd_1', 'tk_1'),
      card('cd_2', null),
      card('cd_3', 'tk_1'),
    ]);

    expect(Object.keys(grouped)).toEqual(['tk_1']);
    expect(grouped.tk_1?.map((item) => item.id)).toEqual(['cd_1', 'cd_3']);
  });
});
