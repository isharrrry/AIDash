/**
 * 加载 / 错误 / 空态的统一表达，避免每个页面各写一套“正在加载”。
 */
import type { ReactElement, ReactNode } from 'react';

export function Loading({ label = '加载中…' }: { label?: string }): ReactElement {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBox({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): ReactElement {
  return (
    <div className="error-box" role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {hint ? <p className="muted">{hint}</p> : null}
      {children}
    </div>
  );
}
