import { useState } from 'react';
import { api } from '../api';
import type { Service } from '../types';
import { ConfigPanel } from './ConfigPanel';
import { ErrorsPanel } from './ErrorsPanel';
import { LogsPanel } from './LogsPanel';
import { Badge, ConfirmDialog, Field, StateBadge, Tabs, formatDuration, shortTime } from './ui';

export type DetailTab = 'overview' | 'config' | 'logs' | 'errors';

interface Props {
  service: Service;
  tab: DetailTab;
  busy?: string | null;
  onTab: (tab: DetailTab) => void;
  onBack: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onChanged: () => void | Promise<void>;
  onDeleted: () => void;
  toast: (text: string, tone?: 'success' | 'error' | 'info') => void;
}

export function ServiceDetail({
  service,
  tab,
  busy,
  onTab,
  onBack,
  onStart,
  onStop,
  onRestart,
  onChanged,
  onDeleted,
  toast,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const runtime = service.runtime;
  const tokenSource = service.type === 'aidash' ? service.aidash?.tokenSource : service.runner?.tokenSource;
  const serviceHasToken = service.type === 'aidash' ? service.aidash?.hasToken : service.runner?.hasToken;
  const state = runtime?.state ?? 'stopped';
  const canStop = ['running', 'starting', 'unresponsive'].includes(state);
  const canStart = ['stopped', 'error'].includes(state);

  async function removeService() {
    setDeleting(true);
    try {
      await api.deleteService(service.id, true);
      toast(`已删除服务 ${service.name}`);
      onDeleted();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="detail">
      <div className="detail-top">
        <button type="button" className="btn ghost sm" onClick={onBack}>
          ← 返回服务列表
        </button>
        <div className="detail-title">
          <div className={`type-mark type-${service.type}`}>{service.type === 'aidash' ? 'A' : 'R'}</div>
          <div>
            <div className="row gap-s wrap">
              <h1>{service.name}</h1>
              <StateBadge state={state} />
              <Badge tone="neutral">{service.type === 'aidash' ? 'AIDash 服务端' : 'Runner'}</Badge>
            </div>
            <p className="muted small">
              {runtime?.detail ?? '未运行'}
              {runtime?.pid ? ` · PID ${runtime.pid}` : ''}
              {runtime?.uptime_ms ? ` · 已运行 ${formatDuration(runtime.uptime_ms)}` : ''}
            </p>
          </div>
        </div>
        <div className="detail-actions row gap wrap">
          {canStart ? (
            <button type="button" className="btn primary" onClick={onStart} disabled={Boolean(busy)}>
              {busy === 'start' ? '启动中…' : '启动'}
            </button>
          ) : null}
          {canStop ? (
            <button type="button" className="btn ghost" onClick={onStop} disabled={Boolean(busy)}>
              {busy === 'stop' ? '停止中…' : '停止'}
            </button>
          ) : null}
          {state === 'running' || state === 'unresponsive' ? (
            <button type="button" className="btn ghost" onClick={onRestart} disabled={Boolean(busy)}>
              {busy === 'restart' ? '重启中…' : '重启'}
            </button>
          ) : null}
          {service.web_url ? (
            <a className="btn ghost" href={service.web_url} target="_blank" rel="noreferrer">
              {service.type === 'runner' ? '打开 AIDash' : '打开网页'}
            </a>
          ) : null}
        </div>
      </div>

      <Tabs<DetailTab>
        tabs={[
          { key: 'overview', label: '概览' },
          { key: 'config', label: '配置' },
          { key: 'logs', label: '日志' },
          { key: 'errors', label: '异常摘要' },
        ]}
        active={tab}
        onChange={onTab}
      />

      {runtime?.config_error ? <div className="alert alert-warn">配置问题：{runtime.config_error}</div> : null}
      {runtime?.last_error ? <div className="alert alert-danger">最近错误：{runtime.last_error}</div> : null}

      {tab === 'overview' ? (
        <div className="overview">
          <div className="info-grid">
            <Info label="类型" value={service.type === 'aidash' ? 'AIDash 服务端' : 'Runner 值守壳'} />
            <Info label="服务 ID" value={service.id} mono />
            <Info label="状态" value={runtime?.detail ?? '-'} />
            <Info label="网页地址" value={service.web_url ?? '-'} link={service.web_url} mono />
            <Info label="工作目录" value={service.cwd} mono />
            <Info label="配置文件" value={runtime?.config_path ?? (service.type === 'aidash' ? service.aidash?.configPath : service.runner?.configPath) ?? '-'} mono />
            <Info label="日志文件" value={runtime?.log_file ?? '-'} mono />
            <Info label="PID" value={runtime?.pid ? String(runtime.pid) : '-'} />
            <Info label="启动时间" value={runtime?.started_at ? shortTime(runtime.started_at) : '-'} />
            <Info label="运行时长" value={runtime?.uptime_ms ? formatDuration(runtime.uptime_ms) : '-'} />
            <Info label="令牌" value={(service.type === 'aidash' ? service.aidash?.hasToken : service.runner?.hasToken) ? '已配置' : '未配置 / 来自环境变量'} />
            {service.type === 'aidash' ? (
              <>
                <Info label="监听" value={service.aidash ? `${service.aidash.host}:${service.aidash.port}` : '-'} />
                <Info label="配置模式" value={service.aidash?.configMode === 'file' ? '配置文件模式' : '环境变量模式'} />
                <Info label="数据库" value={service.aidash?.dbPath ?? '-'} mono />
                <Info label="静态目录" value={service.aidash?.staticDir ?? '-'} mono />
              </>
            ) : (
              <>
                <Info label="harness_id" value={service.runner?.harnessId ?? '-'} mono />
                <Info label="实例 id" value={runtime?.instance_id ?? service.runner?.harnessId ?? '-'} mono />
                <Info label="AIDash 地址" value={service.runner?.aidashUrl ?? '-'} mono />
                <Info label="通道过滤" value={service.runner?.channels?.length ? service.runner.channels.join(', ') : '全部'} mono />
                <Info label="创建/复用通道" value={service.runner?.ensureChannel || '-'} mono />
                <Info label="任务工作目录" value={service.runner?.runCwd ?? '-'} mono />
                <Info label="数据目录" value={service.runner?.dataDir ?? '-'} mono />
                <Info label="当前任务" value={runtime?.current_task?.title ?? runtime?.current_task?.id ?? '-'} />
                <Info label="最近拉取" value={runtime?.last_poll_at ? shortTime(runtime.last_poll_at) : '-'} />
                <Info label="轮询次数" value={runtime?.stats?.polls !== undefined ? String(runtime.stats.polls) : '-'} />
                <Info label="已认领 / 已完成" value={runtime?.stats ? `${runtime.stats.claimed ?? 0} / ${runtime.stats.completed ?? 0}` : '-'} />
                <Info label="忙" value={runtime?.busy ? '是' : '否'} />
              </>
            )}
          </div>

          <section className="form-section">
            <h3>访问令牌</h3>
            {tokenSource === 'env' ? (
              <p className="small muted">
                该服务从管理台进程的环境变量读取令牌；请确保启动管理台的终端里存在对应变量。要改为管理台保存，
                可以在服务配置页重新创建或修改服务定义。
              </p>
            ) : (
              <>
                <p className="small muted">令牌只保存在本机 <code>~/.aidash/manager/secrets.json</code>（0600），接口不会回显。</p>
                <div className="form-grid two">
                  <Field label="新的 AIDASH_TOKEN" hint={serviceHasToken ? '已配置；留空不会修改' : '尚未配置'}>
                    <input
                      type="password"
                      value={tokenInput}
                      onChange={(event) => setTokenInput(event.target.value)}
                      placeholder="输入新令牌…"
                      autoComplete="new-password"
                    />
                  </Field>
                  <div className="row end gap">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={tokenBusy || !tokenInput.trim()}
                      onClick={async () => {
                        setTokenBusy(true);
                        try {
                          await api.setToken(service.id, tokenInput.trim());
                          setTokenInput('');
                          toast('令牌已更新；重启服务后生效');
                          onChanged();
                        } catch (err) {
                          toast(err instanceof Error ? err.message : String(err), 'error');
                        } finally {
                          setTokenBusy(false);
                        }
                      }}
                    >
                      {tokenBusy ? '保存中…' : '保存令牌'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>

          {service.type === 'aidash' && runtime?.health ? (
            <details className="advanced">
              <summary>健康检查响应</summary>
              <pre className="json-block">{JSON.stringify(runtime.health, null, 2)}</pre>
            </details>
          ) : null}
          {runtime?.last_exit ? (
            <details className="advanced">
              <summary>最近一次进程退出</summary>
              <pre className="json-block">{JSON.stringify(runtime.last_exit, null, 2)}</pre>
            </details>
          ) : null}

          <section className="danger-zone">
            <div>
              <h3>删除服务</h3>
              <p className="small muted">只从管理台移除记录，不会删除配置文件、数据库或日志；运行中的服务会先被停止。</p>
            </div>
            <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
              删除服务
            </button>
          </section>
        </div>
      ) : null}

      {tab === 'config' ? <ConfigPanel service={service} onChanged={onChanged} toast={toast} /> : null}
      {tab === 'logs' ? <LogsPanel service={service} /> : null}
      {tab === 'errors' ? <ErrorsPanel service={service} onOpenLogs={() => onTab('logs')} /> : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={`删除 ${service.name}？`}
          message={
            <div>
              <p>将从管理台移除这个服务记录，并停止它（如果正在运行）。</p>
              <p className="muted small">配置文件、数据库、备份与日志不会被删除。</p>
            </div>
          }
          confirmText="删除"
          danger
          busy={deleting}
          onConfirm={() => void removeService()}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </div>
  );
}

function Info({ label, value, mono, link }: { label: string; value: string; mono?: boolean; link?: string | null }) {
  return (
    <div className="info-item">
      <span className="info-label">{label}</span>
      {link ? (
        <a className={`info-value ${mono ? 'mono' : ''}`} href={link} target="_blank" rel="noreferrer">
          {value}
        </a>
      ) : (
        <span className={`info-value ${mono ? 'mono' : ''}`} title={value}>
          {value}
        </span>
      )}
    </div>
  );
}
