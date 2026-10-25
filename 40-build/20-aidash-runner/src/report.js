import {
  CARD_DETAIL_LIMIT,
  CARD_SUMMARY_LIMIT,
  COMMAND_DISPLAY_LIMIT,
  FAIL_REASON_LIMIT,
} from './constants.js';
import { sanitizeForCard, truncate } from './redact.js';
import { formatDuration, sha256Hex } from './util.js';

/**
 * 状态卡与理由文本。
 *
 * 卡片是用户在网页上验收任务的唯一证据，必须能在不看终端的情况下回答三件事：
 * 跑了什么、结果如何、原始输出在哪。所以 detail_md 固定包含命令、退出信息、
 * 日志路径和首尾输出；不把几十 MB 原始日志塞进数据库。
 */

/**
 * 幂等键由 claim_token 派生，而不是 Date.now()。
 *
 * 同一个 claim 的回报即使被客户端重试，key 也不变，服务端可以按 key 去重；
 * 换了 claim（任务被重新认领）key 自然变化，新一次执行可以正常发新卡。
 */
export function buildIdempotencyKey(taskId, claimToken) {
  const digest = sha256Hex(String(claimToken)).slice(0, 24);
  return truncate(`runner-${taskId}-${digest}`, 128);
}

export function normalizePriority(value) {
  return ['P0', 'P1', 'P2', 'P3'].includes(value) ? value : 'P2';
}

export function buildStatusCard({
  task,
  argv,
  cwd,
  execResult,
  resultFile,
  logFile,
  idempotencyKey,
  result,
}) {
  const command = displayCommand(argv);
  const success = result === 'success';
  const summary = buildSummary({ command, execResult, resultFile, result });
  const detail = buildDetail({ command, cwd, execResult, resultFile, logFile });
  return {
    channel_key: task.channel_key,
    type: 'status',
    task_id: task.id,
    title: truncate(`任务 ${task.id} 执行${labelOfResult(result)}`, 200),
    priority: normalizePriority(task.priority),
    summary: sanitizeForCard(summary, CARD_SUMMARY_LIMIT) || `任务 ${task.id} 执行结束`,
    detail_md: sanitizeForCard(detail, CARD_DETAIL_LIMIT),
    result,
    idempotency_key: idempotencyKey,
  };
}

function labelOfResult(result) {
  switch (result) {
    case 'success':
      return '成功';
    case 'blocked':
      return '阻塞';
    case 'partial':
      return '部分完成';
    default:
      return '失败';
  }
}

function buildSummary({ command, execResult, resultFile, result }) {
  const fromFile = resultFile?.summary?.trim();
  if (fromFile) return fromFile;
  const meta = `退出码 ${execResult.exitCode ?? '无'}，耗时 ${formatDuration(execResult.durationMs)}`;
  if (result === 'success') return `命令执行成功：${command}（${meta}）`;
  if (result === 'blocked') return `命令执行后需要人工处理：${command}（${meta}）`;
  if (result === 'partial') return `命令部分完成：${command}（${meta}）`;
  const failure = failureLabel(execResult);
  // failureLabel 对普通退出已经带了“退出码 N”，这里不要再拼一遍 meta，
  // 否则卡片上会出现“退出码 1，退出码 1”，看起来像两个不同的失败原因。
  const failureMeta = failure.startsWith('退出码 ')
    ? `${failure}，耗时 ${formatDuration(execResult.durationMs)}`
    : `退出码 ${execResult.exitCode ?? '无'}，${failure}，耗时 ${formatDuration(execResult.durationMs)}`;
  return `命令执行失败：${command}（${failureMeta}）${firstLine(execResult)}`;
}

function buildDetail({ command, cwd, execResult, resultFile, logFile }) {
  const lines = [];
  if (resultFile?.detail_md?.trim()) {
    lines.push(resultFile.detail_md.trim(), '', '---', '');
  }
  lines.push(
    '### 命令',
    '~~~text',
    command,
    '~~~',
    '',
    '### 结果',
    `- 退出码：${execResult.exitCode ?? '无'}`,
    `- 信号：${execResult.signal ?? '无'}`,
    `- 耗时：${formatDuration(execResult.durationMs)}`,
    `- 超时：${execResult.timedOut ? '是（已终止进程树）' : '否'}`,
    `- 启动错误：${execResult.spawnError ?? '无'}`,
    `- 工作目录：${cwd ?? '(继承 runner)'}`,
    `- 完整日志：${logFile ?? '(未配置)'}`,
    '',
    '### 输出（首尾各 8KB）',
    '~~~text',
    resultFile?.detail_md?.trim() ? '(harness 已提供 detail_md，原始输出见上/见日志)' : execResult.output ?? '(空)',
    '~~~',
  );
  return lines.join('\n');
}

export function buildFailReason({ argv, execResult, extra }) {
  const base = `命令执行失败：${displayCommand(argv)}；${failureLabel(execResult)}；退出码 ${
    execResult.exitCode ?? '无'
  }；耗时 ${formatDuration(execResult.durationMs)}${extra ? `；${extra}` : ''}`;
  return truncate(sanitizeForCard(base), FAIL_REASON_LIMIT);
}

export function buildBlockReason({ argv, execResult, reason }) {
  const base = `任务需要人工处理：${displayCommand(argv)}；${reason}；退出码 ${
    execResult?.exitCode ?? '无'
  }；耗时 ${execResult ? formatDuration(execResult.durationMs) : '无'}`;
  return truncate(sanitizeForCard(base), FAIL_REASON_LIMIT);
}

export function displayCommand(argv) {
  return truncate(sanitizeForCard(Array.isArray(argv) ? argv.join(' ') : String(argv ?? '')), COMMAND_DISPLAY_LIMIT);
}

function failureLabel(execResult) {
  if (!execResult.started) return `进程未启动${execResult.spawnError ? `：${execResult.spawnError}` : ''}`;
  if (execResult.timedOut) return '执行超时，已终止进程树';
  if (execResult.aborted) return `被中断${execResult.abortedReason ? `：${execResult.abortedReason}` : ''}`;
  if (execResult.exitCode !== null) return `退出码 ${execResult.exitCode}`;
  if (execResult.signal) return `被信号 ${execResult.signal} 终止`;
  return '未知原因';
}

function firstLine(execResult) {
  const text = execResult.stderrTail || execResult.stderr || '';
  const line = String(text)
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ? `；stderr 首行：${truncate(sanitizeForCard(line), 300)}` : '';
}
