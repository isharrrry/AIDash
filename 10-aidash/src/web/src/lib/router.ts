/**
 * 极简 hash 路由。
 *
 * 为什么用 hash 而不是 History API：生产构建由 Express 托管静态文件，
 * 若服务端没有为 `/tasks` 这类路径配置 SPA 回退，刷新就会 404。
 * hash 只改变 `#` 之后的部分，服务端永远只看到 `/`，不依赖任何额外配置。
 * 代价是不符合设计文档里的“干净 URL”，已在交付说明中登记为取舍。
 */
import { useEffect, useState } from 'react';

export type RouteName =
  | 'home'
  | 'tasks'
  | 'memory'
  | 'reports'
  | 'settings'
  | 'channel'
  | 'notfound';

export interface RouteState {
  name: RouteName;
  /** 规范化后的路径，用于抽屉关闭时保留当前页面。 */
  path: string;
  channelKey: string | null;
  cardId: string | null;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseRoute(hash = window.location.hash): RouteState {
  let raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) raw = '/';
  if (!raw.startsWith('/')) raw = `/${raw}`;

  // 以固定虚拟域名解析，避免相对 URL 对当前页面的依赖。
  const url = new URL(raw, 'http://aidash.local');
  const path = url.pathname || '/';
  const cardId = url.searchParams.get('card');

  if (path === '/' || path === '') {
    return { name: 'home', path: '/', channelKey: null, cardId };
  }
  if (path === '/tasks' || path.startsWith('/tasks/')) {
    return { name: 'tasks', path: '/tasks', channelKey: null, cardId };
  }
  if (path === '/memory' || path.startsWith('/memory/')) {
    return { name: 'memory', path: '/memory', channelKey: null, cardId };
  }
  if (path === '/reports' || path.startsWith('/reports/')) {
    return { name: 'reports', path: '/reports', channelKey: null, cardId };
  }
  if (path === '/settings') {
    return { name: 'settings', path: '/settings', channelKey: null, cardId };
  }
  if (path.startsWith('/c/')) {
    const key = decode(path.slice(3).replace(/\/+$/, ''));
    return { name: 'channel', path, channelKey: key || null, cardId };
  }
  return { name: 'notfound', path, channelKey: null, cardId };
}

export function useRoute(): RouteState {
  const [route, setRoute] = useState<RouteState>(() => parseRoute());
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const next = `#${normalized}`;
  if (window.location.hash === next) {
    // 相同 hash 不会触发 hashchange；手动派发一次，保证“刷新”类操作有效。
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = normalized;
}

export function channelPath(channelKey: string): string {
  return `/c/${encodeURIComponent(channelKey)}`;
}

/** 在当前页面上叠加卡片抽屉，深链形如 `#/?card=cd_x`。 */
export function openCard(cardId: string): void {
  const route = parseRoute();
  navigate(`${route.path}?card=${encodeURIComponent(cardId)}`);
}

export function closeCard(): void {
  const route = parseRoute();
  navigate(route.path);
}
