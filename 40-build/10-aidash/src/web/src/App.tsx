import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { ChannelView, HealthView, Page } from './types';
import { clearToken, getToken, onUnauthorized } from './api/client';
import { getHealth, listChannels } from './api/endpoints';
import { AppContext } from './AppContext';
import type { AppContextValue } from './AppContext';
import { useAsync } from './hooks/useAsync';
import { usePolling } from './hooks/usePolling';
import { closeCard, channelPath, navigate, useRoute } from './lib/router';
import type { RouteName } from './lib/router';
import { CardDrawer } from './components/CardDrawer';
import { ToastProvider, useToast } from './components/Toast';
import { TokenGate } from './components/TokenGate';
import { TopBar } from './components/TopBar';
import type { ConnectionState } from './components/TopBar';
import { ChannelPage } from './pages/ChannelPage';
import { HomePage } from './pages/HomePage';
import { MemoryPage } from './pages/MemoryPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';

const CHANNEL_STORAGE_KEY = 'aidash.channel';
const PROJECT_STORAGE_KEY = 'aidash.project';
const CHANNEL_PAGE_SIZE = 100;

/**
 * App 负责四件跨页的事：
 * 1. 令牌闸门与 401 自动退出；
 * 2. 路由分发（hash，原因见 lib/router.ts）；
 * 3. 通道列表、当前通道、刷新计数这三个轻量全局状态；
 * 4. 全局卡片抽屉与连接状态。
 * 页面数据仍由页面自己加载，避免把应用做成一个大 store。
 */
export function App(): ReactElement {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}

function AppShell(): ReactElement {
  const notify = useToast().notify;
  const [token, setTokenValue] = useState<string | null>(() => getToken());
  const route = useRoute();

  const [refreshNonce, setRefreshNonce] = useState(0);
  const [currentChannelKey, setCurrentChannelKeyState] = useState(
    () => window.sessionStorage.getItem(CHANNEL_STORAGE_KEY) ?? '',
  );
  // 两个筛选互斥：恢复会话时也遵守“通道优先”，避免刷新后同时命中两层。
  const [currentProject, setCurrentProjectState] = useState(() =>
    window.sessionStorage.getItem(CHANNEL_STORAGE_KEY)
      ? ''
      : (window.sessionStorage.getItem(PROJECT_STORAGE_KEY) ?? ''),
  );
  const [dismissedIssue, setDismissedIssue] = useState<string | null>(null);

  const channelsState = useAsync<Page<ChannelView>>(
    () => listChannels({ page_size: CHANNEL_PAGE_SIZE }),
    [refreshNonce],
    token !== null,
  );
  const health = useAsync<HealthView>(() => getHealth(), [refreshNonce], token !== null);

  const reloadChannels = useCallback(() => channelsState.reload(), [channelsState.reload]);

  const refreshAll = useCallback(() => {
    setRefreshNonce((value) => value + 1);
    channelsState.reload();
    health.reload();
  }, [channelsState.reload, health.reload]);

  // 401 是“令牌失效”而不是网络抖动：立刻清掉本地令牌，回到输入页，不自动重试。
  // 只在已有令牌时监听：令牌输入页自己的 401 由 TokenGate 就地提示，避免双重弹窗。
  useEffect(() => {
    if (!token) return undefined;
    const unsubscribe = onUnauthorized(() => {
      clearToken();
      setTokenValue(null);
      notify('warn', '令牌已失效，请重新输入。');
    });
    return unsubscribe;
  }, [token, notify]);

  usePolling(() => {
    channelsState.reload();
    health.reload();
  }, 30000, token !== null);

  const setCurrentChannelKey = useCallback((key: string) => {
    setCurrentChannelKeyState(key);
    window.sessionStorage.setItem(CHANNEL_STORAGE_KEY, key);
    // 互斥规则：选了具体通道，就退出“按主对话看全部通道”的模式。
    setCurrentProjectState('');
    window.sessionStorage.setItem(PROJECT_STORAGE_KEY, '');
  }, []);

  const setCurrentProject = useCallback((project: string) => {
    setCurrentProjectState(project);
    window.sessionStorage.setItem(PROJECT_STORAGE_KEY, project);
    // 互斥规则：按主对话聚焦时，单通道筛选必须清空，否则结果集为空。
    setCurrentChannelKeyState('');
    window.sessionStorage.setItem(CHANNEL_STORAGE_KEY, '');
  }, []);

  // 顶部下拉在通道详情页时不只是改全局筛选：
  // 还要导航到新通道，否则地址栏和页面内容会与“当前通道”不一致。
  const changeChannel = useCallback(
    (key: string) => {
      // 顺序不能反：setCurrentProject 为了维持互斥会清空通道，
      // 若先设通道再清主对话，刚选中的通道会被第二步清掉。
      // 先清主对话，再设通道（setCurrentChannelKey 内部也会清 project）。
      setCurrentProject('');
      setCurrentChannelKey(key);
      if (route.name === 'channel') {
        navigate(key ? channelPath(key) : '/');
      }
    },
    [route.name, setCurrentChannelKey, setCurrentProject],
  );

  // 通道树里点主对话行 = 旧版“聚焦全部”。如果当前在通道详情页，
  // 必须回决策台，否则 ChannelPage 的同步 effect 会立刻把单通道筛选写回去。
  const changeProject = useCallback(
    (project: string) => {
      setCurrentProject(project);
      if (route.name === 'channel') navigate('/');
    },
    [route.name, setCurrentProject],
  );

  const onTokenSaved = (): void => {
    setTokenValue(getToken());
    setDismissedIssue(null);
    refreshAll();
  };

  if (!token) {
    return <TokenGate onTokenSaved={onTokenSaved} />;
  }

  const channels = channelsState.data?.items ?? [];
  const connection: ConnectionState = health.error
    ? 'offline'
    : health.data
      ? 'online'
      : 'checking';

  // 健康检查/通道加载失败给出全局可关闭横幅；关闭后同一错误不再打扰，
  // 但错误文本变化（新错误）会重新出现。
  const issueParts: string[] = [];
  if (health.error) issueParts.push(`健康检查失败：${health.error}`);
  if (channelsState.error) issueParts.push(`通道列表加载失败：${channelsState.error}`);
  const issue = issueParts.length > 0 ? issueParts.join(' · ') : null;
  const showIssue = Boolean(issue) && dismissedIssue !== issue;

  const contextValue: AppContextValue = {
    refreshNonce,
    refreshAll,
    channels,
    channelsLoading: channelsState.loading,
    reloadChannels,
    currentChannelKey,
    setCurrentChannelKey,
    currentProject,
    setCurrentProject,
  };

  return (
    <AppContext.Provider value={contextValue}>
      <div className="app">
        <TopBar
          routeName={route.name}
          connection={connection}
          channels={channels}
          channelsLoading={channelsState.loading}
          currentChannelKey={currentChannelKey}
          currentProject={currentProject}
          onChannelChange={changeChannel}
          onProjectChange={changeProject}
          onRefresh={refreshAll}
          onLogout={() => {
            clearToken();
            setTokenValue(null);
          }}
        />

        {showIssue && issue ? (
          <div className="banner banner-error" role="alert">
            <span className="grow">{issue}</span>
            <button type="button" className="btn btn-small" onClick={refreshAll}>
              重试
            </button>
            <button
              type="button"
              className="toast-close"
              aria-label="关闭错误提示"
              onClick={() => setDismissedIssue(issue)}
            >
              ×
            </button>
          </div>
        ) : null}

        <main className="main">
          <RouteView routeName={route.name} channelKey={route.channelKey} />
        </main>

        <footer className="app-footer">
          <span className="muted small">
            AIDash V2.0 · 本地只读知识库 · 令牌通过 Authorization 头发送
          </span>
          <span className="muted small">hash 路由，刷新页面不会 404</span>
        </footer>

        {route.cardId ? (
          <CardDrawer
            cardId={route.cardId}
            onClose={closeCard}
            onChanged={refreshAll}
          />
        ) : null}
      </div>
    </AppContext.Provider>
  );
}

function RouteView({
  routeName,
  channelKey,
}: {
  routeName: RouteName;
  channelKey: string | null;
}): ReactElement {
  switch (routeName) {
    case 'home':
      return <HomePage />;
    case 'tasks':
      return <TasksPage />;
    case 'memory':
      return <MemoryPage />;
    case 'reports':
      return <ReportsPage />;
    case 'settings':
      return <SettingsPage />;
    case 'channel':
      return channelKey ? (
        <ChannelPage key={channelKey} channelKey={channelKey} />
      ) : (
        <NotFound />
      );
    default:
      return <NotFound />;
  }
}

function NotFound(): ReactElement {
  return (
    <div className="page">
      <div className="empty-state">
        <strong>页面不存在</strong>
        <p className="muted">检查地址，或回到决策台。</p>
        <a className="btn btn-small" href="#/">
          返回决策台
        </a>
      </div>
    </div>
  );
}
