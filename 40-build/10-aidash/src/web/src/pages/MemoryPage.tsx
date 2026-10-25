import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { describeError } from '../api/client';
import type { AssistantMemoryView, MemoryProjectView } from '../types';
import { getAssistantMemory, getProjectMemory, listMemoryProjects } from '../api/endpoints';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import { downloadMarkdown } from '../lib/download';
import { formatAbsolute, formatRelative, formatStamp } from '../lib/format';
import {
  memoryDisplayName,
  sortMemoryProjects,
  type MemorySortKey,
} from '../lib/memory-sort';
import { EmptyState, ErrorBox, Loading } from '../components/Feedback';
import { AssistantMemoryPanel } from '../components/AssistantMemoryPanel';
import { MemoryDigestPanel } from '../components/MemoryDigestPanel';
import { ProjectMemoryPanel } from '../components/ProjectMemoryPanel';
import { useToast } from '../components/Toast';

const SELECTED_STORAGE_KEY = 'aidash.memory.project';
/** sessionStorage 里区分“选中的是 AIDash 记忆”与“选中的是某个 project”。 */
const ASSISTANT_STORAGE_VALUE = '__assistant__';

/**
 * 记忆页有两种条目，归属与机理不同：
 * - 主对话记忆：按 channel_key 的 project 段分片，外部 agent 通过 MCP 读写；
 * - AIDash 自己的记忆：全局一篇，只给内部 AI 能力用，汇报完成后自动学习更新。
 *
 * 用判别联合而不是魔法字符串，是为了让“当前选中的是哪一种”在类型上就成立，
 * 避免把 AIDash 记忆当成 project 去查、或在右侧渲染错面板。
 */
type Selection = { kind: 'assistant' } | { kind: 'project'; project: string };

/**
 * 记忆 Tab。
 *
 * 为什么按“主对话（project）”而不是按通道列：
 * AGENTS §3.4 规定记忆的归属是 channel_key 的第二段，同一个主对话下的多个话题通道
 * 共用一份约束。用户在这里看到的是“项目记忆”，右侧会列出共用它的通道，避免误以为
 * 每条通道各有一份、改了一条另一条不会生效。
 *
 * 为什么列表里也显示还没写记忆的项目：
 * 只列 project_memory 会漏掉“通道刚建好、agent 还没写”的情况，用户会以为项目不存在；
 * 空记忆不是错误状态，点进去写就行。
 */
export function MemoryPage(): ReactElement {
  const { channels, currentChannelKey, currentProject, refreshNonce } = useApp();
  const notify = useToast().notify;
  const projects = useAsync<MemoryProjectView[]>(() => listMemoryProjects(), [refreshNonce]);
  // 默认“最近修改”：用户最常回到刚整理过的项目；另外两种排序用于按名字找/按规模比。
  const [sort, setSort] = useState<MemorySortKey>('updated');

  // 初始选中优先级：显式主对话 > 当前通道的 project 段 > 上次打开的条目（含 AIDash 记忆）。
  // 为什么“当前通道”排在“上次打开”之前：用户从任务树点进某个通道再切到记忆页，
  // 期望看到的是那个项目的记忆，而不是上一次随手点开的另一条。
  // 反过来，没有选中任何通道（“全部通道”）时沿用上次的条目，AIDash 记忆就能一直保留。
  const initialSelection = useMemo<Selection | null>(() => {
    const stored = window.sessionStorage.getItem(SELECTED_STORAGE_KEY) ?? '';
    const fromChannel = currentChannelKey.split('/')[1] ?? '';
    if (currentProject) return { kind: 'project', project: currentProject };
    if (fromChannel) return { kind: 'project', project: fromChannel };
    if (stored === ASSISTANT_STORAGE_VALUE) return { kind: 'assistant' };
    if (stored.startsWith('project:')) {
      return { kind: 'project', project: stored.slice('project:'.length) };
    }
    return null;
  }, [currentProject, currentChannelKey]);

  const [selection, setSelection] = useState<Selection | null>(initialSelection);
  const [newProject, setNewProject] = useState('');
  // 归纳完成或切项目时用它强制重挂记忆面板：归纳直接改了服务端正文，
  // 面板内部只监听 project，不重挂会继续显示旧版本，用户以为没生效。
  const [memoryNonce, setMemoryNonce] = useState(0);

  // 侧栏需要 AIDash 记忆的行数与修改时间；正文也一并返回（上限 64,000 字符），
  // 面板编辑后靠 nonce 重新拉一次，保证“刚保存”与列表显示一致。
  const assistant = useAsync<AssistantMemoryView>(
    () => getAssistantMemory(),
    [refreshNonce, memoryNonce],
  );

  // 首次列表回来时自动选中第一条，避免右侧一片空白。
  // 只在“当前没有选中”时做，用户手动点选/新建后不抢焦点。
  useEffect(() => {
    if (selection) return;
    const first = projects.data?.[0]?.project;
    if (first) {
      setSelection({ kind: 'project', project: first });
      window.sessionStorage.setItem(SELECTED_STORAGE_KEY, `project:${first}`);
    }
  }, [projects.data, selection]);

  const chooseProject = (project: string): void => {
    setSelection({ kind: 'project', project });
    window.sessionStorage.setItem(SELECTED_STORAGE_KEY, `project:${project}`);
  };

  const chooseAssistant = (): void => {
    setSelection({ kind: 'assistant' });
    window.sessionStorage.setItem(SELECTED_STORAGE_KEY, ASSISTANT_STORAGE_VALUE);
  };

  const openNew = (): void => {
    const name = newProject.trim();
    if (!name) return;
    chooseProject(name);
    setNewProject('');
  };

  const selectedProject = selection?.kind === 'project' ? selection.project : '';

  // 通道列表来自全局通道树（默认已加载活跃通道），用于解释“这份记忆被谁共用”。
  const sharedChannels = useMemo(
    () => channels.filter((channel) => (channel.project?.trim() ?? '') === selectedProject),
    [channels, selectedProject],
  );

  // 排序是纯函数，useMemo 只是避免每次输入框变化都重排整张列表。
  const sortedProjects = useMemo(
    () => sortMemoryProjects(projects.data ?? [], sort),
    [projects.data, sort],
  );

  /**
   * 下载某个主对话的整份记忆。
   *
   * 列表接口只回元数据（行数/更新时间），正文要按 project 单独拉；
   * 这样记忆再多也不会在列表首屏把所有正文传一遍。
   */
  const downloadMemory = async (project: MemoryProjectView): Promise<void> => {
    if (!project.has_memory) {
      notify('error', '这个主对话还没有记忆内容，无法下载。');
      return;
    }
    try {
      const memory = await getProjectMemory(project.project);
      if (!memory.content_md.trim()) {
        notify('error', '记忆正文为空，暂时不能下载。');
        return;
      }
      downloadMarkdown(`${memoryDisplayName(project)}-记忆`, memory.content_md);
      notify('success', '已开始下载 Markdown');
    } catch (cause) {
      notify('error', `下载失败：${describeError(cause)}`);
    }
  };

  /** AIDash 记忆同样支持下载：用户要能把它带走做备份或对比。 */
  const downloadAssistant = async (): Promise<void> => {
    if (!assistant.data?.exists) {
      notify('error', 'AIDash 还没有自己的记忆，无法下载。');
      return;
    }
    try {
      // 重新拉一次正文，而不是用侧栏缓存：刚保存/刚学习完时缓存可能还是旧的。
      const memory = await getAssistantMemory();
      if (!memory.content_md.trim()) {
        notify('error', '记忆正文为空，暂时不能下载。');
        return;
      }
      downloadMarkdown('AIDash-记忆', memory.content_md);
      notify('success', '已开始下载 Markdown');
    } catch (cause) {
      notify('error', `下载失败：${describeError(cause)}`);
    }
  };

  return (
    <div className="page memory-page">
      <header className="page-header">
        <div>
          <h1>记忆</h1>
          <p className="muted">
            两种记忆共用这一页：主对话记忆按 project 共享、外部 agent 可读写；
            AIDash 自己的记忆全局一份、只供内部 AI 能力使用。
          </p>
        </div>
        <button type="button" className="btn btn-small" onClick={projects.reload}>
          刷新
        </button>
      </header>

      {projects.loading && !projects.data ? <Loading label="加载记忆列表…" /> : null}
      {projects.error ? (
        <ErrorBox message={`记忆列表加载失败：${projects.error}`} onRetry={projects.reload} />
      ) : null}

      <div className="memory-layout">
        <aside className="panel memory-sidebar" aria-label="记忆列表">
          <header className="panel-header">
            <h2>记忆</h2>
            <span className="muted small">{projects.data?.length ?? 0} 个主对话</span>
          </header>

          {/*
            AIDash 记忆固定置顶、不参与主对话排序：它不是“某个项目的记忆”，
            混进按修改时间排序的列表里会让用户以为它属于某个 project。
          */}
          <ul className="memory-project-list memory-assistant-list">
            <li className="memory-project-row">
              <button
                type="button"
                className={
                  selection?.kind === 'assistant'
                    ? 'memory-project-item active'
                    : 'memory-project-item'
                }
                aria-current={selection?.kind === 'assistant' ? 'true' : undefined}
                onClick={chooseAssistant}
              >
                <span className="memory-project-head">
                  <strong>AIDash 自己的记忆</strong>
                  <span className="badge">内置</span>
                </span>
                <span className="muted small">
                  {assistant.data?.exists ? `${assistant.data.line_count} 行` : '还没有记忆'}
                  {' · '}
                  汇报后自动学习
                </span>
                <span
                  className="muted small"
                  title={
                    assistant.data?.updated_at
                      ? `${formatRelative(assistant.data.updated_at)}更新 · ${formatAbsolute(assistant.data.updated_at)}`
                      : undefined
                  }
                >
                  {assistant.data?.updated_at
                    ? `修改于 ${formatStamp(assistant.data.updated_at)}`
                    : '尚未记录'}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost memory-project-download"
                disabled={!assistant.data?.exists}
                title={
                  assistant.data?.exists
                    ? '下载 AIDash 自己的记忆 Markdown'
                    : 'AIDash 还没有自己的记忆'
                }
                onClick={() => void downloadAssistant()}
              >
                下载
              </button>
            </li>
          </ul>

          <div className="memory-sidebar-divider" role="separator" />

          <div className="memory-sidebar-tools">
            <label className="muted small" htmlFor="memory-sort">
              排序
            </label>
            <select
              id="memory-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as MemorySortKey)}
            >
              <option value="updated">最近修改</option>
              <option value="name">名称</option>
              <option value="lines">行数</option>
            </select>
          </div>

          {projects.data && projects.data.length === 0 ? (
            <p className="muted small">
              还没有主对话。agent 用 `host/project/topic` 发卡后，project 段会自动出现在这里。
            </p>
          ) : null}

          <ul className="memory-project-list">
            {sortedProjects.map((project) => {
              const active =
                selection?.kind === 'project' && project.project === selection.project;
              return (
                <li key={project.project} className="memory-project-row">
                  <button
                    type="button"
                    className={active ? 'memory-project-item active' : 'memory-project-item'}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => chooseProject(project.project)}
                  >
                    <span className="memory-project-head">
                      {/* 有别名时优先显示人话名称；原始 project 单独一行，避免用户不知道记忆存在哪个 key 下。 */}
                      <strong>{project.alias?.trim() || project.project}</strong>
                      {project.has_memory ? (
                        <span className="badge">v{project.version}</span>
                      ) : (
                        <span className="badge badge-leftover">未写</span>
                      )}
                    </span>
                    {project.alias?.trim() ? (
                      <span className="muted small mono">{project.project}</span>
                    ) : null}
                    <span className="muted small">
                      {project.has_memory ? `${project.line_count} 行` : '还没有记忆'}
                      {' · '}
                      {project.channel_count} 通道
                      {project.active_channel_count !== project.channel_count
                        ? `（活跃 ${project.active_channel_count}）`
                        : ''}
                    </span>
                    <span
                      className="muted small"
                      title={
                        project.updated_at
                          ? `${formatRelative(project.updated_at)}更新 · ${formatAbsolute(project.updated_at)}`
                          : undefined
                      }
                    >
                      {project.updated_at
                        ? `修改于 ${formatStamp(project.updated_at)}`
                        : '尚未记录'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-ghost memory-project-download"
                    disabled={!project.has_memory}
                    title={
                      project.has_memory
                        ? `下载「${memoryDisplayName(project)}」的记忆 Markdown`
                        : '这个主对话还没有记忆内容'
                    }
                    onClick={() => void downloadMemory(project)}
                  >
                    下载
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="memory-new">
            <label className="muted small" htmlFor="memory-new-project">
              打开或新建主对话记忆
            </label>
            <div className="inline">
              <input
                id="memory-new-project"
                className="input"
                value={newProject}
                placeholder="project，例如 myproj"
                onChange={(event) => setNewProject(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') openNew();
                }}
              />
              <button
                type="button"
                className="btn btn-small"
                disabled={!newProject.trim()}
                onClick={openNew}
              >
                打开
              </button>
            </div>
            <p className="muted small">
              记忆按 project 段存储；这里填的是 channel_key 的第二段，不是完整 key。
            </p>
          </div>
        </aside>

        <main className="memory-main">
          {selection?.kind === 'assistant' ? (
            <>
              <AssistantMemoryPanel
                key={`assistant-${memoryNonce}`}
                onChanged={() => setMemoryNonce((value) => value + 1)}
              />
              <section className="panel" aria-label="AIDash 记忆的使用方式">
                <header className="panel-header">
                  <h2>这份记忆是怎么用的</h2>
                </header>
                <ul className="memory-assistant-notes">
                  <li>
                    每次调用模型（卡片分析、知识库建议、记忆归纳、汇报生成）时，
                    这份记忆会追加到系统提示词末尾，作为历史经验参考。
                  </li>
                  <li>
                    每次汇报批次成功完成后，系统会自动从中提炼最多 3 条经验并去重追加；
                    失败或取消的批次不会写入。
                  </li>
                  <li>
                    它不通过 MCP 暴露，外部 agent 读不到也改不了；
                    主对话记忆请到左侧对应的 project 下编辑。
                  </li>
                </ul>
              </section>
            </>
          ) : selectedProject ? (
            <>
              <ProjectMemoryPanel key={`${selectedProject}-${memoryNonce}`} project={selectedProject} />
              <MemoryDigestPanel
                project={selectedProject}
                onChanged={() => {
                  setMemoryNonce((value) => value + 1);
                  projects.reload();
                }}
              />
              <section className="panel" aria-label={`共用记忆的通道 ${selectedProject}`}>
                <header className="panel-header">
                  <h2>共用这份记忆的通道</h2>
                  <span className="muted small">{sharedChannels.length} 条活跃通道</span>
                </header>
                {sharedChannels.length === 0 ? (
                  <p className="muted small">
                    当前列表里没有该主对话下的活跃通道；通道可能已归档，记忆仍会保留。
                  </p>
                ) : (
                  <ul className="memory-channel-list">
                    {sharedChannels.map((channel) => (
                      <li key={channel.id}>
                        <a
                          className="inline-link"
                          href={`#/c/${encodeURIComponent(channel.channel_key)}`}
                        >
                          {channel.alias?.trim() ||
                            channel.topic?.trim() ||
                            channel.title?.trim() ||
                            channel.channel_key}
                        </a>
                        <span className="mono muted small">{channel.channel_key}</span>
                        <span className="muted small">
                          {channel.task_count ?? 0} 任务 · {channel.open_task_count ?? 0} 未结束
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <EmptyState
              title="选择一份记忆"
              hint="左侧点一个主对话查看/编辑项目记忆，或点“AIDash 自己的记忆”查看工具经验。"
            />
          )}
        </main>
      </div>
    </div>
  );
}
