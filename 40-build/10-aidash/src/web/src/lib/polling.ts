/**
 * 串行轮询调度器（与 React 解耦，便于直接单测）。
 *
 * 为什么不用 setInterval：setInterval 只保证“到点触发”，不关心上一次是否完成。
 * 网络慢或断网时，30 秒一到又会发一批请求，in-flight 越叠越多；
 * 服务恢复后这些迟到响应还会互相覆盖。
 *
 * 这里的规则：
 * 1. 上一次 run 返回的 Promise 未结束时，下一次到点直接跳过；
 * 2. 下一次计时从“这次结束”之后开始，不再按固定节拍硬塞；
 * 3. stop() 之后不再调度，即使结束回调此刻才执行；
 * 4. 页面不可见时只跳过本轮，但继续保留调度，回到前台后自动恢复。
 */

export interface PollingOptions {
  intervalMs: number;
  /** 每次真正发请求前再判断可见性，避免切后台后继续消耗配额。 */
  isVisible: () => boolean;
  run: () => void | Promise<void>;
}

export interface PollingHandle {
  stop: () => void;
}

export function startPolling(options: PollingOptions): PollingHandle {
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, options.intervalMs);
  };

  const tick = async (): Promise<void> => {
    timer = undefined;
    if (stopped) return;

    if (!inFlight && options.isVisible()) {
      inFlight = true;
      try {
        await options.run();
      } catch {
        // 轮询是后台辅助动作；错误已经由 useAsync/API 层展示，不能再抛成未处理拒绝。
      } finally {
        inFlight = false;
      }
    }
    schedule();
  };

  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
