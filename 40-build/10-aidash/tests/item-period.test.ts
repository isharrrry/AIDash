import { describe, expect, it } from 'vitest';
import {
  OPEN_STAGE_FILTER,
  STAGE_LABELS,
  STAGE_OPTIONS,
  buildPeriodTaskForest,
  buildPeriodWindows,
  derivedPriority,
  derivedStage,
  eventsInRange,
  matchesStageFilter,
  periodRangeAt,
  summarizePeriod,
  taskEvents,
  taskStats,
  tasksInPeriod,
} from '../src/web/src/lib/item-period.js';
import type { ChannelView, TaskView } from '../src/web/src/types.js';

/** 固定基准：2026-11-03（周二）10:00，本地时区。 */
const NOW = new Date(2026, 10, 3, 10, 0, 0).getTime();

function at(month: number, day: number, hour = 10): string {
  return new Date(2026, month - 1, day, hour).toISOString();
}

function task(overrides: Partial<TaskView> = {}): TaskView {
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
    discussion_answer_md: null,
    discussion_answered_at: null,
    evidence_ids: [],
    unread_count: 0,
    created_at: at(11, 3, 1),
    updated_at: at(11, 3, 1),
    ...overrides,
  };
}

function channel(overrides: Partial<ChannelView> = {}): ChannelView {
  return {
    id: 'ch_1',
    channel_key: 'host/proj/topic',
    title: null,
    alias: null,
    name: null,
    project: 'proj',
    topic: 'topic',
    workdir: null,
    status: 'active',
    card_count: 0,
    task_count: 0,
    open_task_count: 0,
    last_mcp_at: null,
    agent_online: false,
    agent_busy: false,
    last_active_at: null,
    meta: {
      owner: null,
      priority: null,
      stage: null,
      group: null,
      participants: [],
      tags: [],
      iteration: null,
      product: null,
      category: null,
      remark: null,
      ai_suggestion: null,
      ai_suggestion_at: null,
    },
    created_at: at(10, 1),
    updated_at: at(10, 1),
    ...overrides,
  };
}

describe('事项周期窗口', () => {
  it('日/周/月/季/半年/年按本地自然边界切分，offset 往前推', () => {
    const day = periodRangeAt('day', 0, NOW);
    expect(day.key).toBe('2026-11-03');
    expect(day.shortLabel).toBe('11/3 周二');
    expect(day.start).toBe(new Date(2026, 10, 3).getTime());
    expect(day.end).toBe(new Date(2026, 10, 4).getTime());
    expect(periodRangeAt('day', 1, NOW).key).toBe('2026-11-02');

    const week = periodRangeAt('week', 0, NOW);
    expect(week.key).toBe('2026-W45');
    expect(week.start).toBe(new Date(2026, 10, 2).getTime());
    expect(week.end).toBe(new Date(2026, 10, 9).getTime());
    expect(week.shortLabel).toBe('11/2–11/8');
    expect(periodRangeAt('week', 1, NOW).key).toBe('2026-W44');

    expect(periodRangeAt('month', 0, NOW).key).toBe('2026-11');
    expect(periodRangeAt('month', 3, NOW).key).toBe('2026-08');
    expect(periodRangeAt('quarter', 0, NOW).key).toBe('2026-Q4');
    expect(periodRangeAt('quarter', 1, NOW).key).toBe('2026-Q3');
    expect(periodRangeAt('half', 0, NOW).key).toBe('2026-H2');
    expect(periodRangeAt('half', 1, NOW).key).toBe('2026-H1');
    expect(periodRangeAt('year', 1, NOW).key).toBe('2025');
  });

  it('跨年周期：1 月往前一周/月/季/半年/年落在上一年且键正确', () => {
    // 2026-01-01 所在周从 2025-12-29 开始（ISO 2026-W01）；再往前一周是 2025-W52。
    const jan1 = new Date(2026, 0, 1, 10).getTime();
    expect(periodRangeAt('week', 1, jan1).key).toBe('2025-W52');
    expect(periodRangeAt('month', 1, jan1).key).toBe('2025-12');
    expect(periodRangeAt('quarter', 1, jan1).key).toBe('2025-Q4');
    expect(periodRangeAt('half', 1, jan1).key).toBe('2025-H2');
    expect(periodRangeAt('year', 1, jan1).key).toBe('2025');
  });

  it('buildPeriodWindows 从最新一期起按 offset 递增排列', () => {
    const windows = buildPeriodWindows('week', 3, NOW);
    expect(windows.map((range) => range.key)).toEqual([
      '2026-W45',
      '2026-W44',
      '2026-W43',
    ]);
  });
});

describe('事项任务事件与周期汇总', () => {
  it('生命周期事件按时间排序；updated_at 与已有事件同刻时不重复记“更新”', () => {
    const completed = task({
      status: 'done',
      created_at: at(11, 1, 8),
      claimed_at: at(11, 2, 9),
      started_at: at(11, 2, 9),
      completed_at: at(11, 3, 9),
      updated_at: at(11, 3, 9),
    });
    const events = taskEvents(completed);
    expect(events.map((event) => event.kind)).toEqual([
      'created',
      'claimed',
      'started',
      'completed',
    ]);

    const edited = task({ updated_at: at(11, 3, 11) });
    expect(taskEvents(edited).map((event) => event.kind)).toContain('updated');
  });

  it('eventsInRange / tasksInPeriod 只收窗口内事件，并按最后事件时间倒序', () => {
    const week = periodRangeAt('week', 0, NOW);
    const completedToday = task({
      id: 'today',
      status: 'done',
      completed_at: at(11, 3, 9),
      updated_at: at(11, 3, 9),
      created_at: at(10, 1),
    });
    const createdYesterday = task({
      id: 'yesterday',
      created_at: at(11, 2, 9),
      updated_at: at(11, 2, 9),
    });
    const outside = task({
      id: 'outside',
      created_at: at(10, 1),
      updated_at: at(10, 1),
    });

    expect(eventsInRange(completedToday, week).map((event) => event.kind)).toEqual([
      'completed',
    ]);
    expect(eventsInRange(outside, week)).toEqual([]);

    const entries = tasksInPeriod([createdYesterday, completedToday, outside], week);
    expect(entries.map((entry) => entry.task.id)).toEqual(['today', 'yesterday']);
  });

  it('汇报摘要按完成/阻塞等权重挑要点，并统计各事件次数', () => {
    const week = periodRangeAt('week', 0, NOW);
    const done = task({
      id: 'done',
      title: '接口联调',
      status: 'done',
      created_at: at(10, 1),
      completed_at: at(11, 3, 9),
      updated_at: at(11, 3, 9),
    });
    const blocked = task({
      id: 'blocked',
      title: '部署脚本',
      status: 'blocked',
      created_at: at(10, 1),
      blocked_at: at(11, 2, 9),
      updated_at: at(11, 2, 9),
    });
    const fresh = task({
      id: 'fresh',
      title: '需求评审',
      created_at: at(11, 2, 8),
      updated_at: at(11, 2, 8),
    });

    const summary = summarizePeriod(tasksInPeriod([done, blocked, fresh], week));
    expect(summary.taskCount).toBe(3);
    expect(summary.counts).toEqual([
      { kind: 'completed', label: '完成', count: 1 },
      { kind: 'created', label: '新增', count: 1 },
      { kind: 'blocked', label: '阻塞', count: 1 },
    ]);
    // 完成权重最高，其次是阻塞；新增只计数，不抢正文。
    expect(summary.highlights.map((item) => item.text)).toEqual([
      '完成「接口联调」',
      '阻塞「部署脚本」',
    ]);
  });
});

describe('事项任务树与派生属性', () => {
  it('周期内父子重建层级；父任务不在本期时子任务当根', () => {
    const parent = task({ id: 'p', title: '父', path: '/p/', created_at: at(11, 2, 8) });
    const child = task({
      id: 'c',
      title: '子',
      parent_id: 'p',
      path: '/p/c/',
      created_at: at(11, 3, 8),
    });
    const orphan = task({
      id: 'o',
      title: '孤儿子',
      parent_id: 'missing',
      path: '/missing/o/',
      created_at: at(11, 2, 9),
    });

    const forest = buildPeriodTaskForest([child, parent]);
    expect(forest).toHaveLength(1);
    expect(forest[0]?.task.id).toBe('p');
    expect(forest[0]?.children[0]?.task.id).toBe('c');
    expect(forest[0]?.children[0]?.depth).toBe(1);

    const withOrphan = buildPeriodTaskForest([child, parent, orphan]);
    expect(withOrphan.map((node) => node.task.id).sort()).toEqual(['o', 'p']);
  });

  it('进度分母排除已取消；优先级取未结束任务的最高值', () => {
    const stats = taskStats([
      task({ id: 'a', status: 'done' }),
      task({ id: 'b', status: 'cancelled' }),
      task({ id: 'c', status: 'in_progress' }),
      task({ id: 'd', status: 'pending' }),
    ]);
    expect(stats.progress).toBe(33);
    expect(stats.open).toBe(2);

    const priority = derivedPriority([
      task({ id: 'done', status: 'done', priority: 'P0' }),
      task({ id: 'open', status: 'pending', priority: 'P2' }),
    ]);
    expect(priority).toBe('P2');
  });

  it('未人工标注阶段时按任务状态推导', () => {
    const base = channel();
    expect(derivedStage(base, [])).toBe('planned');
    expect(derivedStage(base, [task({ status: 'done' })])).toBe('done');
    expect(derivedStage(base, [task({ status: 'blocked' })])).toBe('waiting');
    expect(derivedStage(base, [task({ status: 'in_progress' })])).toBe('in_progress');
    expect(derivedStage(base, [task({ status: 'pending' })])).toBe('planned');
    expect(derivedStage({ ...base, status: 'archived' }, [])).toBe('done');
  });

  it('阶段包含“关闭”，默认筛选只放行非关闭事项', () => {
    expect(STAGE_OPTIONS.map((option) => option.value)).toContain('closed');
    expect(STAGE_LABELS.closed).toBe('关闭');

    // 默认伪值：null / 规划中 / 已完成都算未关闭，只有 closed 被挡。
    expect(matchesStageFilter('closed', OPEN_STAGE_FILTER)).toBe(false);
    expect(matchesStageFilter('done', OPEN_STAGE_FILTER)).toBe(true);
    expect(matchesStageFilter(null, OPEN_STAGE_FILTER)).toBe(true);
    // 空值表示“全部”，显式阶段则精确匹配。
    expect(matchesStageFilter('closed', '')).toBe(true);
    expect(matchesStageFilter('closed', 'closed')).toBe(true);
    expect(matchesStageFilter('done', 'closed')).toBe(false);
  });
});
