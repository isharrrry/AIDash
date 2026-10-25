import { parseIsoMs } from './util.js';

/**
 * 任务与规则匹配、暂缓判定、候选排序。
 *
 * 单独成文件的原因：这是“跑不跑”的安全闸门。混在循环里，后来的人最容易
 * 顺手放宽条件；独立后可以单测、可以审阅，改动必须显式经过测试。
 */

export function matchesChannelPattern(channelKey, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) return channelKey.startsWith(pattern.slice(0, -1));
  return channelKey === pattern;
}

export function matchesChannels(channelKey, patterns) {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => matchesChannelPattern(channelKey, pattern));
}

/** assignee 为空视为公共任务；显式指派给别人的任务不碰。 */
export function isAssignable(task, harnessId) {
  return !task.assignee || task.assignee === harnessId;
}

/**
 * 暂缓判定：defer_reason 非空且 deferred_until 未到（或没写恢复时间）就跳过。
 *
 * 为什么 deferred_until 过期后不再跳过：暂缓是覆盖层，不是终态；到点后任务仍在
 * pending，说明用户预期它重新进入队列。认领会自动清空暂缓，不需要先 undefer。
 */
export function isDeferred(task, nowMs = Date.now()) {
  const reason = typeof task.defer_reason === 'string' ? task.defer_reason.trim() : '';
  if (!reason) return false;
  const until = parseIsoMs(task.deferred_until);
  if (until === null) return true;
  return until > nowMs;
}

export function matchesRule(task, rule) {
  const match = rule.match;
  if (match.channel_key && !matchesChannelPattern(task.channel_key, match.channel_key)) return false;

  if (match.tags.length > 0) {
    // tags 是 AND：规则列出的标签任务必须全部具备。宁可漏跑，也不要跑错。
    const taskTags = new Set((task.tags ?? []).map((tag) => String(tag).toLowerCase()));
    if (!match.tags.every((tag) => taskTags.has(tag.toLowerCase()))) return false;
  }

  if (match.title_prefix) {
    if (!String(task.title ?? '').toLowerCase().startsWith(match.title_prefix.toLowerCase())) {
      return false;
    }
  }

  if (match.priority.length > 0 && !match.priority.includes(task.priority)) return false;
  if (match.kind.length > 0 && !match.kind.includes(task.kind ?? 'task')) return false;

  const hasSelector =
    Boolean(match.channel_key) ||
    match.tags.length > 0 ||
    Boolean(match.title_prefix) ||
    match.priority.length > 0 ||
    match.kind.length > 0;
  return hasSelector || match.match_all === true;
}

export function selectRule(task, commands) {
  for (const rule of commands) {
    if (matchesRule(task, rule)) return rule;
  }
  return null;
}

/** 返回跳过原因；空数组表示该任务可以进入认领候选。 */
export function skipReasons(task, config, nowMs = Date.now()) {
  const reasons = [];
  if (!isAssignable(task, config.harness_id)) {
    reasons.push(`assignee=${task.assignee} 不是 ${config.harness_id}`);
  }
  if (!matchesChannels(task.channel_key, config.channels)) {
    reasons.push(`通道 ${task.channel_key} 不在 channels 内`);
  }
  if (isDeferred(task, nowMs)) {
    const until = task.deferred_until ? `（计划恢复 ${task.deferred_until}）` : '（未定期限）';
    reasons.push(`任务已暂缓：${task.defer_reason}${until}`);
  }
  return reasons;
}

const PRIORITY_RANK = new Map([
  ['P0', 0],
  ['P1', 1],
  ['P2', 2],
  ['P3', 3],
]);

export function priorityRank(priority) {
  return PRIORITY_RANK.get(priority) ?? 9;
}

/**
 * 排序：优先级 → 截止时间 → id。
 *
 * 为什么 due_at 在优先级之后：P0 的承诺通常比 P1 更早，但一个明确标了 P1 且
 * 今天到期的任务，比排在一周后的 P0 更该先做。id 兜底保证排序稳定，便于测试。
 */
export function compareCandidates(left, right) {
  const byPriority = priorityRank(left.task.priority) - priorityRank(right.task.priority);
  if (byPriority !== 0) return byPriority;
  const leftDue = parseIsoMs(left.task.due_at);
  const rightDue = parseIsoMs(right.task.due_at);
  if (leftDue !== rightDue) {
    if (leftDue === null) return 1;
    if (rightDue === null) return -1;
    return leftDue - rightDue;
  }
  return String(left.task.id).localeCompare(String(right.task.id));
}

/**
 * 过滤 + 匹配 + 排序。dry-run 与真实循环共用同一函数，保证“看到什么就执行什么”。
 * @returns {{planned: Array<{task: object, rule: object}>, skipped: Array<{task: object, reasons: string[]}>}}
 */
export function planTasks(tasks, config, nowMs = Date.now()) {
  const planned = [];
  const skipped = [];
  for (const task of tasks) {
    const reasons = skipReasons(task, config, nowMs);
    if (reasons.length > 0) {
      skipped.push({ task, reasons });
      continue;
    }
    const rule = selectRule(task, config.commands);
    if (!rule) {
      skipped.push({ task, reasons: ['没有匹配的 command 规则'] });
      continue;
    }
    planned.push({ task, rule });
  }
  planned.sort(compareCandidates);
  return { planned, skipped };
}
