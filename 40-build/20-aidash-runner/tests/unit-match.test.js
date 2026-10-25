import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCandidates,
  isAssignable,
  isDeferred,
  matchesChannelPattern,
  matchesChannels,
  matchesRule,
  planTasks,
  priorityRank,
  selectRule,
  skipReasons,
} from '../src/match.js';

function rule(match, name = 'rule') {
  return {
    name,
    match: {
      tags: [],
      title_prefix: '',
      channel_key: '',
      priority: [],
      kind: [],
      match_all: false,
      ...match,
    },
    run: { argv: ['node', '-v'] },
  };
}

function task(overrides = {}) {
  return {
    id: 'task-1',
    channel_key: 'chan-a',
    title: 'Example task',
    status: 'pending',
    priority: 'P2',
    tags: [],
    assignee: null,
    kind: 'task',
    due_at: null,
    defer_reason: '',
    deferred_until: null,
    ...overrides,
  };
}

test('通道匹配支持精确、* 与 prefix/*', () => {
  assert.equal(matchesChannelPattern('chan-a', 'chan-a'), true);
  assert.equal(matchesChannelPattern('chan-a', 'chan-b'), false);
  assert.equal(matchesChannelPattern('chan-a', '*'), true);
  assert.equal(matchesChannelPattern('agent/alpha', 'agent/*'), true);
  assert.equal(matchesChannelPattern('agentx/alpha', 'agent/*'), false);
  assert.equal(matchesChannels('x', []), true);
  assert.equal(matchesChannels('x', ['a', 'x']), true);
});

test('tags 是 AND 且忽略大小写', () => {
  const select = rule({ tags: ['Deploy', 'prod'] });
  assert.equal(matchesRule(task({ tags: ['deploy', 'PROD', 'extra'] }), select), true);
  assert.equal(matchesRule(task({ tags: ['deploy'] }), select), false);
});

test('title_prefix / priority / kind 条件', () => {
  assert.equal(matchesRule(task({ title: 'Build: x' }), rule({ title_prefix: 'build:' })), true);
  assert.equal(matchesRule(task({ title: 'Other' }), rule({ title_prefix: 'build:' })), false);
  assert.equal(matchesRule(task({ priority: 'P1' }), rule({ priority: ['P0', 'P1'] })), true);
  assert.equal(matchesRule(task({ priority: 'P2' }), rule({ priority: ['P0', 'P1'] })), false);
  assert.equal(matchesRule(task({ kind: 'suggestion' }), rule({ kind: ['suggestion'] })), true);
  assert.equal(matchesRule(task({ kind: 'task' }), rule({ kind: ['suggestion'] })), false);
});

test('没有选择条件且未写 match_all 的规则不匹配任何任务', () => {
  assert.equal(matchesRule(task(), rule({})), false);
  assert.equal(matchesRule(task(), rule({ match_all: true })), true);
});

test('通道条件与选择器组合', () => {
  const select = rule({ channel_key: 'agent/*', tags: ['it'] });
  assert.equal(matchesRule(task({ channel_key: 'agent/alpha', tags: ['it'] }), select), true);
  assert.equal(matchesRule(task({ channel_key: 'other', tags: ['it'] }), select), false);
});

test('selectRule 按配置顺序取第一条命中', () => {
  const rules = [
    rule({ tags: ['a'] }, 'first'),
    rule({ tags: ['it'] }, 'second'),
    rule({ match_all: true }, 'fallback'),
  ];
  assert.equal(selectRule(task({ tags: ['it'] }), rules).name, 'second');
  assert.equal(selectRule(task({ tags: ['none'] }), rules).name, 'fallback');
  assert.equal(selectRule(task(), []), null);
});

test('assignee 为空视为公共任务，显式指派给别人的不碰', () => {
  assert.equal(isAssignable(task({ assignee: null }), 'me'), true);
  assert.equal(isAssignable(task({ assignee: '' }), 'me'), true);
  assert.equal(isAssignable(task({ assignee: 'me' }), 'me'), true);
  assert.equal(isAssignable(task({ assignee: 'other' }), 'me'), false);
});

test('暂缓判定：未来/无期限跳过，过期恢复', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(isDeferred(task(), now), false);
  assert.equal(isDeferred(task({ defer_reason: '   ' }), now), false);
  assert.equal(isDeferred(task({ defer_reason: '等评审' }), now), true);
  assert.equal(
    isDeferred(task({ defer_reason: '等评审', deferred_until: '2026-01-02T00:00:00.000Z' }), now),
    true,
  );
  assert.equal(
    isDeferred(task({ defer_reason: '等评审', deferred_until: '2025-12-31T00:00:00.000Z' }), now),
    false,
  );
});

test('skipReasons 汇总 assignee / 通道 / 暂缓原因', () => {
  const config = { harness_id: 'me', channels: ['chan-a'] };
  const reasons = skipReasons(
    task({
      assignee: 'other',
      channel_key: 'chan-b',
      defer_reason: '等评审',
      deferred_until: '2099-01-01T00:00:00.000Z',
    }),
    config,
  );
  assert.equal(reasons.length, 3);
  assert.match(reasons[0], /assignee=other/);
  assert.match(reasons[1], /通道 chan-b/);
  assert.match(reasons[2], /任务已暂缓：等评审/);
  assert.deepEqual(skipReasons(task(), config), []);
});

test('排序：优先级 → due_at（空值靠后）→ id', () => {
  const candidates = [
    { task: task({ id: 'a', priority: 'P2', due_at: '2026-01-01T00:00:00Z' }) },
    { task: task({ id: 'b', priority: 'P1', due_at: null }) },
    { task: task({ id: 'c', priority: 'P1', due_at: '2026-02-01T00:00:00Z' }) },
    { task: task({ id: 'd', priority: 'P1', due_at: '2026-01-01T00:00:00Z' }) },
    { task: task({ id: 'e', priority: 'P0', due_at: null }) },
  ];
  const sorted = [...candidates].sort(compareCandidates).map((item) => item.task.id);
  assert.deepEqual(sorted, ['e', 'd', 'c', 'b', 'a']);
  assert.equal(priorityRank('P0'), 0);
  assert.equal(priorityRank('P9'), 9);
});

test('planTasks 过滤、选规则并保持排序', () => {
  const config = {
    harness_id: 'me',
    channels: ['chan-a'],
    commands: [
      rule({ tags: ['it'], priority: ['P1'] }, 'p1-rule'),
      rule({ tags: ['it'] }, 'any-it'),
    ],
  };
  const tasks = [
    task({ id: 'bad-assignee', tags: ['it'], assignee: 'other' }),
    task({ id: 'bad-channel', tags: ['it'], channel_key: 'chan-b' }),
    task({ id: 'deferred', tags: ['it'], defer_reason: 'later', deferred_until: '2099-01-01T00:00:00Z' }),
    task({ id: 'no-rule', tags: ['other'] }),
    task({ id: 'p1', tags: ['it'], priority: 'P1' }),
    task({ id: 'p2', tags: ['it'], priority: 'P2' }),
  ];
  const { planned, skipped } = planTasks(tasks, config, Date.parse('2026-01-01T00:00:00Z'));
  assert.deepEqual(planned.map((item) => item.task.id), ['p1', 'p2']);
  assert.equal(planned[0].rule.name, 'p1-rule');
  assert.equal(planned[1].rule.name, 'any-it');
  assert.deepEqual(
    skipped.map((item) => item.task.id).sort(),
    ['bad-assignee', 'bad-channel', 'deferred', 'no-rule'],
  );
});
