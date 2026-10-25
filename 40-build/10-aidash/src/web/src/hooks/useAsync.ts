/**
 * 统一异步加载状态：data / loading / error / reload。
 *
 * 关键点：loader 每次渲染都是新函数，不能直接放进依赖数组，否则会无限重载；
 * 用 ref 保存最新 loader，依赖数组由调用方显式声明（筛选条件、刷新计数等）。
 *
 * 这里不用“nonce 递增触发 effect”来做 reload：那样 reload 只能返回 void，
 * 轮询无法知道上一次请求何时结束。现在 reload 直接发起请求并返回 Promise，
 * 轮询可以等它结束再排下一轮；同时每次请求带序号，只有最新一次能写状态，
 * 避免旧请求迟到覆盖新筛选结果。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../api/client';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** 发起一次刷新；返回的 Promise 在本次请求结束后 resolve（错误已收敛到 error）。 */
  reload: () => Promise<void>;
}

export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // 卸载或 StrictMode 重挂载时让所有在途响应失效。
      mountedRef.current = false;
      requestSeqRef.current += 1;
    };
  }, []);

  const load = useCallback((): Promise<void> => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    return (async () => {
      try {
        const result = await loaderRef.current();
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        setData(result);
        setLoading(false);
      } catch (cause) {
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        // 保留上一次成功数据：刷新失败时页面不至于整屏空白。
        setLoading(false);
        setError(describeError(cause));
      }
    })();
  }, []);

  useEffect(() => {
    if (!enabled) {
      // 禁用时也让在途请求失效，否则它回来仍会改 loading/error。
      requestSeqRef.current += 1;
      setLoading(false);
      setError(null);
      return undefined;
    }
    void load();
    return () => {
      // 依赖变化时作废旧请求，避免旧筛选结果覆盖新筛选结果。
      requestSeqRef.current += 1;
    };
    // deps 由调用方保证长度稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  const reload = useCallback((): Promise<void> => {
    if (!enabled) return Promise.resolve();
    return load();
  }, [enabled, load]);

  return { data, loading, error, reload };
}
