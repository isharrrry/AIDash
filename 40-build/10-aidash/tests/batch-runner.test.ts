import { describe, expect, it } from 'vitest';
import {
  BatchRunner,
  runBatch,
  type BatchRunHooks,
} from '../src/server/services/batch-runner.js';

/**
 * 共享批次执行器的契约测试。
 *
 * 报告服务的业务用例负责证明“状态/审计没变”，这里只锁定所有批次都应遵守的
 * 顺序：开始前查取消、返回后再查取消、失败不再继续、halt 有独立收尾。
 */

function hooks(
  overrides: Partial<BatchRunHooks<number, { label: string }, string>> = {},
): BatchRunHooks<number, { label: string }, string> {
  return {
    isCancelled: () => false,
    begin: (item) => ({ kind: 'continue', context: { label: `item-${item}` } }),
    execute: async () => 'ok',
    complete: () => undefined,
    cancelled: () => undefined,
    halted: () => undefined,
    failed: () => undefined,
    done: () => undefined,
    reasonForError: () => 'failed',
    ...overrides,
  };
}

describe('runBatch：逐条状态推进', () => {
  it('全部成功时按 begin→execute→complete 推进，最后才 done', async () => {
    const events: string[] = [];
    const outcome = await runBatch(
      [1, 2],
      new AbortController().signal,
      hooks({
        begin: (item) => {
          events.push(`begin-${item}`);
          return { kind: 'continue', context: { label: `item-${item}` } };
        },
        execute: async (_item, context) => {
          events.push(`execute-${context.label}`);
          return 'ok';
        },
        complete: (item, _context, _result, completed) => {
          events.push(`complete-${item}-${completed}`);
        },
        done: (completed) => events.push(`done-${completed}`),
      }),
    );

    expect(outcome).toBe('done');
    expect(events).toEqual([
      'begin-1',
      'execute-item-1',
      'complete-1-1',
      'begin-2',
      'execute-item-2',
      'complete-2-2',
      'done-2',
    ]);
  });

  it('模型返回后才发现取消：不写 complete，当前条目交给 cancelled 标记', async () => {
    let checks = 0;
    const events: string[] = [];
    const outcome = await runBatch(
      [1],
      new AbortController().signal,
      hooks({
        // 第一次（开始前）未取消；第二次（execute 返回后）已取消。
        isCancelled: () => {
          checks += 1;
          return checks > 1;
        },
        complete: () => events.push('should-not-complete'),
        cancelled: (context) => events.push(`cancelled-${context?.label ?? 'none'}`),
      }),
    );

    expect(outcome).toBe('cancelled');
    expect(events).toEqual(['cancelled-item-1']);
  });

  it('开始前取消：不进入 begin/execute，context 为空', async () => {
    const events: string[] = [];
    const outcome = await runBatch([1], new AbortController().signal, hooks({
      isCancelled: () => true,
      begin: () => {
        events.push('begin');
        return { kind: 'continue', context: { label: 'x' } };
      },
      cancelled: (context) => events.push(context ? 'with-context' : 'no-context'),
    }));

    expect(outcome).toBe('cancelled');
    expect(events).toEqual(['no-context']);
  });

  it('失败即停：后续条目不开始，reasonForError 决定收敛后的原因', async () => {
    const events: string[] = [];
    const outcome = await runBatch([1, 2], new AbortController().signal, hooks({
      execute: async (item) => {
        if (item === 1) throw new Error('boom');
        return 'ok';
      },
      failed: (item, _context, _error, reason) => events.push(`failed-${item}-${reason}`),
      done: () => events.push('done'),
      reasonForError: () => 'MODEL_DOWN',
    }));

    expect(outcome).toBe('failed');
    expect(events).toEqual(['failed-1-MODEL_DOWN']);
  });

  it('目标已不存在时走 halted：不标记当前条目失败，也不再继续', async () => {
    const events: string[] = [];
    const outcome = await runBatch([1, 2], new AbortController().signal, hooks({
      begin: (item) =>
        item === 1
          ? { kind: 'halt', reason: 'REPORT_NOT_FOUND' }
          : { kind: 'continue', context: { label: 'next' } },
      halted: (item, reason, completed) => events.push(`halted-${item}-${reason}-${completed}`),
      done: () => events.push('done'),
    }));

    expect(outcome).toBe('halted');
    expect(events).toEqual(['halted-1-REPORT_NOT_FOUND-0']);
  });
});

describe('BatchRunner：后台生命周期', () => {
  it('run 把 abort 信号交给任务，任务结束后不再留在 pending', async () => {
    const runner = new BatchRunner();
    let signal: AbortSignal | undefined;
    const task = runner.run('rn_test', async (nextSignal) => {
      signal = nextSignal;
      await Promise.resolve();
      return 'finished';
    });

    expect(await task).toBe('finished');
    await runner.waitForIdle();
    expect(signal?.aborted).toBe(false);
  });

  it('abort 命中在途任务，未知 id 返回 false；spawn 的异常交给 onError', async () => {
    const runner = new BatchRunner();
    const task = runner.run('rn_abort', async (signal) => {
      // task 在微任务里才启动；调用方可能在这之前就 abort，
      // 因此“启动时已经 aborted”也必须按取消处理。
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return 'aborted';
    });
    expect(runner.abort('rn_abort')).toBe(true);
    expect(await task).toBe('aborted');
    expect(runner.abort('rn_missing')).toBe(false);

    const errors: unknown[] = [];
    runner.spawn(
      'rn_fail',
      async () => {
        throw new Error('background failure');
      },
      (error) => errors.push(error),
    );
    await runner.waitForIdle();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('background failure');
  });
});
