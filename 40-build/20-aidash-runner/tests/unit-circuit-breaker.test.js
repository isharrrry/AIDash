import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFastFailureSignature,
  buildFastFailureStreakMessage,
  createFastFailureStreak,
  FAST_FAILURE_LIMIT_MS,
} from '../src/failure-policy.js';

/**
 * “连续同因快速失败”是纯函数，单独测可把判据钉死：
 * 快速、非零退出码、stderr 首个非空行相同，缺一不可。
 */

function execResult(overrides = {}) {
  return {
    started: true,
    exitCode: 7,
    timedOut: false,
    aborted: false,
    spawnError: null,
    durationMs: 120,
    stderrTail: 'same-fast-boom\n',
    ...overrides,
  };
}

test('快速失败判据：只看已启动、未超时/中止、整数退出码、<2s 且有 stderr 首行', () => {
  const signature = buildFastFailureSignature(execResult());
  assert.deepEqual(signature, {
    exitCode: 7,
    stderrFirstLine: 'same-fast-boom',
    durationMs: 120,
  });
  assert.equal(buildFastFailureSignature(execResult({ stderrTail: '\r\n  \r\n  boom  \r\nsecond' })).stderrFirstLine, 'boom');
  assert.equal(buildFastFailureSignature(execResult({ started: false })), null);
  assert.equal(buildFastFailureSignature(execResult({ timedOut: true })), null);
  assert.equal(buildFastFailureSignature(execResult({ aborted: true })), null);
  // harness 可以用 result_file 自报 failed 而进程退出码仍为 0；任务失败由外层判定。
  assert.equal(buildFastFailureSignature(execResult({ exitCode: 0 })).exitCode, 0);
  assert.equal(buildFastFailureSignature(execResult({ exitCode: null })), null);
  assert.equal(buildFastFailureSignature(execResult({ durationMs: FAST_FAILURE_LIMIT_MS })), null);
  assert.equal(buildFastFailureSignature(execResult({ durationMs: FAST_FAILURE_LIMIT_MS - 1 })).exitCode, 7);
  assert.equal(buildFastFailureSignature(execResult({ stderrTail: '\n  \r\n' })), null);
});

test('连续同因快速失败：第 2 个才熔断，并带出两个任务与首行 stderr', () => {
  const tracker = createFastFailureStreak();
  const signature = buildFastFailureSignature(execResult());

  const first = tracker.record({ taskId: 'task-a', outcome: 'failed', signature });
  assert.equal(first.tripped, false);
  assert.equal(first.count, 1);

  const second = tracker.record({ taskId: 'task-b', outcome: 'failed', signature });
  assert.equal(second.tripped, true);
  assert.equal(second.count, 2);
  assert.deepEqual(second.taskIds, ['task-a', 'task-b']);

  const message = buildFastFailureStreakMessage(second);
  assert.match(message, /连续 2 个任务/);
  assert.match(message, /task-a、task-b/);
  assert.match(message, /退出码 7/);
  assert.match(message, /same-fast-boom/);
  assert.match(message, /暂停认领并退出/);
});

test('不同 stderr、不同退出码、慢失败与成功都会打断“连续同因”', () => {
  const fastA = buildFastFailureSignature(execResult({ stderrTail: 'boom-a\n' }));
  const fastB = buildFastFailureSignature(execResult({ stderrTail: 'boom-b\n' }));
  const exit8 = buildFastFailureSignature(execResult({ exitCode: 8, stderrTail: 'boom-a\n' }));
  const slow = buildFastFailureSignature(execResult({ durationMs: FAST_FAILURE_LIMIT_MS }));
  const tracker = createFastFailureStreak();

  assert.equal(tracker.record({ taskId: 'a1', outcome: 'failed', signature: fastA }).tripped, false);
  // 成功 / 阻塞 / 回报失败等非 failed 结果必须清零。
  assert.equal(tracker.record({ taskId: 'ok', outcome: 'completed', signature: null }).count, 0);
  assert.equal(tracker.record({ taskId: 'a2', outcome: 'failed', signature: fastA }).count, 1);
  // 慢失败没有快速失败签名，同样清零。
  assert.equal(tracker.record({ taskId: 'slow', outcome: 'failed', signature: slow }).count, 0);
  assert.equal(tracker.record({ taskId: 'a3', outcome: 'failed', signature: fastA }).count, 1);
  // 退出码不同、stderr 不同都重新从 1 开始；之后再次相同才会在第 2 个熔断。
  assert.equal(tracker.record({ taskId: 'exit8', outcome: 'failed', signature: exit8 }).count, 1);
  assert.equal(tracker.record({ taskId: 'b1', outcome: 'failed', signature: fastB }).count, 1);
  assert.equal(tracker.record({ taskId: 'b2', outcome: 'failed', signature: fastB }).tripped, true);
});
