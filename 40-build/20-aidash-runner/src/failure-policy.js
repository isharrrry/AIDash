import { sanitizeForCard } from './redact.js';

/**
 * 失败策略的纯函数部分。
 *
 * 这些判断决定“任务会不会被重复执行”，是整个值守壳最需要测试的分支。
 * 抽成不依赖网络的纯函数，既能单测，也能在 review 时一眼看清：
 * 只有“命令没真正启动”才允许 release；命令一旦跑过，release 就等于允许下一次
 * 认领再跑一遍——重复执行比留下一个需要人工处理的 blocked 更危险。
 */

/** 快速失败阈值：严格小于 2000ms 才算“秒崩”，避免把正常慢失败误判成同一故障。 */
export const FAST_FAILURE_LIMIT_MS = 2_000;
/** 连续多少个同因快速失败后熔断。 */
export const FAST_FAILURE_STREAK_LIMIT = 2;
const FAILURE_LINE_LIMIT = 300;

/** 命令未启动（spawn error、取消发生在 spawn 前）才释放回 pending。 */
export function shouldRelease(commandStarted) {
  return commandStarted !== true;
}

/**
 * 命令已执行、但证据卡发不出去时怎么办。
 *
 * - 命令成功：block，写清“已执行但证据回报失败”，等人处理；
 * - 命令失败：fail（fail 不要求证据），理由同样写明证据回报失败；
 * 两者都绝不 release。
 */
export function evidenceFailureAction(commandSucceeded) {
  return commandSucceeded ? 'block' : 'fail';
}

/**
 * 命令结束后是否允许继续走回报流程。
 * lease_lost / stop / auth 三种情况都只记录，不 release、不发卡：
 * - lease_lost：锁已丢，写任何东西都可能覆盖新认领方；
 * - stop：用户要求停，网络调用随时会被截断；
 * - auth：401 后一个请求都不能再发。
 */
export function canReport(commandStarted, abortReason) {
  if (!commandStarted) return false;
  return !['lease_lost', 'stop', 'auth'].includes(abortReason ?? '');
}

/** 租约丢失的典型错误：令牌不再被服务端认可，或任务已被别人接管。 */
export function isLeaseLostError(error) {
  if (!error || error.kind !== 'business') return false;
  return ['ALREADY_CLAIMED', 'CONFLICT', 'NOT_FOUND'].includes(error.code);
}

export function buildEvidenceFailureReason(commandSucceeded, errorMessage) {
  const head = commandSucceeded ? '命令已执行但证据回报失败' : '命令执行失败且证据回报失败';
  return `${head}：${errorMessage}（命令已执行，未 release，避免重复执行）`;
}

export function buildCompleteFailureReason(errorMessage) {
  return `命令已执行但完成回报失败：${errorMessage}（未 release，避免重复执行）`;
}

export function buildReportFailureReason(errorMessage) {
  return `命令已执行但失败回报失败：${errorMessage}（未 release，避免重复执行）`;
}

/** 连续不可恢复的循环级错误才退出；单条坏任务不影响常驻进程。 */
export function shouldExitAfterConsecutiveErrors(count, threshold = 5) {
  return count >= threshold;
}

/** 命令与结果文件合成最终结论：命令失败永远压过 harness 自报的 success。 */
export function classifyCommandOutcome(execResult, resultFile) {
  const commandOk =
    execResult.started === true &&
    execResult.timedOut !== true &&
    !execResult.spawnError &&
    execResult.exitCode === 0;
  if (!commandOk) return { commandSucceeded: false, result: 'failed' };
  const reported = resultFile?.result ?? 'success';
  return { commandSucceeded: true, result: reported };
}

export function isRetryableBusinessError(error) {
  return Boolean(error && error.kind === 'business' && error.retryable);
}

/**
 * 连续同因失败熔断的“同因”判据（写在这里，避免以后有人只放宽一处）：
 *
 * 1. 任务本身必须已被服务端记为 failed；证据卡/complete/fail 回报失败不算，
 *    那说明问题在回报链路，不应把后续任务一起停掉；
 * 2. 命令确实启动过，且是正常退出（不是超时、不是被中止、不是 spawn 失败）；
 * 3. 退出码是整数，且两次完全相同。这里不额外要求“非零”：harness 可能用
 *    result_file 自报 failed 而进程退出码仍为 0，任务失败本身就是前提；
 * 4. 耗时严格小于 2000ms；
 * 5. stderr 的“首个非空行”去除首尾空白、ANSI 并按既有规则脱敏后非空，且两次
 *    完全相同。空 stderr 不参与熔断：没有可比较的失败证据，宁可继续跑也不
 *    把两个恰好都没输出 stderr 的不同故障误判成同因。
 *
 * 首行只比较前 300 字符。两个只在 300 字符之后不同的错误会被视为同因，这是
 * 为了给日志/卡片留长度上限；正常命令的首行错误信息远短于这个值。
 */
export function buildFastFailureSignature(execResult) {
  if (!execResult || execResult.started !== true) return null;
  if (execResult.timedOut === true || execResult.aborted === true) return null;
  if (!Number.isInteger(execResult.exitCode)) return null;
  if (!Number.isFinite(execResult.durationMs) || execResult.durationMs >= FAST_FAILURE_LIMIT_MS) {
    return null;
  }

  const stderr = String(execResult.stderrTail ?? execResult.stderr ?? '');
  const firstLine = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;

  return {
    exitCode: execResult.exitCode,
    stderrFirstLine: sanitizeForCard(firstLine, FAILURE_LINE_LIMIT),
    durationMs: Math.round(execResult.durationMs),
  };
}

export function isSameFastFailure(left, right) {
  if (!left || !right) return false;
  return left.exitCode === right.exitCode && left.stderrFirstLine === right.stderrFirstLine;
}

/**
 * 有状态的连续失败跟踪器。每次“认领并执行完一个任务”调用一次 record：
 * - 成功、阻塞、回报失败、慢失败、超时、无 stderr 等都会清空连续计数；
 * - 只有快速且退出码/首行 stderr 相同的失败才累加；
 * - 达到阈值（默认 2）返回 tripped=true，调用方必须停止认领。
 */
export function createFastFailureStreak({
  limit = FAST_FAILURE_STREAK_LIMIT,
} = {}) {
  let previous = null;
  let recentTaskIds = [];

  return {
    reset() {
      previous = null;
      recentTaskIds = [];
    },
    record({ taskId = '', outcome, signature = null } = {}) {
      if (outcome !== 'failed' || !signature) {
        previous = null;
        recentTaskIds = [];
        return { tripped: false, count: 0, taskIds: [], signature: null };
      }

      recentTaskIds =
        previous && isSameFastFailure(previous.signature, signature)
          ? [...recentTaskIds, taskId]
          : [taskId];
      const count = recentTaskIds.length;
      const result = {
        tripped: count >= limit,
        count,
        taskIds: [...recentTaskIds],
        signature,
      };
      previous = { taskId, signature };
      return result;
    },
  };
}

export function buildFastFailureStreakMessage(streak) {
  const { exitCode, stderrFirstLine } = streak.signature;
  return (
    `连续 ${streak.count} 个任务（${streak.taskIds.join('、')}）均在 ` +
    `${FAST_FAILURE_LIMIT_MS}ms 内以退出码 ${exitCode} 失败，且 stderr 首行相同：` +
    `“${stderrFirstLine}”；已暂停认领并退出（连续同因失败熔断），不再执行后续任务。`
  );
}
