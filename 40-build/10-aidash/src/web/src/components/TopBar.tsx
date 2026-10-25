import type { ReactElement } from 'react';
import type { ChannelView } from '../types';
import type { RouteName } from '../lib/router';
import { ChannelTree } from './ChannelTree';

export type ConnectionState = 'online' | 'offline' | 'checking';

/**
 * 主导航顺序：任务树第一。
 *
 * 用户日常入口是“看我安排的事做到哪了”，决策台是只在有人拍板时才需要去的地方；
 * 把任务树放第一，打开应用第一眼就是活，而不是等用户自己想起来切页。
 */
const NAV_ITEMS: Array<{ name: RouteName; href: string; label: string }> = [
  { name: 'tasks', href: '#/tasks', label: '任务树' },
  { name: 'home', href: '#/', label: '决策台' },
  { name: 'memory', href: '#/memory', label: '记忆' },
  { name: 'reports', href: '#/reports', label: '汇报' },
  { name: 'settings', href: '#/settings', label: '设置/运维' },
];

export function TopBar({
  routeName,
  connection,
  channels,
  channelsTotal,
  channelsLoading,
  currentChannelKey,
  currentProject,
  onChannelChange,
  onProjectChange,
  onRefresh,
  onLogout,
}: {
  routeName: RouteName;
  connection: ConnectionState;
  channels: ChannelView[];
  /** 服务端通道总数；大于 channels.length 时通道树只覆盖了一页。 */
  channelsTotal: number;
  channelsLoading: boolean;
  currentChannelKey: string;
  /** 当前主对话聚焦。与 currentChannelKey 互斥，由 App 保证。 */
  currentProject: string;
  onChannelChange: (key: string) => void;
  onProjectChange: (project: string) => void;
  onRefresh: () => void;
  onLogout: () => void;
}): ReactElement {
  const connectionText =
    connection === 'online' ? '已连接' : connection === 'offline' ? '连接中断' : '检测中';

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>
          AIDash
        </a>

        <nav className="nav" aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.name}
              href={item.href}
              className={routeName === item.name ? 'nav-link active' : 'nav-link'}
              aria-current={routeName === item.name ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="topbar-right">
          {/* 决策台/任务树页面里的通道条已合并到这里，全站只有这一个切换入口。 */}
          <ChannelTree
            channels={channels}
            total={channelsTotal}
            currentChannelKey={currentChannelKey}
            currentProject={currentProject}
            loading={channelsLoading}
            onSelectChannel={onChannelChange}
            onSelectProject={onProjectChange}
          />

          <span className={`conn conn-${connection}`} title={connectionText}>
            <span className="conn-dot" aria-hidden="true" />
            {connectionText}
          </span>

          <button type="button" className="btn btn-small" onClick={onRefresh}>
            刷新
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={onLogout}>
            更换令牌
          </button>
        </div>
      </div>
    </header>
  );
}
