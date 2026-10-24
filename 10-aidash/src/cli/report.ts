import { BusinessError, errorMessage } from './errors.js';
import type { CommandRule } from './config.js';
import type { ExecResult } from './exec.js';
import { redact, truncate } from './log.js';
import { parseCardId, type TaskItem } from './mcp-parse.js';
import type { RunContext } from './runner.js';

/**
 * 任务回报：状态卡、失败原因、释放。
 *
 * 卡片是用户在网页上验收任务的唯一证据，所以这里遵守 AGENTS.md 的硬规则：
 * - status 卡的 summary 必须非空，detail_md 必须能看出“跑了什么、结果如何”；
 * - 先发卡拿到 card_id，再由 runner 调 task.update complete(evidence_card_ids)；
 * - 输出截断与脱敏在落卡之前完成，避免把令牌或几十 MB 日志塞进数据库。
 */

const SUMMARY_LIMIT = 2_000;
const DETAIL_LIMIT = 64_000;
const REASON_LIMIT = 4_000;
const COMMAND_DISPLAY_LIMIT = 160;

export async function postStatusCard(
  ctx: RunContext,
  task: TaskItem,
  rule: CommandRule,
  result: ExecResult,
  success: boolean,
): Promise<string> {
  if (!task.channel_key) {
    throw new BusinessError('INVALID_ARGUMENT', `任务 ${task.id} 缺少 channel_key，无法发状态卡`);
  }
  const raw = await ctx.client.call<unknown>(
    'card.post',
    {
      channel_key: task.channel_key,
      type: 'status',
      title: truncate(`任务 ${task.id} 执行${success ? '成功' : '失败'}`, 200),
      priority: normalizePriority(task.priority),
      summary: truncate(redact(buildSummary(rule.command, result, success)), SUMMARY_LIMIT),
      detail_md: truncate(redact(buildDetail(rule.command, result)), DETAIL_LIMIT),
      result: success ? 'success' : 'failed',
      task_id: task.id,
      idempotency_key: truncate(`watch-${task.id}-${Date.now().toString(36)}`, 128),
    },
    { timeoutMs: 30_000 },
  );
  return parseCardId(raw);
}

export async function releaseQuietly(
  ctx: RunContext,
  taskId: string,
  token: string,
  reason: string,
): Promise<void> {
  try {
    await ctx.client.call(
      'task.release',
      {
        task_id: taskId,
        claim_token: token,
        reason: truncate(redact(reason), REASON_LIMIT),
      },
      { timeoutMs: 10_000 },
    );
    ctx.logger.info(`已释放任务 ${taskId}：${truncate(redact(reason), 200)}`);
  } catch (error) {
    ctx.logger.warn(`释放任务 ${taskId} 失败（租约到期后会被回收）：${errorMessage(error)}`);
  }
}

export function buildFailReason(command: string, result: ExecResult): string {
  return truncate(
    redact(
      `命令执行失败：${truncate(command, COMMAND_DISPLAY_LIMIT)}；${failureLabel(result)}；退出码 ${
        result.exitCode ?? '无'
      }；耗时 ${(result.durationMs / 1000).toFixed(1)}s`,
    ),
    REASON_LIMIT,
  );
}

function buildSummary(command: string, result: ExecResult, success: boolean): string {
  const cmd = truncate(redact(command), COMMAND_DISPLAY_LIMIT);
  const meta = `退出码 ${result.exitCode ?? '无'}，耗时 ${(result.durationMs / 1000).toFixed(1)}s`;
  if (success) return `命令执行成功：${cmd}（${meta}）`;
  const firstErr = firstLine(result.stderr);
  return `命令执行失败：${cmd}（${failureLabel(result)}，${meta}）${
    firstErr ? `；stderr 首行：${firstErr}` : ''
  }`;
}

function buildDetail(command: string, result: ExecResult): string {
  return [
    '### 命令',
    '~~~text',
    redact(command),
    '~~~',
    '',
    '### 结果',
    `- 退出码：${result.exitCode ?? '无'}`,
    `- 信号：${result.signal ?? '无'}`,
    `- 耗时：${(result.durationMs / 1000).toFixed(2)}s`,
    `- 超时：${result.timedOut ? '是' : '否'}`,
    `- 启动错误：${result.error ?? '无'}`,
    `- stdout：${result.stdoutTruncated ? '已截断到 16KB' : '完整'}`,
    `- stderr：${result.stderrTruncated ? '已截断到 16KB' : '完整'}`,
    '',
    '### stdout',
    '~~~text',
    result.stdout || '(空)',
    '~~~',
    '',
    '### stderr',
    '~~~text',
    result.stderr || '(空)',
    '~~~',
  ].join('\n');
}

function failureLabel(result: ExecResult): string {
  if (result.timedOut) return '执行超时，已终止进程树';
  if (result.error) return `进程启动失败：${result.error}`;
  if (result.exitCode !== null) return `退出码 ${result.exitCode}`;
  if (result.signal) return `被信号 ${result.signal} 终止`;
  return '未知原因';
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((part) => part.trim().length > 0) ?? '';
  return truncate(redact(line.trim()), 300);
}

function normalizePriority(value: string): 'P0' | 'P1' | 'P2' | 'P3' {
  return value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3' ? value : 'P2';
}
