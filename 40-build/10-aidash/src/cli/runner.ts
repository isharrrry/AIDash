import os from 'node:os';
import {
  BusinessError,
  isAuthError,
  isBusinessError,
  isTransportError,
  errorMessage,
} from './errors.js';
import type { CommandRule, WatchConfig } from './config.js';
import { isTaskAssignableTo, matchesChannelFilter, selectCommandRule } from './match.js';
import { executeCommand } from './exec.js';
import { redact, truncate } from './log.js';
import type { Logger } from './log.js';
import { HeartbeatLoop, sendHeartbeat } from './heartbeat.js';
import { parseClaimResult, parseTaskPage, type ClaimResult, type TaskItem } from './mcp-parse.js';
import type { AidashMcpClient } from './mcp-client.js';
import { buildFailReason, postStatusCard, releaseQuietly } from './report.js';

/**
 * 值守主循环：注册 → 心跳 → 列 pending → 认领 → start → 执行 → 发 status 卡 → complete/fail。
 *
 * 关键顺序不能反：
 * 1. 先 claim 再 start，state-machine 只允许 claimed → in_progress；
 * 2. 先发 status 卡并拿到 card_id，再 complete 并显式传 evidence_card_ids。
 *    服务端找不到关联证据会返回 EVIDENCE_REQUIRED，这里按业务错误退出，不硬重试；
 * 3. 只有“确认无法处理”（命令被中断、回报失败、启动失败等）才 release，
 *    正常完成/失败都走状态事件，不再 release（done/failed 不能回退到 pending）。
 */

const TASK_LIST_PAGE_SIZE = 100;
const TASK_LIST_MAX_PAGES = 10;
const LOG_COMMAND_LIMIT = 160;

/**
 * 被限流后的等待时长。
 * 为什么不解析服务端的 Retry-After：它只到整秒；即使按较慢的 60/分钟估算，补 1 个令牌也只要 1 秒，
 * 跟着它醒来正好卡在边界上容易再吃一次 429。固定等 5 秒能一次补够，
 * 也更简单 —— 这个值宁长勿短，反正限流本身就是异常路径。
 */
const RATE_LIMIT_WAIT_MS = 5_000;

export interface RunContext {
  client: AidashMcpClient;
  config: WatchConfig;
  logger: Logger;
  signal: AbortSignal;
}

export type RunMode = 'run' | 'once';

export interface TaskListFilter {
  status?: string;
  assignee?: string;
}

export async function runWatch(base: RunContext, mode: RunMode): Promise<void> {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  if (base.signal.aborted) controller.abort();
  else base.signal.addEventListener('abort', onExternalAbort, { once: true });

  const ctx: RunContext = { ...base, signal: controller.signal };
  let fatal: unknown = null;
  let mayHeartbeat = false;
  const heartbeat = new HeartbeatLoop(ctx, (error) => {
    fatal = error;
    controller.abort();
  });

  try {
    if (controller.signal.aborted) return;
    await register(ctx);
    await sendHeartbeat(ctx, false);
    mayHeartbeat = true;
    heartbeat.start();

    while (!controller.signal.aborted) {
      let worked = false;
      let rateLimited = false;
      try {
        worked = await runIteration(ctx, heartbeat);
      } catch (error) {
        if (isAuthError(error)) fatal = error;
        if (isTransportError(error) && mode === 'run') {
          // 常驻模式下临时断网/服务重启不应杀掉值守壳；下一轮继续。
          // 业务错误（含 EVIDENCE_REQUIRED）不在这里吞掉：按契约以 exit 1 结束，避免假完成。
          ctx.logger.warn(`本轮通信失败，等待下次轮询：${errorMessage(error)}`);
        } else if (isBusinessError(error) && error.code === 'RATE_LIMITED' && mode === 'run') {
          // 限流是「稍后再来」而不是「做错了」，常驻模式必须等够时间再试，
          // 否则每轮都会吃 429：日志刷满、配额一点没回，还会把服务端日志淹掉。
          // 服务端窗口是分钟级的，用 poll_interval（通常 1~2 秒）去撞没有意义。
          ctx.logger.warn(`被限流，等待后重试：${errorMessage(error)}`);
          rateLimited = true;
        } else {
          throw error;
        }
      }
      if (mode === 'once') break;
      if (controller.signal.aborted) break;
      const delaySeconds = worked ? ctx.config.gap_seconds : ctx.config.poll_interval_seconds;
      // 限流时用一个明显长于轮询间隔的等待，让令牌桶真的有机会补充。
      await sleep(rateLimited ? RATE_LIMIT_WAIT_MS : delaySeconds * 1000, controller.signal);
    }

    if (fatal) throw fatal;
  } finally {
    // 401 之后不再发心跳：任何“再试一次”都只会把错误令牌继续送到服务端。
    await heartbeat.stop(mayHeartbeat && !isAuthError(fatal));
    base.signal.removeEventListener('abort', onExternalAbort);
  }
}

async function register(ctx: RunContext): Promise<void> {
  const args: Record<string, unknown> = {
    harness_id: ctx.config.harness_id,
    name: ctx.config.name,
    host: ctx.config.host ?? os.hostname(),
  };
  if (ctx.config.capabilities.length > 0) args.capabilities = ctx.config.capabilities;
  await ctx.client.call('harness.register', args, { timeoutMs: 15_000 });
}

export async function listTasks(
  client: AidashMcpClient,
  filter: TaskListFilter = {},
): Promise<TaskItem[]> {
  const items: TaskItem[] = [];
  for (let page = 1; page <= TASK_LIST_MAX_PAGES; page += 1) {
    const args: Record<string, unknown> = { page, page_size: TASK_LIST_PAGE_SIZE };
    if (filter.status) args.status = filter.status;
    if (filter.assignee) args.assignee = filter.assignee;
    const raw = await client.call<unknown>('task.list', args, { timeoutMs: 20_000 });
    const parsed = parseTaskPage(raw);
    items.push(...parsed.items);
    if (!parsed.hasMore || parsed.items.length === 0) break;
  }
  return items;
}

async function runIteration(ctx: RunContext, heartbeat: HeartbeatLoop): Promise<boolean> {
  const tasks = await listTasks(ctx.client, { status: 'pending' });
  const candidate = chooseCandidate(tasks, ctx.config);
  if (!candidate) {
    ctx.logger.debug('本轮没有匹配的待认领任务');
    return false;
  }
  ctx.logger.info(`准备认领任务 ${candidate.task.id}：${candidate.task.title}`);
  await processCandidate(ctx, candidate.task, candidate.rule, heartbeat);
  return true;
}

function chooseCandidate(
  tasks: TaskItem[],
  config: WatchConfig,
): { task: TaskItem; rule: CommandRule } | null {
  for (const task of tasks) {
    if (!isTaskAssignableTo(task, config.harness_id)) continue;
    if (!matchesChannelFilter(task.channel_key, config.channels)) continue;
    const rule = selectCommandRule(task, config.commands);
    if (rule) return { task, rule };
  }
  return null;
}

async function processCandidate(
  ctx: RunContext,
  task: TaskItem,
  rule: CommandRule,
  heartbeat: HeartbeatLoop,
): Promise<void> {
  if (ctx.signal.aborted) return;

  let claim: ClaimResult;
  try {
    claim = await claimTask(ctx, task.id);
  } catch (error) {
    if (isBusinessError(error) && error.code === 'ALREADY_CLAIMED') {
      ctx.logger.info(`任务 ${task.id} 已被其他 harness 认领，跳过`);
      return;
    }
    throw error;
  }

  if (ctx.signal.aborted) {
    await releaseQuietly(ctx, task.id, claim.token, '启动前收到中断信号');
    return;
  }

  const inner = new AbortController();
  const linkOuter = (): void => inner.abort();
  if (ctx.signal.aborted) inner.abort();
  else ctx.signal.addEventListener('abort', linkOuter, { once: true });

  let leaseLost: unknown = undefined;
  const stopRenewal = startLeaseRenewal(ctx, task.id, claim.token, (error) => {
    leaseLost = error;
    inner.abort();
  });
  let finalized = false;
  heartbeat.setBusy(true);

  try {
    await updateTask(ctx, {
      task_id: task.id,
      event: 'start',
      claim_token: claim.token,
    });

    ctx.logger.info(
      `执行任务 ${task.id}：${truncate(redact(rule.command), LOG_COMMAND_LIMIT)}`,
    );
    const result = await executeCommand({
      command: rule.command,
      timeoutMs: (rule.timeout_seconds ?? ctx.config.command_timeout_seconds) * 1000,
      signal: inner.signal,
      ...(rule.cwd ? { cwd: rule.cwd } : {}),
      env: {
        ...(rule.env ?? {}),
        AIDASH_HARNESS_ID: ctx.config.harness_id,
        AIDASH_TASK_ID: task.id,
        AIDASH_TASK_TITLE: task.title,
        AIDASH_CHANNEL_KEY: task.channel_key,
      },
    });

    if (leaseLost !== undefined) throw leaseLost;
    if (result.aborted) {
      // 401 导致的中断不再调用 release：令牌已失效，任何额外请求都只会再吃一次 401。
      if (!heartbeat.hasAuthFailed) {
        await releaseQuietly(ctx, task.id, claim.token, '进程被中断');
      }
      finalized = true;
      return;
    }

    const success = !result.timedOut && result.error === null && result.exitCode === 0;
    ctx.logger.info(
      `任务 ${task.id} 命令结束：${success ? '成功' : '失败'}（退出码 ${
        result.exitCode ?? '无'
      }，耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
    );

    const cardId = await postStatusCard(ctx, task, rule, result, success);
    if (success) {
      await updateTask(ctx, {
        task_id: task.id,
        event: 'complete',
        claim_token: claim.token,
        evidence_card_ids: [cardId],
      });
      ctx.logger.info(`任务 ${task.id} 已完成（证据卡 ${cardId}）`);
    } else {
      await updateTask(ctx, {
        task_id: task.id,
        event: 'fail',
        claim_token: claim.token,
        reason: buildFailReason(rule.command, result),
      });
      ctx.logger.info(`任务 ${task.id} 已标记失败`);
    }
    finalized = true;
  } catch (error) {
    if (!finalized && leaseLost === undefined && !ctx.signal.aborted && !isAuthError(error)) {
      await releaseQuietly(ctx, task.id, claim.token, `值守壳异常：${errorMessage(error)}`);
      finalized = true;
    }
    throw error;
  } finally {
    stopRenewal();
    heartbeat.setBusy(false);
    ctx.signal.removeEventListener('abort', linkOuter);
  }
}

async function claimTask(ctx: RunContext, taskId: string): Promise<ClaimResult> {
  const raw = await ctx.client.call<unknown>(
    'task.claim',
    {
      task_id: taskId,
      harness_id: ctx.config.harness_id,
      lease_seconds: ctx.config.lease_seconds,
    },
    { timeoutMs: 20_000 },
  );
  return parseClaimResult(raw);
}

async function updateTask(ctx: RunContext, args: Record<string, unknown>): Promise<void> {
  await ctx.client.call('task.update', args, { timeoutMs: 20_000 });
}

/**
 * 长命令可能跑得比租约久。设计文档 03 §3.9.3 约定用 task.claim 带原 token 续租；
 * 续租失败意味着锁已经丢了，必须立刻终止命令，否则两个 harness 会同时写同一任务。
 */
function startLeaseRenewal(
  ctx: RunContext,
  taskId: string,
  token: string,
  onLost: (error: unknown) => void,
): () => void {
  const intervalMs = Math.max(1_000, Math.floor((ctx.config.lease_seconds * 1000) / 3));
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void ctx.client
      .call<unknown>(
        'task.claim',
        {
          task_id: taskId,
          harness_id: ctx.config.harness_id,
          lease_seconds: ctx.config.lease_seconds,
          claim_token: token,
        },
        { timeoutMs: 15_000 },
      )
      .catch((error: unknown) => {
        if (isAuthError(error)) {
          onLost(error);
          return;
        }
        if (
          isBusinessError(error) &&
          (error.code === 'ALREADY_CLAIMED' ||
            error.code === 'CONFLICT' ||
            error.code === 'NOT_FOUND')
        ) {
          onLost(
            new BusinessError('LEASE_LOST', `任务 ${taskId} 租约丢失：${errorMessage(error)}`),
          );
          return;
        }
        ctx.logger.warn(`任务 ${taskId} 续租失败：${errorMessage(error)}`);
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** 可被 Ctrl+C 提前唤醒的 sleep；收到中断时 resolve，让主循环检查退出条件。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let finished = false;
    let timer: NodeJS.Timeout | null = null;
    const done = (): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => done();
    timer = setTimeout(done, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    // 注册监听与第一次检查之间可能刚好被中断，补一次检查避免睡满整轮。
    if (signal.aborted) onAbort();
  });
}
