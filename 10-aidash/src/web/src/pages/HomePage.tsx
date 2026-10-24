import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { CardOption, CardType, CardView, Digest, Page } from '../types';
import { describeError } from '../api/client';
import { answerCard, batchAnswer, getDigest, listCards } from '../api/endpoints';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import { useDebounced } from '../hooks/useDebounced';
import { usePolling } from '../hooks/usePolling';
import { formatRelative, truncate } from '../lib/format';
import { openCard } from '../lib/router';
import { BatchBar } from '../components/BatchBar';
import { CardTypeBadge, PriorityBadge } from '../components/Badge';
import { FeedCardRow, QuestionCardRow } from '../components/CardRow';
import { EmptyState, ErrorBox, Loading } from '../components/Feedback';
import { DEFAULT_CARD_FILTERS, FilterBar } from '../components/FilterBar';
import type { CardFilters } from '../components/FilterBar';
import { Pagination } from '../components/Pagination';
import { useToast } from '../components/Toast';

/**
 * 历史遗留卡的类型范围。
 *
 * 排除 question：没有任务的 question 仍然合法，会继续出现在“待我拍板”队列里。
 * 其余类型从本版起强制挂任务；它们只可能来自旧数据，需要单独入口而不是混进决策队列。
 */
const LEGACY_TYPES: CardType[] = ['info', 'handoff', 'suggestion', 'status', 'artifact'];

/**
 * SCR-01 决策台：摘要条、筛选、待拍板队列、历史未归属卡。
 *
 * 信息流已归到任务详情（用户要求：信息必须挂在任务下，未读在任务里逐条消除）。
 * 决策台只负责“需要拍板的事”，不再承担消息流。
 */
export function HomePage(): ReactElement {
  const { refreshNonce, reloadChannels, currentChannelKey, currentProject } = useApp();
  const notify = useToast().notify;

  const [filters, setFilters] = useState<CardFilters>(DEFAULT_CARD_FILTERS);
  const [queuePage, setQueuePage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const debouncedQ = useDebounced(filters.q, 300);

  const statusKey = filters.statuses.join(',');
  const priorityKey = filters.priorities.join(',');

  // 摘要跟随顶部“当前通道”：筛选通道后，待决策数与 P0/P1 也应是该通道的范围。
  const digest = useAsync<Digest>(
    () => getDigest(currentChannelKey || undefined),
    [refreshNonce, currentChannelKey],
  );

  const queue = useAsync<Page<CardView>>(
    () =>
      listCards({
        channel_key: currentChannelKey || undefined,
        project: currentProject || undefined,
        types: ['question'],
        statuses: filters.statuses,
        priorities: filters.priorities,
        include_archived: filters.includeArchived,
        q: debouncedQ,
        page: queuePage,
        page_size: filters.pageSize,
        sort: filters.sort,
        order: filters.order,
      }),
    [
      refreshNonce,
      currentChannelKey,
      currentProject,
      statusKey,
      priorityKey,
      debouncedQ,
      queuePage,
      filters.pageSize,
      filters.sort,
      filters.order,
      filters.includeArchived,
    ],
  );

  /**
   * 历史未归属卡。
   *
   * 不跟随通道/筛选：它们是升级前的遗留数据，数量应当很少，且用户需要一个
   * 固定入口把它们处理掉（打开后归档或补挂到任务）。跟随筛选会让“换了个筛选就找不到”
   * 变成新的数据黑洞。新卡已经不可能再进入这个列表。
   */
  const legacy = useAsync<Page<CardView>>(
    () =>
      listCards({
        unassigned: true,
        types: LEGACY_TYPES,
        page_size: 50,
        sort: 'created_at',
        order: 'desc',
      }),
    [refreshNonce],
  );

  // 任一筛选变化都把分页重置到第 1 页（设计文档 §2.3 的组合规则）。
  useEffect(() => {
    setQueuePage(1);
    setSelected([]);
  }, [
    currentChannelKey,
    currentProject,
    statusKey,
    priorityKey,
    debouncedQ,
    filters.sort,
    filters.order,
    filters.pageSize,
    filters.includeArchived,
  ]);

  // 队列换页后清掉已不在当前页的选中项，避免批量操作误伤不可见卡片。
  useEffect(() => {
    const visible = new Set((queue.data?.items ?? []).map((card) => card.id));
    setSelected((prev) => {
      const next = prev.filter((id) => visible.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [queue.data]);

  const reloadAll = useCallback(() => {
    digest.reload();
    queue.reload();
    legacy.reload();
    reloadChannels();
  }, [digest.reload, queue.reload, legacy.reload, reloadChannels]);

  // SSE 未实现时的 30 秒轮询兜底；页面不可见时 hook 内部会跳过请求。
  usePolling(() => reloadAll(), 30000);

  const updateFilters = (patch: Partial<CardFilters>): void => {
    setFilters((prev) => ({ ...prev, ...patch }));
  };

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

  const selectedCards = (queue.data?.items ?? []).filter((card) => selected.includes(card.id));
  const commonOptions = commonOptionsFor(selectedCards);

  const batchSubmit = async (optionId: string): Promise<void> => {
    if (selectedCards.length === 0) return;
    const label =
      commonOptions.find((option) => option.id === optionId)?.label ?? optionId;
    if (!window.confirm(`将以「${label}」回答 ${selectedCards.length} 张卡片，确认提交？`)) {
      return;
    }
    setBatchBusy(true);
    try {
      const result = await batchAnswer(
        selectedCards.map((card) => ({ card_id: card.id, answer: { option_id: optionId } })),
      );
      if (result.failure_count > 0) {
        notify(
          'warn',
          `批量回答：成功 ${result.success_count} 张，失败 ${result.failure_count} 张`,
        );
      } else {
        notify('success', `批量回答成功 ${result.success_count} 张`);
      }
      setSelected([]);
      reloadAll();
    } catch (cause) {
      notify('error', `批量回答失败：${describeError(cause)}`);
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>决策台</h1>
          <p className="muted">
            一屏看完等待拍板的事项；过程信息已归到任务详情，未读在任务里逐条消除。
          </p>
        </div>
        <button type="button" className="btn btn-small" onClick={reloadAll}>
          刷新全部
        </button>
      </header>

      <DigestOverview digest={digest.data} loading={digest.loading} error={digest.error} onRetry={digest.reload} />

      {/* 决策台只筛决策卡：类型固定为 question，筛选栏不再提供类型勾选。 */}
      <FilterBar filters={filters} onChange={updateFilters} showTypes={false} />

      <div className="home-grid single">
        <section className="panel" aria-label="决策队列">
          <header className="panel-header">
            <h2>待我拍板</h2>
            <span className="muted small">{queue.data?.total ?? 0} 张 question 卡</span>
          </header>

          {queue.loading && !queue.data ? <Loading label="加载决策队列…" /> : null}
          {queue.error ? <ErrorBox message={queue.error} onRetry={queue.reload} /> : null}

          {(queue.data?.items ?? []).map((card) => (
            <QuestionCardRow
              key={card.id}
              card={card}
              selected={selected.includes(card.id)}
              selectable
              quickBusy={quickBusy === card.id}
              onToggleSelect={(checked) =>
                setSelected((prev) =>
                  checked ? [...prev, card.id] : prev.filter((id) => id !== card.id),
                )
              }
              onOpen={() => openCard(card.id)}
              onQuickAnswer={(target, optionId, label) =>
                void quickAnswer(target, optionId, label)
              }
            />
          ))}

          {!queue.loading && !queue.error && (queue.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="没有待决策的卡片"
              hint="harness 发出 question 卡后会出现在这里；可用右上角通道树切换范围，或清空状态筛选。"
            />
          ) : null}

          {queue.data ? (
            <Pagination
              page={queue.data.page}
              pageSize={queue.data.page_size}
              total={queue.data.total}
              hasMore={queue.data.has_more}
              onChange={setQueuePage}
            />
          ) : null}
        </section>

      </div>

      {/*
        历史未归属区默认折叠，且不参与任何筛选：
        这些是升级前的存量数据，不是日常信息流。放固定入口是为了不丢数据，
        而不是把决策台重新变成第二个消息列表。
      */}
      {legacy.data && legacy.data.total > 0 ? (
        <section className="panel legacy-panel" aria-label="历史未归属消息">
          <details>
            <summary>
              <strong>历史未归属消息（{legacy.data.total}）</strong>
              <span className="muted small"> 升级前产生的无任务卡；新卡已强制挂任务</span>
            </summary>
            <p className="muted small">
              这些卡没有对应任务，无法进入任务信息流。点开卡片可以归档；
              需要保留的内容建议补建任务后重新记录到任务下。
            </p>
            {legacy.data.items.map((card) => (
              <FeedCardRow key={card.id} card={card} onOpen={() => openCard(card.id)} />
            ))}
            {legacy.data.total > legacy.data.items.length ? (
              <p className="muted small">
                仅显示最近 {legacy.data.items.length} 条，共 {legacy.data.total} 条。
              </p>
            ) : null}
          </details>
        </section>
      ) : null}

      <BatchBar
        selectedCount={selectedCards.length}
        commonOptions={commonOptions}
        busy={batchBusy}
        onSubmit={(optionId) => void batchSubmit(optionId)}
        onClear={() => setSelected([])}
      />
    </div>
  );
}

function commonOptionsFor(cards: CardView[]): CardOption[] {
  if (cards.length === 0) return [];
  const first = cards[0];
  if (!first) return [];
  return first.options.filter((option) =>
    cards.every((card) => card.options.some((candidate) => candidate.id === option.id)),
  );
}

function DigestOverview({
  digest,
  loading,
  error,
  onRetry,
}: {
  digest: Digest | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}): ReactElement {
  if (error) return <ErrorBox message={`摘要加载失败：${error}`} onRetry={onRetry} />;
  if (loading && !digest) return <Loading label="加载摘要…" />;

  const p0 = digest?.p0_cards ?? [];
  const p1 = digest?.p1_cards ?? [];

  return (
    <section className="digest" aria-label="摘要">
      <div className="stat">
        <span className="stat-value">{digest?.pending_decisions ?? '—'}</span>
        <span className="stat-label">待决策</span>
      </div>
      <div className="stat">
        <span className="stat-value">{digest?.channels_active ?? '—'}</span>
        <span className="stat-label">活跃通道</span>
      </div>
      <div className="stat">
        <span className="stat-value">{p0.length}</span>
        <span className="stat-label">P0 卡</span>
      </div>
      <div className="stat">
        <span className="stat-value">{p1.length}</span>
        <span className="stat-label">P1 卡</span>
      </div>

      <div className="digest-list">
        {[...p0, ...p1].length === 0 ? (
          <p className="muted small">当前没有 P0/P1 卡片。</p>
        ) : (
          [...p0, ...p1].slice(0, 6).map((card) => (
            <button
              key={card.id}
              type="button"
              className="digest-card"
              onClick={() => openCard(card.id)}
            >
              <CardTypeBadge type={card.type} />
              <PriorityBadge priority={card.priority} />
              <span className="grow">{truncate(card.title || card.summary || card.id, 48)}</span>
              <span className="muted small">{formatRelative(card.created_at)}</span>
            </button>
          ))
        )}
        <p className="muted small">
          最近状态卡 {digest?.recent_status.length ?? 0} 张 · 最近建议卡{' '}
          {digest?.recent_suggestions.length ?? 0} 张
          {digest?.generated_at ? ` · 生成于 ${formatRelative(digest.generated_at)}` : ''}
        </p>
      </div>
    </section>
  );
}
