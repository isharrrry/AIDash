/**
 * 可关闭的全局提示条。
 *
 * 错误必须让用户看见并能手动关掉；自动消失只是辅助（成功 5 秒、错误 9 秒）。
 * 这里不用 alert：alert 会阻塞渲染线程，轮询与用户输入都会被卡住。
 */
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  notify: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast 必须在 ToastProvider 内使用');
  return value;
}

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback(
    (kind: ToastKind, message: string) => {
      counter.current += 1;
      const id = counter.current;
      setItems((prev) => [...prev, { id, kind, message }]);
      window.setTimeout(() => remove(id), kind === 'error' ? 9000 : 5000);
    },
    [remove],
  );

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.kind}`} role="status">
            <span className="toast-message">{item.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="关闭提示"
              onClick={() => remove(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
