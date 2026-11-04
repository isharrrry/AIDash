import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { LogResult, Service } from '../types';
import { Badge, Spinner, formatBytes } from './ui';

const ERROR_LINE = /(?:^|[\s[\]])(ERROR|FATAL|CRITICAL|EXCEPTION|UNCAUGHT|UNHANDLED)(?:[\s[\]:]|$)|Traceback|ECONNREFUSED|EADDRINUSE|ENOENT|EACCES|ETIMEDOUT/i;
const WARN_LINE = /(?:^|[\s[\]])(WARN|WARNING)(?:[\s[\]:]|$)/i;

export function LogsPanel({ service }: { service: Service }) {
  const [source, setSource] = useState('auto');
  const [lines, setLines] = useState('300');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [result, setResult] = useState<LogResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const preRef = useRef<HTMLDivElement | null>(null);
  const stickBottom = useRef(true);

  async function load(showSpinner = false) {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const data = await api.logs(service.id, source, Number(lines) || 300);
      setResult(data);
      if (stickBottom.current && autoRefresh) {
        requestAnimationFrame(() => {
          const element = preRef.current;
          if (element) element.scrollTop = element.scrollHeight;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.id, source, lines]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void load(false), 2_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, service.id, source, lines]);

  const visibleLines = useMemo(() => {
    const list = result?.lines ?? [];
    // 保留日志文件中的原始行号，过滤后仍然能对得上真实位置。
    return list
      .map((text, index) => ({ no: index + 1, text }))
      .filter(({ text }) => {
        if (onlyErrors && !ERROR_LINE.test(text) && !WARN_LINE.test(text)) return false;
        if (filter.trim() && !text.toLowerCase().includes(filter.trim().toLowerCase())) return false;
        return true;
      });
  }, [result, filter, onlyErrors]);

  function download() {
    const blob = new Blob([(result?.lines ?? []).join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${service.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const fileOptions = [{ key: 'auto', label: '自动选择' }, ...(result?.files ?? service.log_files ?? [])];

  return (
    <div className="logs-panel">
      <div className="toolbar wrap">
        <label className="inline-field">
          <span>日志来源</span>
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            {fileOptions.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          <span>行数</span>
          <select value={lines} onChange={(event) => setLines(event.target.value)}>
            {['100', '300', '500', '1000', '2000'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="checkline compact">
          <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
          自动刷新（2 秒）
        </label>
        <label className="checkline compact">
          <input type="checkbox" checked={onlyErrors} onChange={(event) => setOnlyErrors(event.target.checked)} />
          只看异常/警告
        </label>
        <input className="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="过滤文本…" />
        <button type="button" className="btn ghost sm" onClick={() => void load(true)}>
          刷新
        </button>
        <button type="button" className="btn ghost sm" onClick={download} disabled={!result?.lines.length}>
          下载
        </button>
      </div>

      <div className="log-meta">
        <span className="mono small truncate" title={result?.path}>
          {result?.path ?? '-'}
        </span>
        <span className="row gap-s">
          {result ? <Badge tone={result.exists ? 'success' : 'warn'}>{result.exists ? formatBytes(result.size) : '文件不存在'}</Badge> : null}
          {result?.truncated ? <Badge tone="warn">仅显示尾部 {lines} 行</Badge> : null}
          {visibleLines.length !== (result?.lines.length ?? 0) ? <Badge tone="accent">{visibleLines.length} / {result?.lines.length ?? 0} 行</Badge> : null}
        </span>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}
      {loading && !result ? <Spinner label="读取日志…" /> : null}
      {!result?.exists && !loading ? (
        <div className="empty small-empty">
          <h3>还没有日志</h3>
          <p className="muted">启动服务后，管理台会把 stdout / stderr 写到这里；runner 同时写自己的日志文件。</p>
        </div>
      ) : (
        <div
          className="log-view"
          ref={preRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            stickBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
        >
          {visibleLines.map(({ no, text }) => {
            const tone = ERROR_LINE.test(text) ? 'log-error' : WARN_LINE.test(text) ? 'log-warn' : '';
            return (
              <div className={`log-line ${tone}`} key={`${no}-${text.slice(0, 40)}`}>
                <span className="log-no">{no}</span>
                <span>{text || ' '}</span>
              </div>
            );
          })}
          {visibleLines.length === 0 && result?.lines.length ? <div className="muted small pad">没有命中过滤条件的日志行。</div> : null}
          {visibleLines.length === 0 && result?.exists && result.lines.length === 0 ? (
            <div className="muted small pad">日志文件存在但内容为空；服务产生输出后会自动出现。</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
