import { useEffect, useRef } from 'react';
import { startPolling } from '../lib/polling';

/**
 * 轮询兜底（设计文档 §2.7：SSE 不可用时退化为 30 秒轮询）。
 *
 * 调度逻辑放在 lib/polling.ts 的纯函数里：上一次请求没结束时跳过本轮，
 * 停止后不再发新请求，页面不可见时只跳过当前轮。这里只负责把最新回调和
 * 生命周期接上去；回调放进 ref，避免每次渲染都重建计时器。
 */
export function usePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return undefined;
    const polling = startPolling({
      intervalMs,
      isVisible: () => document.visibilityState === 'visible',
      run: () => callbackRef.current(),
    });
    return () => polling.stop();
  }, [enabled, intervalMs]);
}
