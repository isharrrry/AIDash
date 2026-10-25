import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { AuditQuery } from '../api/endpoints';
import { listAudit } from '../api/endpoints';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import {
  formatAbsolute,
  fromLocalInput,
  localInputDaysAgo,
  shortId,
} from '../lib/format';
import { EmptyState, ErrorBox, Loading } from './Feedback';
import { Pagination } from './Pagination';

const INITIAL_SINCE = localInputDaysAgo(7);

/**
 * SCR-05 审计表：只读查询。
 * 筛选显式提交而不是边输边查：审计查询要扫哈希链，频繁请求没有收益。
 */
export function AuditTable(): ReactElement {
  const { refreshNonce } = useApp();
  const [action, setAction] = useState('');
  const [objectType, setObjectType] = useState('');
  const [objectId, setObjectId] = useState('');
  const [result, setResult] = useState('');
  const [since, setSince] = useState(INITIAL_SINCE);
  const [until, setUntil] = useState('');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState<AuditQuery>(() => ({
    since: fromLocalInput(INITIAL_SINCE) ?? undefined,
  }));

  const audit = useAsync(() => listAudit({ ...query, page }), [query, page, refreshNonce]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setPage(1);
    setQuery({
      action: action.trim() || undefined,
      object_type: objectType.trim() || undefined,
      object_id: objectId.trim() || undefined,
      result: result || undefined,
      since: fromLocalInput(since) ?? undefined,
      until: fromLocalInput(until) ?? undefined,
    });
  };

  return (
    <section className="panel" aria-label="审计日志">
      <header className="panel-header">
        <h2>审计日志</h2>
        <span className="muted small">只读 · 哈希链</span>
      </header>

      <form className="filter-row wrap" onSubmit={submit}>
        <label className="field">
          <span>开始时间</span>
          <input
            type="datetime-local"
            value={since}
            onChange={(event) => setSince(event.target.value)}
          />
        </label>
        <label className="field">
          <span>结束时间</span>
          <input
            type="datetime-local"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </label>
        <label className="field">
          <span>动作</span>
          <input
            value={action}
            placeholder="例如 card.answer"
            onChange={(event) => setAction(event.target.value)}
          />
        </label>
        <label className="field">
          <span>对象类型</span>
          <input
            value={objectType}
            placeholder="card / task / channel"
            onChange={(event) => setObjectType(event.target.value)}
          />
        </label>
        <label className="field">
          <span>对象 ID</span>
          <input
            value={objectId}
            placeholder="cd_ / tk_"
            onChange={(event) => setObjectId(event.target.value)}
          />
        </label>
        <label className="field">
          <span>结果</span>
          <select value={result} onChange={(event) => setResult(event.target.value)}>
            <option value="">全部</option>
            <option value="ok">ok</option>
            <option value="denied">denied</option>
            <option value="error">error</option>
          </select>
        </label>
        <div className="inline">
          <button type="submit" className="btn btn-primary btn-small">
            查询
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => {
              setAction('');
              setObjectType('');
              setObjectId('');
              setResult('');
              setSince(INITIAL_SINCE);
              setUntil('');
              setPage(1);
              setQuery({ since: fromLocalInput(INITIAL_SINCE) ?? undefined });
            }}
          >
            重置
          </button>
        </div>
      </form>

      {audit.loading && !audit.data ? <Loading label="查询审计日志…" /> : null}
      {audit.error ? <ErrorBox message={audit.error} onRetry={audit.reload} /> : null}

      {audit.data ? (
        audit.data.items.length === 0 ? (
          <EmptyState title="没有匹配的审计记录" hint="放宽时间范围或清空对象筛选。" />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>动作</th>
                  <th>对象</th>
                  <th>结果</th>
                  <th>请求</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.items.map((row) => (
                  <tr key={row.id} className={row.result === 'ok' ? '' : `audit-${row.result}`}>
                    <td title={String(row.ts)}>{formatAbsolute(row.ts)}</td>
                    <td>{row.actor_label ?? '—'}</td>
                    <td>
                      <code>{row.action}</code>
                    </td>
                    <td>
                      {row.object_type ?? '—'}
                      {row.object_id ? (
                        <span className="muted small" title={row.object_id}>
                          {' '}
                          {shortId(row.object_id)}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className={`badge audit-result-${row.result}`}>{row.result}</span>
                    </td>
                    <td>
                      <span className="muted small" title={row.request_id ?? undefined}>
                        {row.request_id ? shortId(row.request_id) : '—'}
                      </span>
                    </td>
                    <td>
                      {row.detail_json ? (
                        <details>
                          <summary>展开</summary>
                          <pre className="detail-json">{row.detail_json}</pre>
                        </details>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {audit.data ? (
        <Pagination
          page={audit.data.page}
          pageSize={audit.data.page_size}
          total={audit.data.total}
          hasMore={audit.data.has_more}
          onChange={setPage}
        />
      ) : null}
    </section>
  );
}
