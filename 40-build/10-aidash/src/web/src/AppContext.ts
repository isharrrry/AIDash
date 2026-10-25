import { createContext, useContext } from 'react';
import type { ChannelView } from './types';

/**
 * 全局只放“跨页共享的轻状态”：刷新计数、通道列表、当前通道、当前主对话。
 * 卡片/任务数据仍由各页面自己持有，避免做成一个巨大的全局 store。
 *
 * currentProject 与 currentChannelKey 是互斥筛选：主对话（project）看全部子通道，
 * 单通道（channel）只看一条。两个同时生效会让用户分不清“当前到底在看哪一层”。
 */
export interface AppContextValue {
  refreshNonce: number;
  refreshAll: () => void;
  channels: ChannelView[];
  channelsLoading: boolean;
  reloadChannels: () => void;
  currentChannelKey: string;
  setCurrentChannelKey: (key: string) => void;
  /** 当前聚焦的主对话（通道 project 段）；空串表示不按主对话筛选。 */
  currentProject: string;
  setCurrentProject: (project: string) => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp 必须在 AppContext.Provider 内使用');
  return value;
}
