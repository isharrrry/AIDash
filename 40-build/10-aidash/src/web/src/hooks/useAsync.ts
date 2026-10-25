/**
 * 统一异步加载状态：data / loading / error / reload。
 *
 * 关键点：loader 每次渲染都是新函数，不能直接放进依赖数组，否则会无限重载；
 * 用 ref 保存最新 loader，依赖数组由调用方显式声明（筛选条件、刷新计数等）。
 * 组件卸载或依赖变化时用 active 标记丢弃迟到响应，避免 setState 到已卸载组件。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../api/client';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError(null);

    loaderRef
      .current()
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        // 保留上一次成功数据：刷新失败时页面不至于整屏空白。
        setLoading(false);
        setError(describeError(cause));
      });

    return () => {
      active = false;
    };
    // deps 由调用方保证长度稳定；nonce 用于手动重试。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, loading, error, reload };
}
