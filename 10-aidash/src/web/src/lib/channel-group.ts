/**
 * 通道分组的展示名计算。
 *
 * 主对话（project）本身没有别名字段，别名挂在通道上。左侧/右上通道树按 project
 * 分组时，如果只显示原始 project（例如 `aidash`），用户会再次看到“别名没生效”。
 * 这里从同组通道里挑一个最有代表性的别名：在线优先，其次最近活动。
 *
 * 纯函数、不依赖 React，便于直接单测；调用方是 ChannelTree。
 */

export interface GroupAliasChannel {
  alias: string | null;
  agent_online?: boolean;
  last_active_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

/**
 * 取一组通道的代表别名；没有任何非空别名时返回 null，让调用方回退到 project。
 *
 * 为什么“在线优先”而不是只看更新时间：
 * 项目下可能同时有归档通道和正在跑的通道，归档通道的别名就算更新时间更晚，
 * 也不如“当前 agent 正在用的那条”更能代表这个主对话正在做什么。
 */
export function pickGroupAlias(channels: readonly GroupAliasChannel[]): string | null {
  let best: { alias: string; online: number; activeAt: string } | null = null;

  for (const channel of channels) {
    const alias = channel.alias?.trim();
    if (!alias) continue;

    const online = channel.agent_online === true ? 1 : 0;
    // 时间字段都是 ISO 8601，同一时区下字符串比较等价于时间比较；
    // 缺失时用空串兜底，保证不会因为 null 把比较变成 false。
    const activeAt = channel.last_active_at ?? channel.updated_at ?? channel.created_at ?? '';

    if (
      !best ||
      online > best.online ||
      // 在线状态相同时才比时间；时间也相同就保留先遍历到的那条，
      // 保持结果稳定，避免同一份数据在两次渲染里换名字。
      (online === best.online && activeAt > best.activeAt)
    ) {
      best = { alias, online, activeAt };
    }
  }

  return best?.alias ?? null;
}
