import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ErrorSummary, Service } from '../types';
import { Badge, Spinner } from './ui';

export function ErrorsPanel({ service, onOpenLogs }: { service: Service; onOpenLogs: () => void }) {
  const [summary, setSummary] = useState<ErrorSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [severity, setSeverity] = useState<'all' | 'error' | 'warn'>('all');

  async function load(showSpinner = true) {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const data = await api.errors(service.id);
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(false), 5_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.id]);

  const groups = (summary?.groups ?? []).filter((group) => severity === 'all' || group.severity === severity);

  return (
    <div className="errors-panel">
      <div className="stat-row">
        <div className="stat-card stat-danger">
          <span className="stat-label">异常</span>
          <strong>{summary?.error_count ?? 0}</strong>
          <span className="small muted">{summary?.error_count ? '最近日志中发现的错误' : '最近日志中未发现错误'}</span>
        </div>
        <div className="stat-card stat-warn">
          <span className="stat-label">警告</span>
          <strong>{summary?.warn_count ?? 0}</strong>
          <span className="small muted">需要留意的降级/重试</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">分组</span>
          <strong>{summary?.groups.length ?? 0}</strong>
          <span className="small muted">按错误签名归并</span>
        </div>
        <div className="stat-card stat-neutral">
          <span className="stat-label">日志文件</span>
          <strong>{summary?.files.filter((file) => file.exists).length ?? 0}</strong>
          <span className="small muted">有内容即可摘要</span>
        </div>
      </div>

      <div className="toolbar wrap">
        <div className="segmented">
          {(['all', 'error', 'warn'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`seg ${severity === key ? 'active' : ''}`}
              onClick={() => setSeverity(key)}
            >
              {key === 'all' ? '全部' : key === 'error' ? '异常' : '警告'}
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost sm" onClick={() => void load()}>
          刷新
        </button>
        <button type="button" className="btn ghost sm" onClick={onOpenLogs}>
          查看原始日志
        </button>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}
      {loading && !summary ? <Spinner label="分析日志…" /> : null}
      {summary && !summary.exists ? (
        <div className="empty small-empty">
          <h3>没有可分析的日志</h3>
          <p className="muted">服务启动并产生输出后，这里会按错误签名汇总最近 2000 行。</p>
        </div>
      ) : null}
      {summary?.exists && groups.length === 0 ? (
        <div className="empty small-empty">
          <h3>最近日志里没有发现异常</h3>
          <p className="muted">如果服务异常但这里为空，可能是日志级别过高或输出格式未知；可以到原始日志里搜索。</p>
        </div>
      ) : null}

      {groups.length > 0 ? (
        <div className="error-groups">
          {groups.map((group) => (
            <details className={`error-group severity-${group.severity}`} key={group.signature}>
              <summary>
                <Badge tone={group.severity === 'error' ? 'danger' : 'warn'}>{group.severity === 'error' ? '异常' : '警告'}</Badge>
                <span className="error-signature" title={group.signature}>{group.signature || '(空签名)'}</span>
                <span className="muted small">×{group.count} · 行 {group.first_line}–{group.last_line}</span>
              </summary>
              <div className="error-samples">
                {group.samples.map((sample) => (
                  <div className="error-sample" key={`${sample.line}-${sample.text.slice(0, 20)}`}>
                    <span className="log-no">{sample.line}</span>
                    <pre>{sample.text}</pre>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      ) : null}

      {summary?.files?.some((file) => !file.exists) ? (
        <p className="small muted">
          尚未生成日志：{summary.files.filter((file) => !file.exists).map((file) => file.path).join('、')}
          （服务启动并产生输出后会出现在这里）
        </p>
      ) : null}
    </div>
  );
}
