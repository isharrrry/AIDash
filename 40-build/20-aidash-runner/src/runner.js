import path from 'node:path';
import { VERSION } from './constants.js';
import {
  CircuitBreakerError,
  ConfigError,
  errorMessage,
  isAuthError,
  TransportError,
} from './errors.js';
import { McpClient } from './mcp-client.js';
import { Logger } from './logger.js';
import { planTasks } from './match.js';
import { parseClaimResult } from './task-parse.js';
import { runClaimedTask } from './task-runner.js';
import { normalizeResumeEngine } from './claude-session.js';
import { applyRunnerSetup } from './channel-setup.js';
import { listPendingTasks, previewPendingTasks, runDryRun } from './preview.js';

// 保持既有内部导出路径（历史测试可能直接 import runner.js）。
export { listPendingTasks, previewPendingTasks, runDryRun };
import {
  buildFastFailureStreakMessage,
  createFastFailureStreak,
  shouldExitAfterConsecutiveErrors,
} from './failure-policy.js';
import {
  applyConfigPatch,
  coerceConfigValue,
  configView,
  persistConfigPatch,
} from './config-keys.js';
import { loadConfig } from './config.js';
import { startControlServer } from './control-server.js';
import {
  buildRegistryEntry,
  inspectRegistryEntry,
  readRegistryEntry,
  removeRegistryEntry,
  writeRegistryEntry,
} from './registry.js';
import { sanitizeInstanceId, backoffDelayMs, ensureDirSync, isoNow, sleep } from './util.js';

/**
 * 值守主循环。
 *
 * 这个文件只负责“什么时候去拉、拉到了怎么排队、什么时候退出”；
 * 单个任务的执行/回报在 task-runner.js，失败策略在 failure-policy.js。
 * 拆开的理由是三者出错的代价不同：循环错误会打掉常驻进程，任务错误只影响一条任务，
 * 失败策略错误则会造成重复执行。混在一起时测试很难只验证其中一层。
 */

const REGISTER_TIMEOUT_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const CLAIM_TIMEOUT_MS = 30_000;
const STATUS_RECENT_LIMIT = 50;

export class RunnerState {
  constructor({ instanceId, harnessId, name, mode, startedAt }) {
    this.instanceId = instanceId;
    this.harnessId = harnessId;
    this.name = name;
    this.mode = mode;
    this.startedAt = startedAt;
    this.connected = false;
    this.registered = false;
    this.busy = false;
    this.currentTask = null;
    this.lastPollAt = null;
    this.lastPoll = null;
    this.lastHeartbeatAt = null;
    this.lastError = null;
    this.lastTaskOutcome = null;
    this.stats = {
      polls: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      released: 0,
      report_failed: 0,
      lease_lost: 0,
      aborted: 0,
      claim_skipped: 0,
      errors: 0,
      config_revisions: 0,
    };
  }

  setBusy(busy, info) {
    this.busy = busy === true;
    this.currentTask = this.busy ? info ?? null : null;
  }

  snapshot(config, { controlUrl = '', logFile = '', stopRequested = null } = {}) {
    const startedMs = Date.parse(this.startedAt);
    return {
      instance_id: this.instanceId,
      pid: process.pid,
      mode: this.mode,
      harness_id: this.harnessId,
      name: this.name,
      version: VERSION,
      started_at: this.startedAt,
      uptime_ms: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : null,
      control_url: controlUrl,
      log_file: logFile,
      connected: this.connected,
      registered: this.registered,
      busy: this.busy,
      current_task: this.currentTask,
      last_poll_at: this.lastPollAt,
      last_poll: this.lastPoll,
      last_heartbeat_at: this.lastHeartbeatAt,
      last_error: this.lastError,
      last_task: this.lastTaskOutcome,
      stop_requested: stopRequested,
      stats: { ...this.stats },
      config: configView(config),
    };
  }
}

/**
 * 可被 pull 提前唤醒的 sleep。
 * 每次等待只有一个等待者（主循环），所以可以安全地共享一个 resolve。
 */
function createPauser() {
  let resolveFn = null;
  let timer = null;
  return {
    sleep(ms) {
      return new Promise((resolve) => {
        resolveFn = resolve;
        timer = setTimeout(() => {
          timer = null;
          resolveFn = null;
          resolve();
        }, Math.max(0, ms));
      });
    },
    wake() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const resolve = resolveFn;
      resolveFn = null;
      if (resolve) resolve();
    },
  };
}

/**
 * 启动常驻实例。
 * @returns {Promise<{exitCode: number, stopReason: string|null, error: Error|null}>}
 */
export async function runService(options) {
  const {
    config: initialConfig,
    token,
    dataDir,
    mode = 'foreground',
    logFile,
    flags = {},
    env = process.env,
    cwd = process.cwd(),
    startedAt = isoNow(),
    installSignalHandlers = true,
    onReady,
  } = options;

  // 先在启动控制面/写 registry 之前校验，避免参数错误留下半截实例。
  const resumeEngine = normalizeResumeEngine(flags.resume);
  const instanceId = sanitizeInstanceId(initialConfig.harness_id);
  const logger = new Logger({ filePath: logFile, level: flags.verbose ? 'debug' : 'info' });
  const state = new RunnerState({
    instanceId,
    harnessId: initialConfig.harness_id,
    name: initialConfig.name,
    mode,
    startedAt,
  });
  const controller = new AbortController();
  const mainPauser = createPauser();
  let config = initialConfig;
  let controlUrl = '';
  let fatalError = null;
  let stopReason = null;
  let pullRequested = false;
  let clientReady = false;
  let registered = false;
  let setupDone = false;

  const tempDir = path.join(dataDir, 'tmp');
  ensureDirSync(tempDir, 0o700);

  const requestStop = (reason, error = null) => {
    if (error && !fatalError) fatalError = error;
    if (controller.signal.aborted) {
      mainPauser.wake();
      return;
    }
    stopReason = reason;
    logger.info(`收到停止请求：${reason}`);
    controller.abort();
    mainPauser.wake();
  };

  const triggerPull = () => {
    pullRequested = true;
    if (state.busy) {
      return { triggered: true, queued: true, reason: '当前任务执行中，已合并到下一轮' };
    }
    mainPauser.wake();
    return { triggered: true, queued: false };
  };

  const getConfig = () => config;

  const applyRuntimeConfig = (patch, persist) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
      throw new ConfigError('config set 需要至少一个配置项');
    }
    // 先统一类型再落盘：CLI 传进来的是字符串 "10"，直接写文件会变成 "10"
    // 字符串，下次启动 schema 校验就失败。
    const coerced = {};
    for (const [key, raw] of Object.entries(patch)) {
      coerced[key] = coerceConfigValue(key, raw);
    }
    const next = applyConfigPatch(config, coerced);
    if (persist) persistConfigPatch(config, coerced);
    config = next;
    state.harnessId = next.harness_id;
    state.stats.config_revisions += 1;
    const appliedKeys = Object.keys(patch);
    logger.info(`运行时配置已更新：${appliedKeys.join(', ')}${persist ? '（已写回配置文件）' : ''}`);
    return {
      applied: appliedKeys,
      persisted: persist === true,
      config: configView(config),
    };
  };

  const reloadRuntimeConfig = () => {
    const loaded = loadConfig(flags, { env, cwd });
    const loadedConfig = loaded.config;
    const next = { ...config };
    const applied = [];
    const liveKeys = [
      'poll_interval_seconds',
      'lease_seconds',
      'heartbeat_interval_seconds',
      'gap_seconds',
      'channels',
      'env_passthrough',
    ];
    for (const key of liveKeys) {
      if (JSON.stringify(next[key]) !== JSON.stringify(loadedConfig[key])) {
        next[key] = loadedConfig[key];
        applied.push(key);
      }
    }
    next.config_path = loadedConfig.config_path;
    next.config_dir = loadedConfig.config_dir;

    // 这里必须覆盖“所有不热改的键”。漏掉一个，用户改了文件、reload 返回成功，
    // 实际既没生效也没提示，最容易被误判成“配置已生效”——静默偏差比报错更危险。
    // commands 故意不热换：它决定“执行什么”，与 config set 拒绝 commands 保持一致，
    // 也让变更经过一次显式重启，避免文件改错后在常驻进程里悄悄放大。
    const restartRequired = [];
    const restartPairs = [
      ['endpoint', 'aidash_url'],
      ['token_env', 'token_env'],
      ['harness_id', 'harness_id'],
      ['name', 'name'],
      ['host', 'host'],
      ['capabilities', 'capabilities'],
      ['commands', 'commands'],
      ['command_timeout_seconds', 'command_timeout_seconds'],
      ['concurrency', 'concurrency'],
      ['data_dir', 'data_dir'],
      ['log_file', 'log_file'],
    ];
    for (const [currentKey, label] of restartPairs) {
      if (JSON.stringify(config[currentKey]) !== JSON.stringify(loadedConfig[currentKey])) {
        restartRequired.push(label);
      }
    }

    config = next;
    state.stats.config_revisions += 1;
    logger.info(
      `配置已重新加载：${applied.length > 0 ? applied.join(', ') : '无运行时变化'}` +
        `${restartRequired.length > 0 ? `；需重启：${restartRequired.join(', ')}` : ''}`,
    );
    return {
      reloaded: true,
      applied,
      restart_required: restartRequired,
      warnings: loaded.warnings,
      config: configView(config),
    };
  };

  // 同一 harness_id 不应有两个实例：它们会互相覆盖注册、抢同一批任务、
  // 且 registry 文件只能指向其中一个。旧记录确认死亡后才允许覆盖。
  const previous = readRegistryEntry(dataDir, instanceId);
  if (previous) {
    const previousStatus = await inspectRegistryEntry(previous, { timeoutMs: 1_000 });
    if (previousStatus.alive && previous.pid !== process.pid) {
      throw new ConfigError(
        `实例 ${instanceId} 已在运行（pid ${previous.pid}，控制面 ${previous.control_url}）；` +
          '请先 stop，或换一个 harness_id / 配置文件',
      );
    }
  }

  const controlToken = options.controlToken;
  const control = await startControlServer({
    identity: () => ({
      instance_id: instanceId,
      pid: process.pid,
      harness_id: state.harnessId,
      name: state.name,
      mode,
      started_at: startedAt,
      version: VERSION,
    }),
    getStatus: () =>
      state.snapshot(config, {
        controlUrl,
        logFile,
        stopRequested: stopReason,
      }),
    onPull: () => triggerPull(),
    onStop: () => requestStop('control'),
    onConfig: (patch, persist) => applyRuntimeConfig(patch, persist),
    onReload: () => reloadRuntimeConfig(),
    controlToken,
    logger,
  });
  controlUrl = control.url;

  const entry = buildRegistryEntry({
    instanceId,
    pid: process.pid,
    mode,
    harnessId: state.harnessId,
    configPath: config.config_path,
    controlUrl,
    controlToken: control.token,
    logFile,
    startedAt,
    version: VERSION,
  });
  try {
    writeRegistryEntry(dataDir, entry);
  } catch (error) {
    await control.close();
    throw new ConfigError(
      `写入实例注册表失败：${error instanceof Error ? error.message : String(error)}；` +
        '请检查 --data-dir 或 AIDASH_RUNNER_HOME 的权限',
    );
  }

  state.registryFile = entry;
  logger.info(
    `实例 ${instanceId} 已启动（pid ${process.pid}，${mode}，控制面 ${controlUrl}，日志 ${logFile ?? '(无)'}）`,
  );
  if (typeof onReady === 'function') {
    try {
      onReady({ entry, controlUrl, state, logger });
    } catch (error) {
      logger.warn(`onReady 回调失败：${errorMessage(error)}`);
    }
  }

  const onSignal = () => requestStop('signal');
  if (installSignalHandlers) {
    // process.once：第一次信号优雅收尾；第二次走 Node 默认行为立即结束，
    // 防止卡住的网络请求让用户永远等不到退出。
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  const client = new McpClient({ endpoint: initialConfig.endpoint, token });
  const ctx = {
    client,
    logger,
    state,
    getConfig,
    signal: controller.signal,
    foreground: mode === 'foreground',
    json: flags.json === true,
    noPrefix: flags.noPrefix === true,
    logFile,
    dataDir,
    tempDir,
    toolNames: new Set(),
    forceKill: false,
    resumeEngine,
    // 只对常驻实例启用连续同因失败熔断：once 最多执行一个任务，没有“后续任务”。
    failureStreak: createFastFailureStreak(),
    circuitBreaker: null,
  };

  const heartbeatPromise = heartbeatLoop(ctx, {
    isRegistered: () => registered,
    onAuthError: (error) => requestStop('auth', error),
  });

  let consecutiveErrors = 0;
  try {
    while (!controller.signal.aborted) {
      try {
        if (!clientReady) {
          await client.connect({ timeoutMs: 15_000 });
          ctx.toolNames = new Set(await client.listToolNames());
          clientReady = true;
          state.connected = true;
          logger.info(`已连接 AIDash：${initialConfig.endpoint}`);
        }
        if (controller.signal.aborted) break;
        if (!registered) {
          await registerHarness(ctx);
          registered = true;
          state.registered = true;
          logger.info(`已注册 harness：${config.harness_id}`);
        }
        if (controller.signal.aborted) break;

        // 精确通道/初始化任务只在成功启动后做一次；失败则下一轮重试，
        // 两步都幂等（channel.upsert + 确定性 task idempotency_key）。
        if (!setupDone) {
          await applyRunnerSetup({ client, config, flags, logger, cwd });
          setupDone = true;
        }

        const executed = await pollCycle(ctx);
        consecutiveErrors = 0;
        state.lastError = null;
        if (controller.signal.aborted) break;

        if (ctx.circuitBreaker) {
          const breaker = ctx.circuitBreaker;
          state.lastError = {
            at: isoNow(),
            kind: 'circuit_breaker',
            message: breaker.message,
          };
          // 熔断不是临时传输错误：继续循环只会再认领、再快速失败。这里直接
          // 请求停止，并由 CircuitBreakerError 把退出码定为 1（区别于正常空闲退出 0）。
          requestStop('circuit_breaker', new CircuitBreakerError(breaker.message, breaker.details));
          break;
        }

        if (executed) {
          // 两个任务之间留 gap，既给服务端落库时间，也避免上一轮子进程的
          // 句柄/端口还没释放就拉起下一个。
          await mainPauser.sleep(Math.max(0, config.gap_seconds * 1_000));
        } else if (pullRequested) {
          pullRequested = false;
          // pull 已把我们从 sleep 里唤醒或标记了下一轮；直接进入下一轮拉取。
          continue;
        } else {
          await mainPauser.sleep(Math.max(1_000, config.poll_interval_seconds * 1_000));
        }
        pullRequested = false;
      } catch (error) {
        if (isAuthError(error)) {
          requestStop('auth', error);
          break;
        }
        consecutiveErrors += 1;
        state.stats.errors += 1;
        state.lastError = {
          at: isoNow(),
          kind: error?.kind ?? 'unknown',
          message: errorMessage(error),
        };
        logger.warn(`本轮失败（连续 ${consecutiveErrors} 次）：${errorMessage(error)}`);
        if (controller.signal.aborted) break;
        if (error instanceof ConfigError) {
          // 配置类错误（例如命令根本不存在）重试不会变好，立即停止。
          requestStop('fatal', error);
          break;
        }
        if (/RATE_LIMITED/.test(errorMessage(error))) {
          // 服务端限流时按 retry_after 退避，默认 30 秒；不要按 2 秒 gap 硬撞。
          const raw = Number(error?.details?.retry_after ?? 30);
          const seconds = Number.isFinite(raw) ? Math.min(Math.max(raw, 5), 300) : 30;
          await mainPauser.sleep(seconds * 1_000);
          continue;
        }
        if (error?.kind === 'transport') {
          // 断线不退出，但必须真正“重连”：只退避不清状态的话，服务端重启后
          // clientReady/registered 仍是 true，主循环会一直跳过 initialize/register，
          // 然后每次 claim 都撞 HARNESS_NOT_REGISTERED，退避到天荒地老。
          // 这两个标志是“本次进程内已连接/已注册”的缓存，传输层一断就作废。
          clientReady = false;
          registered = false;
          state.connected = false;
          state.registered = false;
          await mainPauser.sleep(backoffDelayMs(consecutiveErrors));
        } else {
          // 传输错误可以无限重试；其它连续不可恢复错误重试再多次也不会变好，
          // 达到阈值就退出，避免常驻进程变成“每 2 秒报同一个错”的噪声源。
          if (shouldExitAfterConsecutiveErrors(consecutiveErrors)) {
            requestStop('fatal', error);
            break;
          }
          await mainPauser.sleep(Math.max(1_000, config.gap_seconds * 1_000));
        }
      }
    }
  } finally {
    controller.abort();
    mainPauser.wake();
    if (installSignalHandlers) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    await heartbeatPromise.catch(() => undefined);
    await control.close().catch(() => undefined);
    removeRegistryEntry(dataDir, instanceId, { pid: process.pid });
    state.connected = false;
    state.registered = false;
    logger.info(`实例 ${instanceId} 已停止${stopReason ? `（原因：${stopReason}）` : ''}`);
  }

  return {
    exitCode: fatalError ? fatalError.exitCode ?? 2 : 0,
    stopReason,
    error: fatalError,
  };
}

/**
 * `once`：连上服务端、注册、最多跑一个任务，然后退出。
 * 不写 registry、不开控制面——它是一次性命令，不是可管理的常驻实例。
 */
export async function runOnce({ config, token, dataDir, logFile = null, flags = {}, signal }) {
  ensureDirSync(path.join(dataDir, 'tmp'), 0o700);
  const resumeEngine = normalizeResumeEngine(flags.resume);
  const logger = new Logger({ filePath: logFile, level: flags.verbose ? 'debug' : 'info' });
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  const onExternalAbort = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  const state = new RunnerState({
    instanceId: sanitizeInstanceId(config.harness_id),
    harnessId: config.harness_id,
    name: config.name,
    mode: 'once',
    startedAt: isoNow(),
  });
  const client = new McpClient({ endpoint: config.endpoint, token });
  const ctx = {
    client,
    logger,
    state,
    getConfig: () => config,
    signal: controller.signal,
    foreground: true,
    json: flags.json === true,
    noPrefix: flags.noPrefix === true,
    logFile,
    dataDir,
    tempDir: path.join(dataDir, 'tmp'),
    toolNames: new Set(),
    forceKill: false,
    resumeEngine,
  };

  try {
    await client.connect({ timeoutMs: 15_000 });
    ctx.toolNames = new Set(await client.listToolNames());
    state.connected = true;
    await registerHarness(ctx);
    state.registered = true;
    await applyRunnerSetup({ client, config, flags, logger, cwd: process.cwd() });
    const executed = await pollCycle(ctx);
    return {
      executed,
      interrupted: controller.signal.aborted,
      pending: state.lastPoll?.pending ?? 0,
      planned: state.lastPoll?.planned ?? [],
      skipped: state.lastPoll?.skipped ?? [],
      last_task: state.lastTaskOutcome,
      stats: { ...state.stats },
    };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function registerHarness(ctx) {
  const config = ctx.getConfig();
  const args = { harness_id: config.harness_id, name: config.name };
  if (config.host) args.host = config.host;
  if (config.capabilities.length > 0) args.capabilities = config.capabilities;
  await ctx.client.call('harness.register', args, { timeoutMs: REGISTER_TIMEOUT_MS });
}

/**
 * 一轮：拉 pending → 过滤/排序 → 逐个尝试 claim → 执行第一个成功认领的任务。
 *
 * 为什么一轮只执行一个：本包明确不支持并发；一次只跑一个也让 stop/续租的
 * 生命周期简单很多。列表里其它候选会在下一轮重新拉取，状态可能已变化。
 */
async function pollCycle(ctx) {
  if (ctx.signal.aborted) return false;
  const tasks = await listPendingTasks(ctx.client);
  const config = ctx.getConfig();
  const { planned, skipped } = planTasks(tasks, config);
  ctx.state.stats.polls += 1;
  ctx.state.lastPollAt = isoNow();
  ctx.state.lastPoll = {
    pending: tasks.length,
    planned: planned.slice(0, STATUS_RECENT_LIMIT).map((item) => item.task.id),
    skipped: skipped.slice(0, STATUS_RECENT_LIMIT).map((item) => ({
      task_id: item.task.id,
      reasons: item.reasons,
    })),
    truncated: planned.length > STATUS_RECENT_LIMIT || skipped.length > STATUS_RECENT_LIMIT,
  };
  ctx.logger.debug(
    `拉取完成：pending ${tasks.length}，计划 ${planned.length}，跳过 ${skipped.length}`,
  );

  for (const candidate of planned) {
    if (ctx.signal.aborted) return false;
    const claim = await tryClaim(ctx, candidate.task);
    if (!claim) continue;
    ctx.state.stats.claimed += 1;
    const merged = {
      ...candidate.task,
      ...claim.task,
      // claim 的服务端视图默认不带正文，字段也可能是默认值；
      // 列表中的值至少是真实的，缺什么补什么。
      channel_key: claim.task.channel_key || candidate.task.channel_key,
      title: claim.task.title || candidate.task.title,
    };
    const outcome = await runClaimedTask(ctx, merged, candidate.rule, claim);
    countOutcome(ctx.state, outcome?.outcome);
    if (outcome?.fatal) {
      // 命令无法启动不是任务级失败：继续轮询只会对同一批任务反复 release/claim。
      // 直接按配置错误停止实例，让用户先修正 PATH 或 run.argv[0]。
      throw new ConfigError(
        `${outcome.error?.message ?? '命令无法启动'}；本次任务已释放，修正后重启值守壳`,
      );
    }
    const taskOutcome = outcome?.outcome ?? 'unknown';
    ctx.state.lastTaskOutcome = {
      at: isoNow(),
      task_id: merged.id,
      outcome: taskOutcome,
      card_id: outcome?.cardId ?? null,
    };

    const streak = ctx.failureStreak?.record({
      taskId: merged.id,
      outcome: taskOutcome,
      signature: outcome?.failureSignature ?? null,
    });
    if (streak?.tripped) {
      const message = buildFastFailureStreakMessage(streak);
      // 先把 WARN 落日志/终端，再让主循环退出；后台模式下日志是唯一现场。
      ctx.logger.warn(message);
      ctx.circuitBreaker = {
        message,
        details: {
          consecutive_tasks: streak.count,
          task_ids: streak.taskIds,
          exit_code: streak.signature.exitCode,
          stderr_first_line: streak.signature.stderrFirstLine,
        },
      };
    }
    return true;
  }
  return false;
}

async function tryClaim(ctx, task) {
  try {
    const raw = await ctx.client.call(
      'task.claim',
      {
        task_id: task.id,
        harness_id: ctx.getConfig().harness_id,
        lease_seconds: ctx.getConfig().lease_seconds,
      },
      { timeoutMs: CLAIM_TIMEOUT_MS },
    );
    return parseClaimResult(raw);
  } catch (error) {
    if (isAuthError(error)) throw error;
    if (error?.kind === 'business') {
      // 别人先抢到 / 状态已变 / 已删除都是正常竞争，换下一个候选即可。
      ctx.state.stats.claim_skipped += 1;
      ctx.logger.debug(`任务 ${task.id} 认领未成功：${errorMessage(error)}`);
      if (/HARNESS_NOT_REGISTERED/.test(error.message ?? '')) {
        // 服务端重启后内存里的 harness 注册会丢失；按传输问题处理，让主循环重注册。
        throw new TransportError('harness 注册已失效，需要重新注册');
      }
      return null;
    }
    throw error;
  }
}

function countOutcome(state, outcome) {
  switch (outcome) {
    case 'completed':
      state.stats.completed += 1;
      break;
    case 'failed':
      state.stats.failed += 1;
      break;
    case 'blocked':
      state.stats.blocked += 1;
      break;
    case 'released':
      state.stats.released += 1;
      break;
    case 'report_failed':
      state.stats.report_failed += 1;
      break;
    case 'lease_lost':
      state.stats.lease_lost += 1;
      break;
    case 'aborted':
      state.stats.aborted += 1;
      break;
    default:
      break;
  }
}

/**
 * 心跳独立循环：长任务执行期间仍要告诉服务端“我还活着”。
 * 心跳失败不终止任务；只有 401 才触发整体停止（一个令牌错了，后续请求都会错）。
 */
async function heartbeatLoop(ctx, { isRegistered, onAuthError }) {
  while (!ctx.signal.aborted) {
    const seconds = Math.max(1, ctx.getConfig().heartbeat_interval_seconds);
    await sleep(seconds * 1_000, ctx.signal);
    if (ctx.signal.aborted) break;
    if (!isRegistered()) continue;
    try {
      await ctx.client.call(
        'harness.heartbeat',
        {
          harness_id: ctx.getConfig().harness_id,
          status_hint: ctx.state.busy ? 'busy' : 'idle',
        },
        { timeoutMs: HEARTBEAT_TIMEOUT_MS },
      );
      ctx.state.lastHeartbeatAt = isoNow();
    } catch (error) {
      if (isAuthError(error)) {
        onAuthError(error);
        break;
      }
      ctx.logger.warn(`心跳失败：${errorMessage(error)}`);
    }
  }
}
