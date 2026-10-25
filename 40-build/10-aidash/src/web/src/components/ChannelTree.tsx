import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ChannelView } from '../types';
import { pickGroupAlias } from '../lib/channel-group';
import { formatStamp } from '../lib/format';
import { channelPath } from '../lib/router';

const UNGROUPED = '未分组';

interface ChannelGroup {
  project: string;
  /** 组内代表别名：主对话本身没有别名字段，只能从通道派生。 */
  alias: string | null;
  channels: ChannelView[];
  cardCount: number;
  openTaskCount: number;
  /** 组内最早一条通道的创建时间：代表这组对话“什么时候开始有活动”。 */
  startedAt: string;
  /** 组内最近一次活动时间（含 MCP 读操作）。 */
  lastActiveAt: string | null;
  /** 组内最近一次 MCP 活动；null 表示整组从未观测到 agent 调用。 */
  lastMcpAt: string | null;
  /** 组内任意一条通道的 agent 在线，就把这组显示为进行中。 */
  agentOnline: boolean;
}

/**
 * 右上角通道树。
 *
 * 为什么要合并原来的“全部通道 + 聚焦全部”：
 * 旧交互里“选主对话”和“选全部通道”是两个按钮，用户要跨项目看时得先点“全部通道”
 * 再点一次“清除聚焦”；这里把两者合成同一棵树的根节点，点根节点就是“全部通道”，
 * 点主对话行就是“这个主对话下的全部通道”，一步到位。
 *
 * 展开项显示“开始 / 在线或已停止 + 卡/任务计数”：
 * 通道列表的职责不是罗列名字，而是回答“agent 现在还连着吗、还有多少没干完的活”。
 *
 * 关键语义：**在线**只看服务端下发的 `agent_online`（最近 3 分钟内有 MCP 调用）。
 * 不能用 `open_task_count > 0` 代替——任务排着没做，不代表 agent 还在执行；
 * 旧实现正是这样，导致 MCP 停了几个小时通道仍一直转圈。
 */
export function ChannelTree({
  channels,
  total,
  currentChannelKey,
  currentProject,
  loading,
  onSelectChannel,
  onSelectProject,
}: {
  channels: ChannelView[];
  /** 服务端通道总数；大于已加载条数说明树只显示了第一页。 */
  total: number;
  currentChannelKey: string;
  currentProject: string;
  loading: boolean;
  onSelectChannel: (key: string) => void;
  onSelectProject: (project: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点外部/按 Esc 收起：下拉面板覆盖在页面内容上，不关掉会挡住筛选区。
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const groups = groupByProject(channels);
  const totalCards = channels.reduce((sum, channel) => sum + (channel.card_count ?? 0), 0);
  const totalOpenTasks = channels.reduce(
    (sum, channel) => sum + (channel.open_task_count ?? 0),
    0,
  );
  const allActive = !currentChannelKey && !currentProject;
  const currentChannel = channels.find((channel) => channel.channel_key === currentChannelKey);

  const chooseChannel = (key: string): void => {
    // 单通道与主对话互斥由 App 的 setCurrentChannelKey 保证；这里只负责收起面板。
    onSelectChannel(key);
    setOpen(false);
  };

  const chooseProject = (project: string): void => {
    onSelectProject(project);
    setOpen(false);
  };

  return (
    <div className="channel-tree" ref={rootRef}>
      <button
        type="button"
        className={open ? 'channel-tree-trigger open' : 'channel-tree-trigger'}
        aria-haspopup="true"
        aria-expanded={open}
        title="通道树：选全部通道、某个主对话或单条通道"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="muted small">通道</span>
        <strong className="channel-tree-current">
          {scopeLabel(
            currentProject,
            groups.find((group) => group.project === currentProject)?.alias ?? null,
            currentChannel,
            currentChannelKey,
          )}
        </strong>
        <span className="channel-tree-caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open ? (
        <div className="channel-tree-panel" role="menu" aria-label="通道树">
          <button
            type="button"
            className={allActive ? 'channel-tree-all active' : 'channel-tree-all'}
            onClick={() => chooseChannel('')}
          >
            <span>
              <strong>全部通道</strong>
              <span className="muted small">
                {' '}
                {channels.length} 通道 · {totalCards} 卡 · {totalOpenTasks} 待处理
              </span>
            </span>
            <span className="muted small">跨主对话查看</span>
          </button>

          {/* 只取到第一页时明确告知，避免用户以为“通道就这么多”。
              条数用实际加载数而不是写死 200：服务端 page_size 上限可配置。 */}
          {total > channels.length ? (
            <p className="muted small channel-tree-loading">
              共 {total} 个通道，仅显示前 {channels.length} 个
            </p>
          ) : null}

          {loading ? <p className="muted small channel-tree-loading">通道加载中…</p> : null}

          {groups.map((group) => {
            const groupActive = group.agentOnline;
            const groupSelected = currentProject === group.project;
            // “未分组”只是历史数据的兜底桶，没有真实 project 值：
            // 按 project 精确筛选会得到空列表，所以不给它可点击的“聚焦”语义。
            const canFocus = group.project !== UNGROUPED;
            return (
              <section className="channel-tree-group" key={group.project}>
                <button
                  type="button"
                  className={
                    groupSelected ? 'channel-tree-project active' : 'channel-tree-project'
                  }
                  disabled={!canFocus}
                  title={
                    canFocus
                      ? `只看主对话「${group.alias || group.project}」下的全部通道（project: ${group.project}）`
                      : '旧通道没有 project 段，无法按主对话跨通道筛选'
                  }
                  onClick={() => chooseProject(group.project)}
                >
                  <span className="channel-tree-project-head">
                    {/* 别名放主位，原始 project 只作为副行，用户才知道筛选/记忆挂在哪个 key 上。 */}
                    <strong>{group.alias || group.project}</strong>
                    {group.alias ? (
                      <span className="muted small mono">{group.project}</span>
                    ) : null}
                    <span className="muted small">
                      {group.channels.length} 通道 · {group.cardCount} 卡 ·{' '}
                      {group.openTaskCount} 待处理
                    </span>
                  </span>
                  <span className="channel-tree-times">
                    <span>开始 {formatStamp(group.startedAt)}</span>
                    <span>
                      {groupActive ? (
                        <>
                          <span className="spinner spinner-xs" aria-hidden="true" />
                          在线
                        </>
                      ) : group.lastMcpAt ? (
                        `已停止 · 最后活动 ${formatStamp(group.lastMcpAt)}`
                      ) : (
                        '已停止 · 无 MCP 活动记录'
                      )}
                    </span>
                  </span>
                </button>

                <ul className="channel-tree-list">
                  {group.channels.map((channel) => {
                    const channelActive = channel.agent_online === true;
                    const selected = currentChannelKey === channel.channel_key;
                    return (
                      <li
                        key={channel.id}
                        className={selected ? 'channel-tree-row active' : 'channel-tree-row'}
                      >
                        <button
                          type="button"
                          className="channel-tree-item"
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => chooseChannel(channel.channel_key)}
                        >
                          <span className="channel-tree-item-head">
                            {channelActive ? (
                              <span
                                className="spinner spinner-xs"
                                role="img"
                                aria-label="agent 在线"
                                title="最近 3 分钟内有 MCP 调用"
                              />
                            ) : (
                              <span
                                className="channel-tree-dot"
                                aria-hidden="true"
                                title="已停止：最近 3 分钟没有 MCP 调用"
                              />
                            )}
                            <strong>{channelTitle(channel)}</strong>
                            {selected ? <span className="badge">当前</span> : null}
                          </span>
                          <span className="channel-tree-key mono">{channel.channel_key}</span>
                          <span className="channel-tree-times">
                            <span>开始 {formatStamp(channel.created_at)}</span>
                            <span>
                              {channelActive
                                ? '在线'
                                : channel.last_mcp_at
                                  ? `已停止 · 最后活动 ${formatStamp(channel.last_mcp_at)}`
                                  : '已停止 · 无 MCP 活动记录'}
                            </span>
                            <span>
                              {channel.card_count} 卡 · {channel.task_count ?? 0} 任务 /{' '}
                              {channel.open_task_count ?? 0} 待处理
                            </span>
                          </span>
                        </button>
                        <a
                          className="channel-tree-open"
                          href={`#${channelPath(channel.channel_key)}`}
                          title={`打开通道 ${channel.channel_key}`}
                          onClick={() => setOpen(false)}
                        >
                          详情 →
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          {!loading && channels.length === 0 ? (
            <p className="muted small channel-tree-loading">
              暂无通道；harness 发卡后会自动创建。
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function scopeLabel(
  project: string,
  projectAlias: string | null,
  channel: ChannelView | undefined,
  channelKey: string,
): string {
  if (project) return `主对话 · ${projectAlias || project}`;
  if (channel) return channelTitle(channel);
  if (channelKey) return channelKey;
  return '全部通道';
}

/**
 * 展示名优先级：别名 > topic > title > name > key。
 *
 * 别名是 agent 用用户语言写的一句话概述，最能让用户一眼认出“这条通道在干什么”；
 * 它只影响展示，筛选/深链仍然用 channel_key。
 */
function channelTitle(channel: ChannelView): string {
  return (
    channel.alias?.trim() ||
    channel.topic?.trim() ||
    channel.title?.trim() ||
    channel.name?.trim() ||
    channel.channel_key
  );
}

/**
 * 按 project 分组并汇总统计。
 *
 * 排序按“最近活动时间倒序”：用户打开通道树的第一诉求通常是回到刚才在看的对话，
 * 而不是按字母顺序找项目；“未分组”是历史兜底桶，固定排最后。
 */
function groupByProject(channels: ChannelView[]): ChannelGroup[] {
  const map = new Map<string, ChannelGroup>();
  for (const channel of channels) {
    const project = channel.project?.trim() || UNGROUPED;
    const active = channel.last_active_at ?? channel.updated_at;
    const group = map.get(project) ?? {
      project,
      alias: null,
      channels: [],
      cardCount: 0,
      openTaskCount: 0,
      startedAt: channel.created_at,
      lastActiveAt: active,
      lastMcpAt: channel.last_mcp_at,
      agentOnline: false,
    };
    group.channels.push(channel);
    group.cardCount += channel.card_count ?? 0;
    group.openTaskCount += channel.open_task_count ?? 0;
    // 在线是“任意一条在线”，不是“任务数大于零”：一条通道在跑就代表这组还在动。
    if (channel.agent_online === true) group.agentOnline = true;
    // ISO 8601 字符串可直接比较大小：取最早创建与最近活动。
    if (channel.created_at < group.startedAt) group.startedAt = channel.created_at;
    if (!group.lastActiveAt || active > group.lastActiveAt) group.lastActiveAt = active;
    if (channel.last_mcp_at && (!group.lastMcpAt || channel.last_mcp_at > group.lastMcpAt)) {
      group.lastMcpAt = channel.last_mcp_at;
    }
    map.set(project, group);
  }

  // 分组别名在收集完通道后再算：pickGroupAlias 需要看到整组，才能选出“在线优先”的那条。
  for (const group of map.values()) {
    group.alias = pickGroupAlias(group.channels);
  }

  return Array.from(map.values()).sort((left, right) => {
    if (left.project === UNGROUPED) return 1;
    if (right.project === UNGROUPED) return -1;
    return (right.lastActiveAt ?? '').localeCompare(left.lastActiveAt ?? '');
  });
}
