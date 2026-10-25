import { useEffect, useState } from 'react';

/**
 * 输入防抖：搜索框每敲一个字就发请求会打满速率限制，
 * 300ms 静默后才把值同步给查询依赖，是筛选栏的默认节奏。
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
