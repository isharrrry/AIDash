import type { ReactElement } from 'react';

export function Pagination({
  page,
  pageSize,
  total,
  hasMore,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  hasMore?: boolean;
  onChange: (page: number) => void;
}): ReactElement {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(pageSize, 1)));
  const canPrev = page > 1;
  const canNext = hasMore ?? page < totalPages;

  return (
    <div className="pagination">
      <span className="muted">
        第 {page} / {totalPages} 页 · 共 {total} 条
      </span>
      <div className="inline">
        <button
          type="button"
          className="btn btn-small"
          disabled={!canPrev}
          onClick={() => onChange(page - 1)}
        >
          上一页
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!canNext}
          onClick={() => onChange(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
