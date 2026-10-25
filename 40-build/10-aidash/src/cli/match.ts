import type { CommandRule } from './config.js';

/**
 * 任务与命令规则的匹配。
 *
 * 为什么把它单独放一个文件：
 * 匹配是“跑不跑”的安全闸门，独立出来才能单独审阅、单独测试；
 * 混在配置解析里时，最容易被后来的改动顺手放宽条件。
 */

/** 任务侧用于匹配的最小字段集；TaskItem 结构天然兼容。 */
export interface MatchableTask {
  channel_key: string;
  title: string;
  tags: string[];
  assignee: string | null;
}

export function matchesChannelPattern(channelKey: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) return channelKey.startsWith(pattern.slice(0, -1));
  return channelKey === pattern;
}

/** channels 为空 = 全部通道；否则任一模式命中即可。 */
export function matchesChannelFilter(channelKey: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => matchesChannelPattern(channelKey, pattern));
}

/** assignee 为空视为公共任务；显式指派给别的 harness 的任务不碰。 */
export function isTaskAssignableTo(task: MatchableTask, harnessId: string): boolean {
  return !task.assignee || task.assignee === harnessId;
}

/**
 * 规则匹配：
 * - tags 为 AND（任务必须同时具备规则列出的标签），宁可不跑也不要跑错；
 * - title_prefix 大小写不敏感；
 * - 没有声明任何条件时，必须显式 match_all=true 才匹配。
 */
export function matchesCommandRule(task: MatchableTask, rule: CommandRule): boolean {
  if (rule.channel_key && !matchesChannelPattern(task.channel_key, rule.channel_key)) {
    return false;
  }
  if (rule.tags.length > 0) {
    const taskTags = new Set(task.tags.map((tag) => tag.toLowerCase()));
    if (!rule.tags.every((tag) => taskTags.has(tag.toLowerCase()))) return false;
  }
  if (rule.title_prefix && !task.title.toLowerCase().startsWith(rule.title_prefix.toLowerCase())) {
    return false;
  }
  const hasSelector =
    Boolean(rule.channel_key) || rule.tags.length > 0 || Boolean(rule.title_prefix);
  return hasSelector || rule.match_all === true;
}

/** 按配置顺序取第一条命中的规则；顺序即优先级。 */
export function selectCommandRule(task: MatchableTask, rules: CommandRule[]): CommandRule | null {
  for (const rule of rules) {
    if (matchesCommandRule(task, rule)) return rule;
  }
  return null;
}
