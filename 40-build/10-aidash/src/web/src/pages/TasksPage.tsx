import type { ReactElement } from 'react';
import type { ChannelView } from '../types';
import { useApp } from '../AppContext';
import { EmptyState, Loading } from '../components/Feedback';
import { TaskBoard } from '../components/TaskBoard';

const UNGROUPED = '未分组';

/** 通道展示名：别名 > topic > title > name > channel_key，与通道树保持同一套优先级。 */
function channelDisplayName(channel: ChannelView): string {
  return (
    channel.alias?.trim() ||
    channel.topic ||
    channel.title ||
    channel.name ||
    channel.channel_key
  );
}

/**
 * 一条通道一块看板。
 *
 * 主对话聚焦与全部通道共用同一个块结构：用户已经在主对话视图里认可了
 * “每条子通道一块本次通道任务”的形态，全部通道视图不应再把所有通道压进
 * 同一个看板——那样筛选、统计和详情会跨通道串在一起，归属也看不出来。
 */
function ChannelBoardSection({ channel }: { channel: ChannelView }): ReactElement {
  return (
    <section
      className="panel task-channel-group"
      aria-label={`通道 ${channel.channel_key} 的任务`}
    >
      <header className="panel-header">
        <div className="task-channel-head">
          <h2>{channelDisplayName(channel)}</h2>
          <p className="muted small">
            <span className="tag">
              {channel.project?.trim() || UNGROUPED}
              {channel.topic ? ` / ${channel.topic}` : ''}
            </span>
            {' · '}
            <span className="mono" title={channel.workdir ?? undefined}>
              {channel.workdir || '未登记工作路径'}
            </span>
          </p>
        </div>
        <span className="muted small">
          {channel.task_count ?? 0} 任务 · {channel.open_task_count ?? 0} 未结束
        </span>
      </header>
      <TaskBoard key={channel.channel_key} channelKey={channel.channel_key} compact />
    </section>
  );
}

/** SCR-03 任务树看板：通道切换 + 树 + 详情 + 认领/事件。 */
export function TasksPage(): ReactElement {
  const { channels, channelsLoading, currentChannelKey, currentProject } = useApp();

  // 主对话聚焦时按通道逐个渲染看板：任务树按 channel 取数，不能跨通道合并，
  // 否则不同通道里同 ID 的父子关系会被错误拼接。
  const projectChannels = currentProject
    ? channels.filter((channel) => (channel.project?.trim() || UNGROUPED) === currentProject)
    : [];
  // 全部通道视图同样一条通道一块看板；task_count 为 0 的通道不渲染，
  // 否则会翻出一串空看板（要新建第一条任务时可从通道树进入该通道）。
  const taskChannels = channels.filter((channel) => (channel.task_count ?? 0) > 0);

  return (
    <div className="page">
      {/*
        页面级标题已合并进看板头部：h1 + 面板 h2 会让首屏多出近 90px 的重复标题。
        通道/主对话切换统一由右上角通道树承担，页面内不再放第二套入口。
      */}
      {currentChannelKey ? (
        // 单通道模式：保持原来的单看板，避免用户选了一条通道还看到别的通道任务。
        <TaskBoard key={currentChannelKey} channelKey={currentChannelKey} />
      ) : currentProject ? (
        <>
          {/*
            记忆有独立 Tab 了：这里不再嵌完整编辑器，避免同一份记忆出现两个编辑入口。
            保留一行入口，用户在主对话视角下仍能顺手跳过去。
          */}
          <p className="muted small">
            主对话「{currentProject}」的记忆（跨话题共用）请在{' '}
            <a className="inline-link" href="#/memory">
              记忆 Tab
            </a>{' '}
            查看或编辑。
          </p>
          {projectChannels.length > 0 ? (
            <div className="task-project-boards">
              {projectChannels.map((channel) => (
                <ChannelBoardSection key={channel.id} channel={channel} />
              ))}
            </div>
          ) : (
            <EmptyState
              title="该主对话下没有通道"
              hint="通道可能已被归档，或 project 段与列表不一致；回到决策台刷新后再试。"
            />
          )}
        </>
      ) : (
        <>
          {/*
            没有选中通道/主对话时显示全部通道视图：与主对话视图一致，每条通道
            一块独立看板，而不是把所有通道塞进同一个看板里再分块。
          */}
          <p className="muted small">
            正在显示全部通道的任务（已加载 {channels.length} 个通道，其中{' '}
            {taskChannels.length} 个有任务）；每条通道一块看板，点右上角「通道」
            可聚焦单条通道或主对话。
          </p>
          {channelsLoading && channels.length === 0 ? (
            <Loading label="加载通道…" />
          ) : taskChannels.length > 0 ? (
            <div className="task-project-boards">
              {taskChannels.map((channel) => (
                <ChannelBoardSection key={channel.id} channel={channel} />
              ))}
            </div>
          ) : (
            <EmptyState
              title="还没有任何通道任务"
              hint="通道里创建任务后，这里会每条通道一块看板显示；也可点右上角「通道」进入某条通道新建第一条。"
            />
          )}
        </>
      )}
    </div>
  );
}
