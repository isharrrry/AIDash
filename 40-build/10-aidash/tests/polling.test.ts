import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPolling } from '../src/web/src/lib/polling.js';

/**
 * 轮询调度器的纯函数测试。
 *
 * 用 fake timers 精确控制节拍，不需要浏览器/React 环境：
 * 重点验证“上一次没回来就不发下一次”和“stop 后不再调度”，
 * 这两条正是断网时 in-flight 叠加的根因。
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startPolling', () => {
  it('上一次请求未返回时跳过本轮；停止后不再发新请求', async () => {
    // Arrange：run 返回由测试手动放行的 Promise。
    vi.useFakeTimers();
    const resolvers: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const polling = startPolling({ intervalMs: 1000, isVisible: () => true, run });

    // Act：第一拍启动后，连续推进 5 秒也不能叠加第二拍。
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);

    // 放行第一拍，下一拍才允许开始。
    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);

    // 停止时第二拍仍在途；放行后也不能再调度下一拍。
    polling.stop();
    resolvers[1]!();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('页面不可见时跳过本轮，但保留调度，恢复可见后继续', async () => {
    // Arrange
    vi.useFakeTimers();
    let visible = false;
    const run = vi.fn().mockResolvedValue(undefined);
    const polling = startPolling({
      intervalMs: 1000,
      isVisible: () => visible,
      run,
    });

    // Act & Assert
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();

    visible = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    polling.stop();
  });

  it('单次失败不会中断后续轮询，也不会产生未处理拒绝', async () => {
    // Arrange
    vi.useFakeTimers();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(undefined);
    const polling = startPolling({ intervalMs: 1000, isVisible: () => true, run });

    // Act
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);

    // Assert
    expect(run).toHaveBeenCalledTimes(2);
    polling.stop();
  });
});
