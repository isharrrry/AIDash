import { errorMessage, isAuthError } from './errors.js';
import { buildChildEnv, executeCommand } from './exec.js';
import { ConsoleMarkdown, supportsColor } from './console-md.js';
import { RETRY_MAX_ATTEMPTS, callWithRetry } from './retry.js';
import { StreamTextDecoder } from './stream-decoder.js';
import {
  buildCompleteFailureReason,
  buildEvidenceFailureReason,
  buildFastFailureSignature,
  buildReportFailureReason,
  canReport,
  classifyCommandOutcome,
  evidenceFailureAction,
  isLeaseLostError,
} from './failure-policy.js';
import { EdgeBuffer } from './ring-buffer.js';
import { redact } from './redact.js';
import {
  buildFailReason,
  buildIdempotencyKey,
  buildStatusCard,
  resultFileIssueLabel,
} from './report.js';
import {
  readResultFileForTask,
  snapshotResultFile,
  substitutePlaceholders,
  taskStdin,
  writeTaskFiles,
} from './task-file.js';
import { parseCardId, parseTask, parseTaskPage } from './task-parse.js';
import { MAX_TASK_LIST_PAGES, TASK_LIST_PAGE_SIZE } from './constants.js';
import {
  isClaudeResumeFailure,
  prepareClaudeFallback,
  prepareClaudeInvocation,
} from './claude-session.js';

const TASK_TITLE_LOG_LIMIT = 40;
const TASK_ID_LOG_TAIL = 8;

/** 日志里的任务标签：标题 + id 尾号，避免前台只看到一串看不懂的 id。 */
function taskLogLabel(task) {
  const id = String(task?.id ?? '');
  const title = typeof task?.title === 'string' ? task.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) return `任务 ${id}`;
  const short = title.length > TASK_TITLE_LOG_LIMIT ? `${title.slice(0, TASK_TITLE_LOG_LIMIT)}…` : title;
  const tail = id.length > TASK_ID_LOG_TAIL ? `…${id.slice(-TASK_ID_LOG_TAIL)}` : id;
  return `任务「${short}」（${tail}）`;
}

/**
 * 单个已认领任务的执行与回报。
 *
 * 顺序不能反：
 *   claim → （取详情）→ 写 task_file → start → spawn → 续租 → 证据卡 → complete/fail。
 * 先发卡再 complete 是服务端硬规则（否则 EVIDENCE_REQUIRED）；先 start 再 spawn
 * 是为了让网页上的状态时间线真实反映“已经开始执行”。
 *
 * 终止语义见 failure-policy.js：命令没启动才 release；命令跑过就绝不 release。
 */
export async function runClaimedTask(ctx, task, rule, claim) {
  const inner = new AbortController();
  let abortReason = '';
  let leaseLost = false;
  let authError = null;
  let taskFiles = null;
  let stopRenewal = () => {};
  let forwarder = null;

  const onOuterAbort = () => {
    abortReason = abortReason || 'stop';
    inner.abort(new Error('收到停止信号'));
  };
  if (ctx.signal.aborted) onOuterAbort();
  else ctx.signal.addEventListener('abort', onOuterAbort, { once: true });

  const loseLease = (reason) => {
    leaseLost = true;
    abortReason = 'lease_lost';
    inner.abort(new Error(reason));
  };
  const failAuth = (error) => {
    authError = error;
    abortReason = 'auth';
    inner.abort(error);
  };

  try {
    const details = await fetchTaskDetails(ctx, task, claim);

    if (ctx.signal.aborted) {
      await releaseQuietly(ctx, task.id, claim.token, '命令启动前收到停止信号');
      return { outcome: 'released' };
    }

    try {
      taskFiles = writeTaskFiles(details, {
        baseDir: ctx.tempDir ?? undefined,
        resultFileTemplate: rule.run.result_file,
      });
    } catch (error) {
      const reason = `任务文件写入失败：${errorMessage(error)}`;
      ctx.logger.warn(`${taskLogLabel(task)} ${reason}`);
      await releaseQuietly(ctx, task.id, claim.token, reason);
      return { outcome: 'released', error };
    }
    // 执行前先记下结果文件的样子：执行后如果 mtime+size 都没变，说明 harness
    // 根本没写（或写到了别处），绝不能把上一次任务留下的内容当成这次的结果。
    const resultBaseline = snapshotResultFile(taskFiles.resultPath);

    try {
      await ctx.client.call(
        'task.update',
        { task_id: task.id, event: 'start', claim_token: claim.token },
        { timeoutMs: 20_000 },
      );
    } catch (error) {
      if (isAuthError(error)) throw error;
      // start 成功之前命令不可能跑过，释放是安全的；随后抛出传输错误让循环退避。
      await releaseQuietly(ctx, task.id, claim.token, `任务 start 失败：${errorMessage(error)}`);
      return { outcome: 'released', error };
    }

    ctx.state.setBusy(true, { task_id: task.id, title: task.title, started_at: new Date().toISOString() });
    // 状态切换立即上报：服务端据此把注册表从“空闲在线”切到“运行中”，
    // 不用等下一个 60 秒心跳。
    ctx.heartbeatNow?.();
    stopRenewal = startLeaseRenewal(ctx, task.id, claim.token, loseLease, failAuth);

    const config = ctx.getConfig();
    const env = buildTaskEnv(config, task, rule, { resultPath: taskFiles.resultPath });
    const rawArgv = substitutePlaceholders(rule.run.argv, taskFiles);
    const rawShell = rule.run.shell === true;
    const stdinPayload =
      rule.run.input === 'stdin'
        ? taskStdin(details, rule.run.stdin, { resultPath: taskFiles.resultPath })
        : null;
    let invocation = prepareClaudeInvocation({
      engine: ctx.resumeEngine,
      argv: rawArgv,
      shell: rawShell,
      channelKey: task.channel_key,
      dataDir: ctx.dataDir,
      logger: ctx.logger,
    });

    ctx.logger.info(
      `${taskLogLabel(task)} 开始执行：${rawArgv[0] ?? ''}${rawArgv.length > 1 ? ' …' : ''}` +
        `${invocation.mode === 'resume' ? '（续接 Claude 会话）' : ''}`,
    );
    const runStartedAt = Date.now();
    let attempt = await executeHarnessAttempt({
      ctx,
      task,
      rule,
      env,
      argv: invocation.argv,
      shell: invocation.shell,
      stdinPayload,
      signal: inner.signal,
    });
    let earlierAttemptStarted = false;

    // 只对“确实用了 --resume 且输出包含会话不存在”的失败重跑一次。
    // 超时、中止、租约丢失、普通业务失败都不重跑，避免重复执行。
    if (
      invocation.mode === 'resume' &&
      !authError &&
      !leaseLost &&
      !inner.signal.aborted &&
      isClaudeResumeFailure(
        attempt.execResult,
        `${attempt.forwarder.stdoutHead}\n${attempt.forwarder.stderrHead}`,
      )
    ) {
      earlierAttemptStarted = attempt.execResult.started === true;
      ctx.logger.warn(
        `${taskLogLabel(task)} Claude 会话续接失败（会话不存在）：已清除旧会话，回退一次不带 --resume 的执行`,
      );
      invocation = prepareClaudeFallback({
        argv: rawArgv,
        shell: rawShell,
        channelKey: task.channel_key,
        dataDir: ctx.dataDir,
        logger: ctx.logger,
      });
      attempt = await executeHarnessAttempt({
        ctx,
        task,
        rule,
        env,
        argv: invocation.argv,
        shell: invocation.shell,
        stdinPayload,
        signal: inner.signal,
      });
    }

    stopRenewal();
    stopRenewal = () => {};
    forwarder = attempt.forwarder;
    const execResult = attempt.execResult;

    if (authError) throw authError;
    if (leaseLost) {
      ctx.logger.warn(
        `${taskLogLabel(task)} 租约丢失：已终止命令且不 release（避免覆盖新认领方）；任务将由服务端按租约回收`,
      );
      return { outcome: 'lease_lost' };
    }

    const execView = {
      ...execResult,
      output: forwarder.ring.toString(),
      stderrTail: forwarder.stderrHead,
    };

    if (!execResult.started && !earlierAttemptStarted) {
      // 命令从头到尾没跑起来（cwd 不存在、可执行文件缺失、启动前被停止）：release 安全。
      const reason = abortReason === 'stop'
        ? '命令启动前收到停止信号'
        : `命令未启动：${execResult.spawnError ?? '未知原因'}`;
      await releaseQuietly(ctx, task.id, claim.token, reason);
      // ENOENT/EACCES 是“这条命令根本起不来”，不是任务本身失败。
      // 如果继续 release 后立刻重认领，会变成每 2 秒一次的错误风暴；标记为 fatal，
      // 由主循环停止实例，等人修正 PATH / run.argv[0]。
      const fatal = !abortReason && /ENOENT|EACCES/i.test(execResult.spawnError ?? '');
      return {
        outcome: 'released',
        fatal,
        error: fatal
          ? new Error(`无法启动命令：${execResult.spawnError ?? '未知原因'}；请检查 PATH 或 run.argv[0]`)
          : undefined,
      };
    }

    if (!execResult.started && earlierAttemptStarted) {
      // Claude resume 失败后已经跑过一次命令，只是回退进程没起来：
      // 绝不能 release，否则会把“执行过”的任务重新放回队列造成重复执行。
      ctx.logger.warn(
        `${taskLogLabel(task)} 回退执行未启动，但前面的 resume 尝试已执行过：不 release，避免重复执行`,
      );
    }

    if (!canReport(true, abortReason)) {
      ctx.logger.warn(
        `${taskLogLabel(task)} 命令已执行但值守壳正在停止（${abortReason}）：不 release、不回报，租约到期后由服务端回收`,
      );
      return { outcome: 'aborted' };
    }

    // 只接受“本次执行写出来的”结果文件：
    // - 执行前不存在、执行后存在 → 是这次写的；
    // - 执行前已存在但 mtime+size 没变 → 不是这次写的，忽略；
    // - 结果 JSON 带 task_id 且与当前任务不一致 → 是别的任务写的，忽略。
    const resultRead = taskFiles.resultPath
      ? readResultFileForTask(taskFiles.resultPath, {
          sinceMs: runStartedAt,
          taskId: task.id,
          baseline: resultBaseline,
        })
      : { file: null, issue: 'unconfigured', path: null };
    const resultFile = resultRead.file;
    logResultFileIssue(ctx, task, resultRead);
    let { commandSucceeded, result } = classifyCommandOutcome(execView, resultFile);
    // 讨论任务的“证据”就是结论本身：结果文件缺失或被判为别人的/旧的时，
    // 不能因为进程退出码 0 就把任务标成功——那会让任务看起来已完成却没有答案。
    if (
      details.kind === 'discussion' &&
      commandSucceeded &&
      result === 'success' &&
      resultRead.issue &&
      resultRead.issue !== 'unconfigured'
    ) {
      result = 'blocked';
      ctx.logger.warn(`${taskLogLabel(task)} 讨论任务没有可用的结果文件，按 blocked 回报`);
    }
    const finalized = await finalizeTask(ctx, {
      task,
      rule,
      claim,
      execView,
      resultFile,
      resultFileInfo: resultRead,
      commandSucceeded,
      result,
    });
    return {
      ...finalized,
      // 仅供 runner 本进程判断“连续同因快速失败”，不写进卡片、任务字段或日志。
      // 任务结论为 failed 才生成；命令退出码 0 但 result_file 自报 failed 也算，
      // 因为“任务失败”已经由服务端状态确认，熔断看的是失败表现的重复性。
      failureSignature: result === 'failed' ? buildFastFailureSignature(execView) : null,
    };
  } finally {
    stopRenewal();
    forwarder?.flush();
    taskFiles?.cleanup();
    ctx.state.setBusy(false, null);
    // 结束也要立即报 idle：否则任务已经回报完成，页面还会继续显示“运行中”
    // 直到下一拍心跳，看起来像卡住了。
    ctx.heartbeatNow?.();
    ctx.signal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * 优先用 claim 返回的任务视图（服务端 toView 含完整描述）。
 * 若描述缺失且服务端真的声明了 task.get 才调用；否则用 task.list include_description 兜底。
 * 规格里写了 task.get，但当前服务端 23 个工具并没有它——这里不能硬调用。
 */
async function fetchTaskDetails(ctx, task, claim) {
  if (claim.task && claim.task.description_md !== null && claim.task.description_md !== undefined) {
    return { ...task, ...claim.task };
  }
  if (ctx.toolNames?.has('task.get')) {
    try {
      const raw = await ctx.client.call('task.get', { task_id: task.id }, { timeoutMs: 20_000 });
      return { ...task, ...parseTask(raw, 'task.get') };
    } catch (error) {
      if (isAuthError(error)) throw error;
      ctx.logger.debug(`task.get 不可用，降级到 task.list：${errorMessage(error)}`);
    }
  }
  try {
    // 不能按 assignee=harness_id 过滤：未指派的公共任务 assignee 为 null，
    // claim 后也不会自动写 assignee，按它过滤会恰好漏掉最常见的一类任务。
    // 按 channel_key + status 翻页找 id，既是服务端支持的精确查询，也不依赖不存在的 task.get。
    for (let page = 1; page <= MAX_TASK_LIST_PAGES; page += 1) {
      const parsed = parseTaskPage(
        await ctx.client.call(
          'task.list',
          {
            channel_key: task.channel_key,
            status: 'claimed',
            include_description: true,
            page,
            page_size: TASK_LIST_PAGE_SIZE,
          },
          { timeoutMs: 20_000 },
        ),
      );
      const found = parsed.items.find((item) => item.id === task.id);
      if (found) return { ...task, ...found };
      if (!parsed.hasMore || parsed.items.length === 0) break;
    }
  } catch (error) {
    if (isAuthError(error)) throw error;
    ctx.logger.warn(`${taskLogLabel(task)} 详情读取失败，使用 claim 返回的字段：${errorMessage(error)}`);
  }
  return { ...task, ...(claim.task ?? {}) };
}

/**
 * 结果文件不可用时要留下可排查的日志。
 *
 * 不能静默忽略：用户看到证据卡里只有“命令执行成功”而没有 harness 结论时，
 * 需要能从日志直接知道是没写、写旧了，还是写成了别的任务。
 */
function logResultFileIssue(ctx, task, info) {
  if (!info?.issue || info.issue === 'unconfigured') return;
  const suffix = info.path ? ` ${info.path}` : '';
  if (info.issue === 'missing') {
    ctx.logger.warn(`${taskLogLabel(task)} 未找到本次执行的结果文件${suffix}：证据摘要回退到命令退出信息`);
    return;
  }
  ctx.logger.warn(`${taskLogLabel(task)} 已忽略结果文件${suffix}：${resultFileIssueLabel(info)}`);
}

async function finalizeTask(
  ctx,
  { task, rule, claim, execView, resultFile, resultFileInfo, commandSucceeded, result },
) {
  const idempotencyKey = buildIdempotencyKey(task.id, claim.token);
  const cardInput = buildStatusCard({
    task,
    argv: rule.run.argv,
    cwd: rule.run.cwd,
    execResult: execView,
    resultFile,
    resultFileInfo,
    logFile: ctx.logFile,
    idempotencyKey,
    result,
  });

  let cardId;
  try {
    // 证据卡带 claim_token 派生的 idempotency_key，重发不会产生第二张卡。
    const posted = await callReportingWithRetry(
      ctx,
      `${taskLogLabel(task)} 证据卡发送`,
      () => ctx.client.call('card.post', cardInput, { timeoutMs: 30_000 }),
    );
    cardId = parseCardId(posted);
  } catch (error) {
    if (isAuthError(error)) throw error;
    return await handleCardFailure(ctx, task, claim.token, commandSucceeded, error);
  }

  if (result === 'success') {
    // 讨论任务的结论要落到任务详情页，供用户查看、并被下级讨论当作父级上下文。
    // detail_md 是完整回答，优先级高于一句话 summary；两者都为空就不传，
    // 避免把空字符串写成“已有结论”。失败/阻塞路径不写 answer。
    const answerMd =
      task.kind === 'discussion'
        ? resultFile?.detail_md?.trim() || resultFile?.summary?.trim() || ''
        : '';
    try {
      await callReportingWithRetry(
        ctx,
        `${taskLogLabel(task)} 完成回报（complete）`,
        () =>
          ctx.client.call(
            'task.update',
            {
              task_id: task.id,
              event: 'complete',
              claim_token: claim.token,
              evidence_card_ids: [cardId],
              ...(answerMd ? { answer_md: answerMd } : {}),
            },
            { timeoutMs: 20_000 },
          ),
      );
      ctx.logger.info(`${taskLogLabel(task)} 已完成（证据卡 ${cardId}）`);
      return { outcome: 'completed', cardId };
    } catch (error) {
      if (isAuthError(error)) throw error;
      await tryBlock(
        ctx,
        task.id,
        claim.token,
        buildCompleteFailureReason(errorMessage(error)),
      );
      return { outcome: 'report_failed', cardId, error };
    }
  }

  if (result === 'failed') {
    try {
      await callReportingWithRetry(
        ctx,
        `${taskLogLabel(task)} 失败回报（fail）`,
        () =>
          ctx.client.call(
            'task.update',
            {
              task_id: task.id,
              event: 'fail',
              claim_token: claim.token,
              reason: buildFailReason({
                argv: rule.run.argv,
                execResult: execView,
                extra: resultFile?.summary,
              }),
            },
            { timeoutMs: 20_000 },
          ),
      );
      ctx.logger.info(`${taskLogLabel(task)} 已标记失败（证据卡 ${cardId}）`);
      return { outcome: 'failed', cardId };
    } catch (error) {
      if (isAuthError(error)) throw error;
      await tryBlock(ctx, task.id, claim.token, buildReportFailureReason(errorMessage(error)));
      return { outcome: 'report_failed', cardId, error };
    }
  }

  // blocked / partial：harness 明确表示需要人工接手或只完成一部分。
  const reason =
    resultFile?.summary?.trim() ||
    (task.kind === 'discussion' && resultFileInfo?.issue && resultFileInfo.issue !== 'unconfigured'
      ? `讨论任务未产出可用的结果文件：${resultFileIssueLabel(resultFileInfo)}`
      : result === 'partial'
        ? `命令部分完成：${cardInput.summary}`
        : `harness 报告需要人工处理：${cardInput.summary}`);
  const blocked = await tryBlock(ctx, task.id, claim.token, reason);
  return blocked ? { outcome: 'blocked', cardId } : { outcome: 'report_failed', cardId };
}

async function handleCardFailure(ctx, task, claimToken, commandSucceeded, error) {
  ctx.logger.warn(`${taskLogLabel(task)} 证据卡发送失败：${errorMessage(error)}`);
  const action = evidenceFailureAction(commandSucceeded);
  const reason = buildEvidenceFailureReason(commandSucceeded, errorMessage(error));
  if (action === 'block') {
    await tryBlock(ctx, task.id, claimToken, reason);
  } else {
    const failed = await tryTaskUpdate(ctx, task.id, claimToken, { event: 'fail', reason });
    if (!failed) await tryBlock(ctx, task.id, claimToken, reason);
  }
  return { outcome: 'report_failed', error };
}

async function tryBlock(ctx, taskId, claimToken, reason) {
  const ok = await tryTaskUpdate(ctx, taskId, claimToken, { event: 'block', reason });
  if (ok) ctx.logger.info(`任务 ${taskId} 已标记 block：${reason}`);
  return ok;
}

async function tryTaskUpdate(ctx, taskId, claimToken, payload) {
  try {
    await callReportingWithRetry(
      ctx,
      `任务 ${taskId} 状态回报（${payload.event}）`,
      () =>
        ctx.client.call(
          'task.update',
          { task_id: taskId, claim_token: claimToken, ...payload },
          { timeoutMs: 20_000 },
        ),
    );
    return true;
  } catch (error) {
    if (isAuthError(error)) throw error;
    ctx.logger.warn(`任务 ${taskId} 状态回报失败（${payload.event}）：${errorMessage(error)}`);
    return false;
  }
}

async function releaseQuietly(ctx, taskId, claimToken, reason) {
  try {
    await callReportingWithRetry(
      ctx,
      `任务 ${taskId} 释放（release）`,
      () =>
        ctx.client.call(
          'task.release',
          { task_id: taskId, claim_token: claimToken, reason: reason.slice(0, 4_000) },
          { timeoutMs: 10_000 },
        ),
    );
    ctx.logger.info(`已释放任务 ${taskId}：${reason}`);
  } catch (error) {
    if (isAuthError(error)) {
      ctx.logger.warn(`任务 ${taskId} 释放失败（401 后不再请求）：${errorMessage(error)}`);
      return;
    }
    ctx.logger.warn(`任务 ${taskId} 释放失败（租约到期后会被回收）：${errorMessage(error)}`);
  }
}

/**
 * 状态回报统一走有界重试。
 *
 * 只包住“发一次状态/证据请求”，不包命令执行；命令已跑过的分支依旧绝不 release，
 * 租约丢失依旧绝不 release，401 依旧立即抛出。
 */
function callReportingWithRetry(ctx, label, operation) {
  return callWithRetry(operation, {
    onRetry: ({ error, attempt, delayMs }) => {
      ctx.logger.warn(
        `${label}遇到可重试错误（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次尝试，${delayMs}ms 后重试）：${errorMessage(error)}`,
      );
    },
  });
}

/**
 * 续租：用 task.claim 带原 claim_token。
 * 租约一旦丢失，继续跑的进程会和新认领方同时写同一任务，所以必须立刻杀命令。
 */
function startLeaseRenewal(ctx, taskId, token, onLost, onAuth) {
  const intervalMs = Math.max(1_000, Math.floor((ctx.getConfig().lease_seconds * 1_000) / 3));
  let inFlight = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (inFlight || stopped) return;
    inFlight = true;
    void ctx.client
      .call(
        'task.claim',
        {
          task_id: taskId,
          harness_id: ctx.getConfig().harness_id,
          lease_seconds: ctx.getConfig().lease_seconds,
          claim_token: token,
        },
        { timeoutMs: 15_000 },
      )
      .then(() => undefined)
      .catch((error) => {
        if (stopped) return;
        if (isAuthError(error)) {
          onAuth(error);
          return;
        }
        if (isLeaseLostError(error)) {
          onLost(errorMessage(error));
          return;
        }
        ctx.logger.warn(`任务 ${taskId} 续租失败：${errorMessage(error)}`);
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * 跑一次 harness 尝试。Claude 续会话失败时会对同一任务再调用一次，
 * 两次尝试各自有独立输出缓冲区；日志保留两次现场，证据卡只取最终一次。
 */
async function executeHarnessAttempt({ ctx, task, rule, env, argv, shell, stdinPayload, signal }) {
  const forwarder = createOutputForwarder(ctx, task);
  const execResult = await executeCommand({
    argv,
    cwd: rule.run.cwd,
    env,
    shell,
    timeoutMs: rule.run.timeout_seconds * 1_000,
    signal,
    forceKill: ctx.forceKill === true,
    stdinPayload,
    onOutput: forwarder.onOutput,
    // 记录 harness 的 PID：stop 走 Abort 已能杀树，但 `kill` 是外部强制终止，
    // 需要先知道子进程 PID 才能在 POSIX 上把它所在的进程组一起收掉。
    onSpawn: (pid) =>
      ctx.state.setBusy(true, {
        task_id: task.id,
        title: task.title,
        started_at: new Date().toISOString(),
        pid,
      }),
  });
  forwarder.flush();
  return { execResult, forwarder };
}

function buildTaskEnv(config, task, rule, { resultPath = null } = {}) {
  const passthrough = [...config.env_passthrough, ...rule.run.env_passthrough];
  return buildChildEnv({
    passthrough,
    extraEnv: {
      ...rule.run.env,
      AIDASH_RUNNER: '1',
      AIDASH_HARNESS_ID: config.harness_id,
      AIDASH_TASK_ID: task.id,
      AIDASH_TASK_TITLE: task.title,
      AIDASH_CHANNEL_KEY: task.channel_key,
      // 给脚本/包装器一个不依赖提示词的出口；没有配置结果文件时不注入空值。
      ...(resultPath ? { AIDASH_RESULT_FILE: resultPath } : {}),
    },
  });
}

/**
 * 输出转发：一块数据同时进终端（前台）、日志文件、首尾 8KB 环。
 *
 * 解码不能简单用 StringDecoder('utf8')：Windows 中文系统的 cmd 输出是 GBK，
 * 那样会把「写个py」变成 `'д��py'` 写进日志和证据卡。StreamTextDecoder 默认
 * 按 UTF-8 流式解码（跨 chunk 多字节不误判），首次遇到非法字节才锁定 GBK。
 */
function createOutputForwarder(ctx, task) {
  const ring = new EdgeBuffer();
  const decoders = {
    stdout: new StreamTextDecoder(),
    stderr: new StreamTextDecoder(),
  };
  const prefix = ctx.noPrefix ? '' : `[${task.id}] `;
  let stderrHead = '';
  let stdoutHead = '';
  let prefixPending = prefix !== '';
  let flushed = false;

  // 只在“前台 + 真终端 + 非 JSON + 未关渲染”时把 stdout 当 Markdown 画到终端。
  // 日志文件、证据卡、重定向/管道仍保存原文：机器读的东西不该混进 ANSI。
  const markdown =
    ctx.foreground === true &&
    ctx.json !== true &&
    ctx.renderMarkdown !== false &&
    process.stdout.isTTY === true
      ? new ConsoleMarkdown({
          color: supportsColor(process.stdout),
          columns: process.stdout.columns,
        })
      : null;

  const writeTerminal = (target, text) => {
    try {
      target.write(text);
    } catch {
      // 终端已关闭；日志文件仍有记录。
    }
  };

  const consume = (stream, text) => {
    if (!text) return;
    ring.append(Buffer.from(text, 'utf8'));
    if (stream === 'stderr' && stderrHead.length < 2_000) {
      stderrHead += text.slice(0, 2_000 - stderrHead.length);
    }
    if (stream === 'stdout' && stdoutHead.length < 2_000) {
      stdoutHead += text.slice(0, 2_000 - stdoutHead.length);
    }
    const safe = redact(text);
    ctx.logger.writeRaw(prefix ? `${prefix}${safe}` : safe);
    if (!ctx.foreground || ctx.json) return;

    if (stream === 'stdout' && markdown) {
      const rendered = markdown.push(safe);
      if (!rendered) return;
      writeTerminal(process.stdout, prefixPending ? `${prefix}${rendered}` : rendered);
      prefixPending = false;
      return;
    }
    writeTerminal(stream === 'stderr' ? process.stderr : process.stdout, prefix ? `${prefix}${safe}` : safe);
  };

  const onOutput = (stream, chunk) => {
    const decoder = decoders[stream] ?? decoders.stdout;
    consume(stream, decoder.write(chunk));
  };

  // executeHarnessAttempt 收尾和 runClaimedTask 的 finally 都会调用 flush，
  // 只允许真正冲刷一次；否则 Markdown 渲染器会被 end() 两次。
  const flush = () => {
    if (flushed) return;
    flushed = true;
    for (const stream of ['stdout', 'stderr']) {
      const rest = decoders[stream].end();
      if (rest) consume(stream, rest);
    }
    if (markdown) {
      const tail = markdown.end();
      if (tail) {
        // harness 可能不写末尾换行；终端渲染补一个，避免后续日志/汇总贴在同一行。
        const shown = tail.endsWith('\n') ? tail : `${tail}\n`;
        writeTerminal(process.stdout, prefixPending ? `${prefix}${shown}` : shown);
        prefixPending = false;
      }
    }
  };

  return {
    onOutput,
    flush,
    ring,
    get stderrHead() {
      return stderrHead;
    },
    get stdoutHead() {
      return stdoutHead;
    },
  };
}

