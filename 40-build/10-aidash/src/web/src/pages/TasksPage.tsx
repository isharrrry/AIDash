import type { ReactElement } from 'react';
import { useApp } from '../AppContext';
import { EmptyState } from '../components/Feedback';
import { TaskBoard } from '../components/TaskBoard';

const UNGROUPED = '未分组';

/** SCR-03 任务树看板：通道切换 + 树 + 详情 + 认领/事件。 */
export function TasksPage(): ReactElement {
  const { channels, currentChannelKey, currentProject } = useApp();

  // 主对话聚焦时按通道逐个渲染看板：任务树按 channel 取数，不能跨通道合并，
  // 否则不同通道里同 ID 的父子关系会被错误拼接。
  const projectChannels = currentProject
    ? channels.filter((channel) => (channel.project?.trim() || UNGROUPED) === currentProject)
    : [];

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
                <section
                  key={channel.id}
                  className="panel task-channel-group"
                  aria-label={`通道 ${channel.channel_key} 的任务`}
                >
                  <header className="panel-header">
                    <div className="task-channel-head">
                      <h2>
                        {channel.alias?.trim() ||
                          channel.topic ||
                          channel.title ||
                          channel.name ||
                          channel.channel_key}
                      </h2>
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
                  <TaskBoard
                    key={channel.channel_key}
                    channelKey={channel.channel_key}
                    compact
                  />
                </section>
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
        <EmptyState
          title="选择一个通道或主对话开始"
          hint="点右上角「通道」展开通道树：点主对话行看它下面全部通道的任务，点单条通道只看一条对话。"
        >
          <p className="muted small">已加载 {channels.length} 个通道。</p>
        </EmptyState>
      )}
    </div>
  );
}
