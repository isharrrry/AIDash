import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { CardView, ChannelView, Page } from '../types';
import { describeError } from '../api/client';
import {
  answerCard,
  archiveChannel,
  listCards,
  listChannels,
  updateChannelAlias,
} from '../api/endpoints';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import { useDebounced } from '../hooks/useDebounced';
import { usePolling } from '../hooks/usePolling';
import { formatAbsolute, formatRelative } from '../lib/format';
import { navigate, openCard } from '../lib/router';
import { FeedCardRow, QuestionCardRow } from '../components/CardRow';
import { EmptyState, ErrorBox, Loading } from '../components/Feedback';
import { DEFAULT_CARD_FILTERS, FilterBar } from '../components/FilterBar';
import type { CardFilters } from '../components/FilterBar';
import { Pagination } from '../components/Pagination';
import { ProjectMemoryPanel } from '../components/ProjectMemoryPanel';
import { TaskBoard } from '../components/TaskBoard';
import { useToast } from '../components/Toast';

/**
 * 通道详情页（路由 `#/c/{channel_key}`）。
 *
 * 设计说明里的 SCR-04 是“通道视图”，任务要求把它当作 SCR-02 通道页实现；
 * 页面同时承担通道元信息、卡片流和该通道的任务树，避免用户在两个页面来回跳。
 */
export function ChannelPage({ channelKey }: { channelKey: string }): ReactElement {
  const { refreshNonce, reloadChannels, setCurrentChannelKey, setCurrentProject } = useApp();
  const notify = useToast().notify;

  const [filters, setFilters] = useState<CardFilters>(DEFAULT_CARD_FILTERS);
  const [page, setPage] = useState(1);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  // 别名编辑是就地小表单：不弹窗，避免用户改一个名字还要跨模态框确认。
  const [aliasEditing, setAliasEditing] = useState(false);
  const [aliasDraft, setAliasDraft] = useState('');
  const [savingAlias, setSavingAlias] = useState(false);
  const debouncedQ = useDebounced(filters.q, 300);

  const statusKey = filters.statuses.join(',');
  const priorityKey = filters.priorities.join(',');
  const typeKey = filters.types.join(',');

  // 通道页可能直接深链到已归档通道，因此包含归档并做精确 key 匹配。
  const channelState = useAsync<ChannelView | null>(
    async () => {
      const result = await listChannels({
        q: channelKey,
        include_archived: true,
        page_size: 50,
      });
      return result.items.find((item) => item.channel_key === channelKey) ?? null;
    },
    [channelKey, refreshNonce],
  );

  const cards = useAsync<Page<CardView>>(
    () =>
      listCards({
        channel_key: channelKey,
        types: filters.types,
        statuses: filters.statuses,
        priorities: filters.priorities,
        include_archived: filters.includeArchived,
        q: debouncedQ,
        page,
        page_size: filters.pageSize,
        sort: filters.sort,
        order: filters.order,
      }),
    [
      refreshNonce,
      channelKey,
      typeKey,
      statusKey,
      priorityKey,
      debouncedQ,
      page,
      filters.pageSize,
      filters.sort,
      filters.order,
      filters.includeArchived,
    ],
  );

  // 进入通道页时把全局“当前通道”同步过来，返回决策台时筛选保持一致。
  useEffect(() => {
    setCurrentChannelKey(channelKey);
  }, [channelKey, setCurrentChannelKey]);

  useEffect(() => {
    setPage(1);
  }, [typeKey, statusKey, priorityKey, debouncedQ, filters.pageSize, filters.sort, filters.order, filters.includeArchived]);

  // 切换通道时清掉别名编辑态：否则上一条通道的草稿会被带到下一条，用户会误以为已保存。
  useEffect(() => {
    setAliasEditing(false);
    setAliasDraft('');
  }, [channelKey]);

  const reloadAll = (): void => {
    channelState.reload();
    cards.reload();
    reloadChannels();
  };

  usePolling(reloadAll, 30000);

  const quickAnswer = async (
    card: CardView,
    optionId: string,
    optionLabel: string,
  ): Promise<void> => {
    if (!window.confirm(`确认以「${optionLabel}」回答这张决策卡？`)) return;
    setQuickBusy(card.id);
    try {
      await answerCard(card.id, { option_id: optionId });
      notify('success', `已回答：${optionLabel}`);
      reloadAll();
    } catch (cause) {
      notify('error', `回答失败：${describeError(cause)}`);
    } finally {
      setQuickBusy(null);
    }
  };

  const toggleArchive = async (): Promise<void> => {
    const channel = channelState.data;
    if (!channel) return;
    const next = channel.status === 'archived' ? 'active' : 'archived';
    const verb = next === 'archived' ? '归档' : '恢复';
    if (!window.confirm(`确认${verb}通道「${channel.channel_key}」？`)) return;
    setArchiving(true);
    try {
      await archiveChannel(channel.id, next);
      notify('success', `通道已${verb}`);
      channelState.reload();
      reloadChannels();
    } catch (cause) {
      notify('error', `${verb}通道失败：${describeError(cause)}`);
    } finally {
      setArchiving(false);
    }
  };

  const saveAlias = async (): Promise<void> => {
    const channel = channelState.data;
    if (!channel) return;
    // 空输入 = 清空别名，展示层会自动回退到 topic/title/channel_key。
    const next = aliasDraft.trim() || null;
    setSavingAlias(true);
    try {
      await updateChannelAlias(channel.id, next);
      notify('success', next ? '别名已更新' : '别名已清空');
      setAliasEditing(false);
      channelState.reload();
      reloadChannels();
    } catch (cause) {
      notify('error', `保存别名失败：${describeError(cause)}`);
    } finally {
      setSavingAlias(false);
    }
  };

  const channel = channelState.data;

  return (
    <div className="page">
      <nav className="breadcrumb">
        <a className="inline-link" href="#/">
          决策台
        </a>
        <span>/</span>
        <span>{channelKey}</span>
      </nav>

      <header className="page-header">
        <div>
          <h1>{channel?.alias?.trim() || channel?.name || channel?.title || channelKey}</h1>
          <p className="muted">
            <span className="tag">{channelKey}</span>
            {channel ? (
              <>
                {' · '}
                <span className={`badge channel-${channel.status}`}>
                  {channel.status === 'archived' ? '已归档' : '活跃'}
                </span>
                {' · '}
                {channel.card_count} 张卡 · 最后活动 {formatRelative(channel.last_active_at)}
                {' · '}创建 {formatAbsolute(channel.created_at)}
              </>
            ) : channelState.loading ? (
              ' 通道信息加载中…'
            ) : (
              ' 通道信息未找到'
            )}
          </p>
          {channel ? (
            // 通道页把“主对话 / 子对话 / 工作路径 / 任务量”单独一行，
            // 是为了让用户不必回决策台就能确认“这条对话在改哪份代码、还有多少活”。
            <p className="muted small">
              主对话 <strong>{channel.project?.trim() || '未分组'}</strong>
              {channel.topic ? ` · 子对话 ${channel.topic}` : ''}
              {' · '}工作路径{' '}
              <span className="mono" title={channel.workdir ?? undefined}>
                {channel.workdir || '未登记工作路径'}
              </span>
              {' · '}任务 {channel.task_count ?? 0}（未结束 {channel.open_task_count ?? 0}）
            </p>
          ) : null}
        </div>
        <div className="inline">
          {channel ? (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => {
                setAliasDraft(channel.alias ?? '');
                setAliasEditing((value) => !value);
              }}
            >
              {aliasEditing ? '收起别名' : '改别名'}
            </button>
          ) : null}
          <button type="button" className="btn btn-small" onClick={reloadAll}>
            刷新
          </button>
          {channel?.project ? (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              title={`回到决策台并只看主对话「${channel.project}」`}
              onClick={() => {
                // 先设主对话（内部会清空单通道筛选），再回决策台；
                // 若留在本页，两个筛选会互相抵消/同时生效，用户会困惑。
                setCurrentProject(channel.project?.trim() ?? '');
                navigate('/');
              }}
            >
              聚焦主对话
            </button>
          ) : null}
          <a className="btn btn-small btn-ghost" href="#/">
            返回决策台
          </a>
          {channel ? (
            <button
              type="button"
              className="btn btn-small"
              disabled={archiving}
              onClick={() => void toggleArchive()}
            >
              {archiving
                ? '处理中…'
                : channel.status === 'archived'
                  ? '恢复通道'
                  : '归档通道'}
            </button>
          ) : null}
        </div>
      </header>

      {/*
        别名是展示层标签，不是身份：改它不会动 channel_key，
        所以在通道页就地编辑，保存后只刷新通道列表，不触发路由跳转。
        上限 200 与服务端 schema 对齐，前端先挡住，避免用户输入一大段才被拒。
      */}
      {aliasEditing && channel ? (
        <form
          className="alias-editor panel"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAlias();
          }}
        >
          <label className="alias-editor-label">
            <span className="muted small">别名（用一句用户能看懂的话描述这条对话在做什么）</span>
            <input
              className="input"
              type="text"
              maxLength={200}
              value={aliasDraft}
              placeholder="例如：修复登录接口 500"
              autoFocus
              onChange={(event) => setAliasDraft(event.target.value)}
            />
          </label>
          <div className="inline">
            <button type="submit" className="btn btn-small" disabled={savingAlias}>
              {savingAlias ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={savingAlias}
              onClick={() => {
                setAliasEditing(false);
                setAliasDraft('');
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={savingAlias || !channel.alias}
              onClick={() => {
                // 清空走同一条保存路径，而不是单独删字段：服务端 PATCH 用 null 表示无别名。
                setAliasDraft('');
                void saveAlias();
              }}
            >
              清空别名
            </button>
          </div>
          <p className="muted small">保存后通道树、任务树和通道页都会优先显示别名；channel_key 不变。</p>
        </form>
      ) : null}

      {/* 记忆按 project（主通道）存，同一主对话下的各个话题页看到的是同一份。 */}
      {channel?.project?.trim() ? (
        <ProjectMemoryPanel project={channel.project.trim()} compact />
      ) : null}

      {channelState.error ? (
        <ErrorBox message={`通道信息加载失败：${channelState.error}`} onRetry={channelState.reload} />
      ) : null}

      <FilterBar
        filters={filters}
        onChange={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
      />

      <section className="panel" aria-label="通道卡片">
        <header className="panel-header">
          <h2>卡片流</h2>
          <span className="muted small">{cards.data?.total ?? 0} 张</span>
        </header>

        {cards.loading && !cards.data ? <Loading label="加载卡片…" /> : null}
        {cards.error ? <ErrorBox message={cards.error} onRetry={cards.reload} /> : null}

        {(cards.data?.items ?? []).map((card) =>
          card.type === 'question' ? (
            <QuestionCardRow
              key={card.id}
              card={card}
              selected={false}
              quickBusy={quickBusy === card.id}
              onOpen={() => openCard(card.id)}
              onQuickAnswer={(target, optionId, label) =>
                void quickAnswer(target, optionId, label)
              }
            />
          ) : (
            <FeedCardRow key={card.id} card={card} onOpen={() => openCard(card.id)} />
          ),
        )}

        {!cards.loading && !cards.error && (cards.data?.items.length ?? 0) === 0 ? (
          <EmptyState
            title="该通道暂无符合条件的卡片"
            hint="可调整类型、状态或关键词筛选，或把“含归档”打开。"
          />
        ) : null}

        {cards.data ? (
          <Pagination
            page={cards.data.page}
            pageSize={cards.data.page_size}
            total={cards.data.total}
            hasMore={cards.data.has_more}
            onChange={setPage}
          />
        ) : null}
      </section>

      <TaskBoard channelKey={channelKey} compact />
    </div>
  );
}
