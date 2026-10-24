import { useEffect, useRef } from 'react';

/**
 * 轮询兜底（设计文档 §2.7：SSE 不可用时退化为 30 秒轮询）。
 *
 * 只在页面可见时请求，避免用户切到后台后继续消耗令牌与服务端配额；
 * 回调放进 ref，定时器本身不因每次渲染重建，减少抖动。
 * 组件卸载或 enabled 变 false 时清理定时器，防止内存泄漏。
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
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void callbackRef.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);
}
