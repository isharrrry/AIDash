import type { Service } from '../types';
import { Badge, StateBadge, formatDuration } from './ui';

interface Props {
  service: Service;
  busy?: string | null;
  onOpen: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onLogs: () => void;
}

export function ServiceCard({ service, busy, onOpen, onStart, onStop, onRestart, onLogs }: Props) {
  const runtime = service.runtime;
  const state = runtime?.state ?? 'stopped';
  const canStop = ['running', 'starting', 'unresponsive'].includes(state);
  const canStart = ['stopped', 'error'].includes(state);
  const isBusy = Boolean(busy);
  return (
    <article className={`service-card state-${state}`}>
      <div className="service-card-head">
        <div className={`type-mark type-${service.type}`} aria-hidden="true">
          {service.type === 'aidash' ? 'A' : 'R'}
        </div>
        <div className="service-card-title">
          <h3>{service.name}</h3>
          <div className="muted small">
            {service.type === 'aidash' ? 'AIDash 服务端' : `Runner · ${service.runner?.template ?? 'custom'}`}
          </div>
        </div>
        <StateBadge state={state} />
      </div>

      <div className="service-card-meta">
        <div className="meta-row">
          <span className="meta-key">地址</span>
          <span className="meta-value mono truncate" title={service.web_url ?? '-'}>
            {service.web_url ?? '-'}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-key">{service.type === 'runner' ? '实例' : '端口'}</span>
          <span className="meta-value">
            {service.type === 'runner' ? service.runner?.harnessId ?? '-' : service.aidash ? `${service.aidash.host}:${service.aidash.port}` : '-'}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-key">PID / 运行时长</span>
          <span className="meta-value">
            {runtime?.pid ?? '-'} · {runtime?.uptime_ms ? formatDuration(runtime.uptime_ms) : '-'}
          </span>
        </div>
      </div>

      <div className="service-card-detail">
        <span className={`dot dot-${state}`} />
        <span className="truncate" title={runtime?.detail ?? ''}>
          {runtime?.detail ?? '未运行'}
        </span>
      </div>
      {runtime?.last_error || runtime?.config_error ? (
        <div className="service-card-error" title={runtime?.last_error ?? runtime?.config_error ?? ''}>
          {runtime?.config_error ?? runtime?.last_error}
        </div>
      ) : null}
      {runtime?.current_task ? (
        <div className="service-card-task">
          <Badge tone="accent">当前任务</Badge>
          <span className="truncate">{runtime.current_task.title ?? runtime.current_task.id ?? '-'}</span>
        </div>
      ) : null}

      <div className="service-card-actions">
        {canStart ? (
          <button type="button" className="btn primary sm" onClick={onStart} disabled={isBusy}>
            {busy === 'start' ? '启动中…' : '启动'}
          </button>
        ) : null}
        {canStop ? (
          <button type="button" className="btn ghost sm" onClick={onStop} disabled={isBusy}>
            {busy === 'stop' ? '停止中…' : '停止'}
          </button>
        ) : null}
        {state === 'running' || state === 'unresponsive' ? (
          <button type="button" className="btn ghost sm" onClick={onRestart} disabled={isBusy}>
            {busy === 'restart' ? '重启中…' : '重启'}
          </button>
        ) : null}
        <button type="button" className="btn ghost sm" onClick={onLogs} disabled={isBusy}>
          日志
        </button>
        {service.web_url ? (
          <a className="btn ghost sm" href={service.web_url} target="_blank" rel="noreferrer">
            打开
          </a>
        ) : null}
        <button type="button" className="btn subtle sm grow" onClick={onOpen} disabled={isBusy}>
          管理
        </button>
      </div>
    </article>
  );
}
