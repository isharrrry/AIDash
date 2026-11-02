import type { HarnessPresence, HarnessStatus } from './types.js';

/**
 * 把 status + busy 两列合成 UI 需要的四态。
 *
 * 顺序是刻意的：disabled 是人工封禁，优先于一切；offline 表示根本联系不上；
 * 只有在线时才轮到 busy/idle。服务端与 Web 共用它，避免两处各写一遍判定后
 * 出现“设置页说运行中、别处说离线”的口径漂移。
 *
 * busy 同时接受 SQLite 的 0/1 和序列化后的 boolean：API 视图会把列转成布尔，
 * 两边的输入形状不同但语义相同。
 */
export function harnessPresence(row: {
  status: HarnessStatus | string;
  busy?: number | boolean | null;
}): HarnessPresence {
  if (row.status === 'disabled') return 'disabled';
  if (row.status === 'offline') return 'offline';
  return row.busy === 1 || row.busy === true ? 'busy' : 'idle';
}
