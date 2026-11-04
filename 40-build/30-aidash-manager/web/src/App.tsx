import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, Unauthorized, getStoredToken, setStoredToken } from './api';
import { CreateWizard } from './components/CreateWizard';
import { ServiceCard } from './components/ServiceCard';
import { ServiceDetail, type DetailTab } from './components/ServiceDetail';
import { Badge, Empty, Modal, Spinner, Toast, formatDuration, type ToastMessage } from './components/ui';
import type { ManagerState, Service } from './types';

type Route = { view: 'home' } | { view: 'service'; id: string; tab: DetailTab };

/** 服务状态自动刷新间隔；日志页与异常摘要另有更短的节奏。 */
const AUTO_REFRESH_MS = 4_000;

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#/, '');
  const match = /^\/service\/([^?/]+)(?:\?(.*))?$/.exec(hash);
  if (!match) return { view: 'home' };
  const params = new URLSearchParams(match[2] ?? '');
  const tabValue = params.get('tab');
  const tab: DetailTab = tabValue === 'config' || tabValue === 'logs' || tabValue === 'errors' ? tabValue : 'overview';
  return { view: 'service', id: decodeURIComponent(match[1]), tab };
}

function navigate(route: Route) {
  if (route.view === 'home') window.location.hash = '';
  else window.location.hash = `/service/${encodeURIComponent(route.id)}${route.tab !== 'overview' ? `?tab=${route.tab}` : ''}`;
}

export default function App() {
  const [state, setState] = useState<ManagerState | null>(null);
  const [route, setRoute] = useState<Route>(() => readRoute());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<{ id: string; action: string } | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const refreshing = useRef(false);

  const notify = useCallback((text: string, tone: ToastMessage['tone'] = 'success') => {
    setToast({ text, tone });
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    if (!silent) setLoading(true);
    try {
      const data = await api.state();
      setState(data);
      setError(null);
      setAuthRequired(false);
    } catch (err) {
      if (err instanceof Unauthorized) {
        setAuthRequired(true);
      } else if (!silent) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      refreshing.current = false;
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const selected = useMemo(() => {
    if (route.view !== 'service' || !state) return null;
    return state.services.find((item) => item.id === route.id) ?? null;
  }, [route, state]);

  useEffect(() => {
    if (route.view === 'service' && state && !selected) {
      navigate({ view: 'home' });
    }
  }, [route, state, selected]);

  const filtered = useMemo(() => {
    if (!state) return [];
    const query = search.trim().toLowerCase();
    if (!query) return state.services;
    return state.services.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.cwd.toLowerCase().includes(query) ||
        item.type.toLowerCase().includes(query) ||
        (item.web_url ?? '').toLowerCase().includes(query),
    );
  }, [state, search]);

  const counts = useMemo(() => {
    const services = state?.services ?? [];
    return {
      total: services.length,
      running: services.filter((item) => ['running', 'external'].includes(item.runtime?.state ?? '')).length,
      stopped: services.filter((item) => item.runtime?.state === 'stopped').length,
      problems: services.filter((item) => ['error', 'unresponsive'].includes(item.runtime?.state ?? '')).length,
      runners: services.filter((item) => item.type === 'runner').length,
      aidash: services.filter((item) => item.type === 'aidash').length,
    };
  }, [state]);

  async function runAction(service: Service, action: 'start' | 'stop' | 'restart') {
    setBusy({ id: service.id, action });
    try {
      if (action === 'start') await api.start(service.id);
      else if (action === 'restart') await api.restart(service.id);
      else await api.stop(service.id, service.type === 'aidash');
      notify(
        action === 'start' ? `${service.name} 已启动` : action === 'stop' ? `${service.name} 已停止` : `${service.name} 已重启`,
      );
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  if (authRequired) {
    return <TokenGate onSubmit={() => void refresh()} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <button type="button" className="brand" onClick={() => navigate({ view: 'home' })}>
            <span className="brand-mark">A</span>
            <span>
              <strong>AIDash Manager</strong>
              <span className="brand-sub">服务与 runner 管理台</span>
            </span>
          </button>
          <div className="topbar-actions">
            {state ? (
              <span className="connection">
                <span className="dot dot-running" />
                <span className="small muted">
                  本机管理台 · 端口 {state.manager.port} · 每 {AUTO_REFRESH_MS / 1000} 秒自动刷新
                </span>
              </span>
            ) : null}
            <button type="button" className="btn ghost sm" onClick={() => void refresh()}>
              刷新
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setAboutOpen(true)}>
              本机信息
            </button>
            <button type="button" className="btn primary sm" onClick={() => setWizardOpen(true)}>
              + 新建服务
            </button>
          </div>
        </div>
      </header>

      <main className="main">
        {loading && !state ? (
          <div className="center-pad">
            <Spinner label="正在连接管理台…" />
          </div>
        ) : error && !state ? (
          <div className="center-pad">
            <div className="alert alert-danger">{error}</div>
            <button type="button" className="btn primary" onClick={() => void refresh()}>
              重试
            </button>
          </div>
        ) : !state ? null : route.view === 'service' && selected ? (
          <ServiceDetail
            service={selected}
            tab={route.tab}
            busy={busy?.id === selected.id ? busy.action : null}
            onTab={(tab) => navigate({ view: 'service', id: selected.id, tab })}
            onBack={() => navigate({ view: 'home' })}
            onStart={() => void runAction(selected, 'start')}
            onStop={() => void runAction(selected, 'stop')}
            onRestart={() => void runAction(selected, 'restart')}
            onChanged={() => refresh(true)}
            onDeleted={() => {
              navigate({ view: 'home' });
              void refresh();
            }}
            toast={notify}
          />
        ) : (
          <>
            <section className="hero">
              <div>
                <h1>服务总览</h1>
                <p className="muted">
                  管理多个 AIDash 实例与 runner；启动、停止、配置、日志和异常都在这一个页面里。
                </p>
              </div>
              <div className="stat-row compact">
                <div className="stat-card">
                  <span className="stat-label">服务</span>
                  <strong>{counts.total}</strong>
                  <span className="small muted">AIDash {counts.aidash} · Runner {counts.runners}</span>
                </div>
                <div className="stat-card stat-success">
                  <span className="stat-label">运行中</span>
                  <strong>{counts.running}</strong>
                  <span className="small muted">健康检查通过</span>
                </div>
                <div className="stat-card stat-warn">
                  <span className="stat-label">已停止</span>
                  <strong>{counts.stopped}</strong>
                </div>
                <div className="stat-card stat-danger">
                  <span className="stat-label">异常</span>
                  <strong>{counts.problems}</strong>
                  <span className="small muted">错误或无响应</span>
                </div>
              </div>
            </section>

            <section className="list-toolbar">
              <div className="row gap">
                <input
                  className="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="按名称、目录或地址过滤…"
                  aria-label="过滤服务"
                />
                {search ? (
                  <button type="button" className="btn ghost sm" onClick={() => setSearch('')}>
                    清空
                  </button>
                ) : null}
              </div>
              <span className="small muted">
                数据目录：<code>{state.manager.home}</code>
              </span>
            </section>

            {filtered.length === 0 ? (
              <Empty
                title={state.services.length === 0 ? '还没有服务' : '没有匹配的服务'}
                hint={
                  state.services.length === 0
                    ? '创建第一个 AIDash 服务或 runner。管理台会帮你写配置、拉起进程、聚合日志。'
                    : '换个关键词，或清空过滤条件。'
                }
                action={
                  state.services.length === 0 ? (
                    <button type="button" className="btn primary" onClick={() => setWizardOpen(true)}>
                      新建服务
                    </button>
                  ) : (
                    <button type="button" className="btn ghost" onClick={() => setSearch('')}>
                      清空过滤条件
                    </button>
                  )
                }
              />
            ) : (
              <div className="service-grid">
                {filtered.map((service) => (
                  <ServiceCard
                    key={service.id}
                    service={service}
                    busy={busy?.id === service.id ? busy.action : null}
                    onOpen={() => navigate({ view: 'service', id: service.id, tab: 'overview' })}
                    onStart={() => void runAction(service, 'start')}
                    onStop={() => void runAction(service, 'stop')}
                    onRestart={() => void runAction(service, 'restart')}
                    onLogs={() => navigate({ view: 'service', id: service.id, tab: 'logs' })}
                  />
                ))}
              </div>
            )}

            <section className="hint-strip">
              <Badge tone="accent">下一步</Badge>
              <span className="small muted">
                创建 AIDash 后先把它的 Web 打开确认能访问；再创建 runner，选择 harness 模板并把 AIDash 地址指向它。
                做 AIDash 级联时，用同一套方式再加几个实例即可。
              </span>
            </section>
          </>
        )}
      </main>

      {wizardOpen && state ? (
        <CreateWizard
          templates={state.templates}
          services={state.services}
          onClose={() => setWizardOpen(false)}
          onCreated={(service) => {
            setWizardOpen(false);
            notify(`已创建服务 ${service.name}`);
            navigate({ view: 'service', id: service.id, tab: 'config' });
            void refresh();
          }}
        />
      ) : null}

      {aboutOpen && state ? (
        <Modal
          title="本机信息"
          subtitle="管理台只监听本机回环地址；数据与凭据都在本机。"
          onClose={() => setAboutOpen(false)}
          footer={
            <div className="row end">
              <button type="button" className="btn primary" onClick={() => setAboutOpen(false)}>
                知道了
              </button>
            </div>
          }
        >
          <div className="info-grid single">
            <InfoRow label="版本" value={state.manager.version} />
            <InfoRow label="Node" value={state.manager.node} />
            <InfoRow label="平台" value={state.manager.platform} />
            <InfoRow label="监听" value={`${state.manager.host}:${state.manager.port}`} />
            <InfoRow label="数据目录" value={state.manager.home} mono />
            <InfoRow label="已运行" value={formatDuration(state.manager.uptime_ms)} />
            <InfoRow label="网页令牌" value="~/.aidash/manager/web-token（0600）" mono />
            <InfoRow label="服务凭据" value="~/.aidash/manager/secrets.json（0600）" mono />
          </div>
          <div className="alert alert-warn">
            令牌只保存在本机文件中，接口永远不会回显明文。换机或重置时删除对应文件即可。
          </div>
        </Modal>
      ) : null}

      <Toast message={toast} onClose={() => setToast(null)} />

      <footer className="app-footer">
        <span>AIDash Manager · 本地服务管理台</span>
        <span className="muted small">管理台进程退出不会停止由它拉起的服务；服务按各自配置继续运行。</span>
      </footer>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="info-item">
      <span className="info-label">{label}</span>
      <span className={`info-value ${mono ? 'mono' : ''}`}>{value}</span>
    </div>
  );
}

function TokenGate({ onSubmit }: { onSubmit: () => void }) {
  const [token, setToken] = useState(getStoredToken());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setStoredToken(token.trim());
    try {
      await api.state();
      onSubmit();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
      setStoredToken('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="token-gate">
      <div className="token-card">
        <div className="brand-mark large">A</div>
        <h1>AIDash Manager</h1>
        <p className="muted">
          需要访问令牌才能打开管理台。请使用命令行启动时打印的完整链接，或从本机
          <code> ~/.aidash/manager/web-token </code> 读取令牌。
        </p>
        <label className="field">
          <span className="field-label">访问令牌</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            autoFocus
          />
        </label>
        {error ? <div className="alert alert-danger">{error}</div> : null}
        <button type="button" className="btn primary block" onClick={() => void submit()} disabled={busy || !token.trim()}>
          {busy ? '验证中…' : '进入管理台'}
        </button>
      </div>
    </div>
  );
}
