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
  resultFileInfo = null,
  logFile,
  idempotencyKey,
  result,
}) {
  // 讨论任务的“证据”是结论本身，不是命令日志。
  // 单独分支而不是在 buildDetail 里删内容：非讨论任务的卡片必须保持原样。
  if (task.kind === 'discussion') {
    return buildDiscussionCard({ task, resultFile, resultFileInfo, idempotencyKey, result });
  }

  const command = displayCommand(argv);
  const success = result === 'success';
  const summary = buildSummary({ command, execResult, resultFile, result });
  const detail = buildDetail({ command, cwd, execResult, resultFile, resultFileInfo, logFile });
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

/**
 * 结论卡：只放 harness 写回的 summary/detail_md。
 *
 * 讨论任务由模型直接给答案，命令只是执行载体；把 argv、退出码、输出尾巴拼进
 * 正文会让详情页的主内容变成日志，用户还得自己从里面找结论。
 * detail 为空时回退 summary，至少保证卡片不是空白；summary 也缺失时
 * 才用状态标签兜底（card.post 要求 summary 非空）。
 */
function buildDiscussionCard({ task, resultFile, resultFileInfo = null, idempotencyKey, result }) {
  const title = task.title ?? task.id;
  const summary = resultFile?.summary?.trim() ?? '';
  const baseDetail = resultFile?.detail_md?.trim() || summary;
  // 讨论任务的结论只能来自结果文件；文件缺失/被忽略时必须明说，
  // 否则卡片看起来像“正常完成”，用户却拿不到任何回答。
  const note = resultFileInfo?.issue
    ? `> 注意：${resultFileIssueLabel(resultFileInfo)}${resultFileInfo.path ? `（${resultFileInfo.path}）` : ''}；本卡没有讨论结论正文。`
    : '';
  const detail = [note, baseDetail].filter(Boolean).join('\n\n');
  return {
    channel_key: task.channel_key,
    type: 'status',
    task_id: task.id,
    title: truncate(`讨论「${title}」的结论`, 200),
    priority: normalizePriority(task.priority),
    summary: sanitizeForCard(summary, CARD_SUMMARY_LIMIT) || `讨论任务${labelOfResult(result)}`,
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

function buildDetail({ command, cwd, execResult, resultFile, resultFileInfo = null, logFile }) {
  const lines = [];
  if (resultFile?.detail_md?.trim()) {
    lines.push(resultFile.detail_md.trim(), '', '---', '');
  }
  const resultFileLine = resultFileInfo
    ? `- 结果文件：${resultFileInfo.path ?? '(未配置)'}${
        resultFileInfo.issue
          ? `（${resultFileIssueLabel(resultFileInfo)}）`
          : '（本次执行写入）'
      }`
    : null;
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
    ...(resultFileLine ? [resultFileLine] : []),
    `- 完整日志：${logFile ?? '(未配置)'}`,
    '',
    '### 输出（首尾各 8KB）',
    '~~~text',
    resultFile?.detail_md?.trim() ? '(harness 已提供 detail_md，原始输出见上/见日志)' : execResult.output ?? '(空)',
    '~~~',
  );
  return lines.join('\n');
}

/**
 * 结果文件问题的中文说明。
 *
 * 日志和证据卡共用同一套措辞，用户在终端看到的原因与卡片里的一致，
 * 不用在两个地方来回对照。
 */
export function resultFileIssueLabel(info) {
  switch (info?.issue) {
    case 'missing':
      return '未找到本次执行写出的结果文件，harness 可能写到了别处';
    case 'stale':
      return '文件早于本次执行开始，已忽略';
    case 'unchanged':
      return '文件在本次执行期间没有更新，已忽略';
    case 'foreign':
      return `文件属于任务 ${info.foreignTaskId ?? '(未知)'}，已忽略`;
    case 'invalid':
      return '文件不是合法的结果 JSON，已忽略';
    case 'unconfigured':
      return '未配置结果文件';
    default:
      return '未知原因，已忽略';
  }
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
