import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import type { CardView } from '../types';
import { describeError } from '../api/client';
import { listCards, markCardRead } from '../api/endpoints';
import { useAsync } from '../hooks/useAsync';
import { FEED_PAGE_SIZE, toAscendingPage } from '../lib/feed-page';
import { formatAbsolute, formatRelative, truncate } from '../lib/format';
import { openCard } from '../lib/router';
import { CardTypeBadge, PriorityBadge } from './Badge';
import { ErrorBox, Loading } from './Feedback';
import { MarkdownInline } from './Markdown';
import { useToast } from './Toast';

/**
 * 任务详情里的信息流。
 *
 * 为什么信息流必须长在任务详情里：
 *   一张 info/status/artifact 卡如果只在决策台出现，用户看到的是“一条消息”，
 *   不知道它属于哪件事、之前发生过什么。挂到任务下之后，消息和任务树是同一份上下文。
 *
 * 为什么“滚到哪条就消哪条”，而不是打开任务即全部已读：
 *   用户明确要求“翻到下方一条条消除未读”。一次打开就把所有红点清掉，
 *   等于把“还没看的”也标成看过，红点失去意义。
 *   这里用 IntersectionObserver 观察每条未读卡的可见比例（60%），
 *   真正进入视口才发一次已读请求；快速滚过、没停下来的条目不会被误标。
 *
 * 为什么已读状态以服务端返回的 read_at 为准：
 *   本地 localStorage 换浏览器/清缓存会复活红点；服务端已读才能跨设备一致。
 *   本组件只在请求成功后把卡片加入本地 readIds，失败时仍保持未读，下次再试。
 */
export function TaskFeed({
  taskId,
  rootRef,
  onUnreadChange,
  reloadNonce = 0,
}: {
  taskId: string;
  /** 任务详情卡自身就是滚动容器；IntersectionObserver 必须以它为 root。 */
  rootRef: RefObject<HTMLElement | null>;
  /** 未读数变化时通知任务树更新红点，避免为了一个数字整树重拉。 */
  onUnreadChange?: (taskId: string, unreadCount: number) => void;
  /** 详情里提交状态事件后递增，用来重新拉取信息流（可能刚新增了证据卡）。 */
  reloadNonce?: number;
}): ReactElement {
  const notify = useToast().notify;
  const feedRef = useRef<HTMLDivElement | null>(null);
  // 已加载但随后被本地标记已读的 card_id。服务端返回的 read_at 仍保留在 data 里，
  // 两者合并判断才能让“刚滚到的那条”立刻从红点消失，而不用等下一次整页刷新。
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());
  const processingRef = useRef<Set<string>>(new Set());
  const onUnreadChangeRef = useRef(onUnreadChange);
  onUnreadChangeRef.current = onUnreadChange;

  const { data, loading, error, reload } = useAsync(
    () =>
      listCards({
        task_id: taskId,
        // 任务信息流是“详情路径”，这里必须保留完整正文；
        // 不能读 preview_md，否则用户点开任务只能看到被截断的摘要。
        include_body: true,
        page_size: FEED_PAGE_SIZE,
        sort: 'created_at',
        // 先按倒序取“最近 N 条”，再由 toAscendingPage 反转成正序渲染。
        // 若这里仍用 asc，拿到的是最旧 N 条：任务卡超过 N 张后新消息永远看不到。
        order: 'desc',
      }),
    [taskId, reloadNonce],
  );

  useEffect(() => {
    // 切任务时清空本地已读集合与处理中集合，避免把 A 任务的已读状态带到 B 任务。
    setReadIds(new Set());
    processingRef.current = new Set();
  }, [taskId]);

  const isRead = useCallback(
    (card: CardView): boolean => card.read_at !== null || readIds.has(card.id),
    [readIds],
  );

  // data.items 是倒序（最新在前）；反转后才是“越往下越新”的阅读顺序。
  // 是否截断由服务端 total 与实收条数比较得出，不能只看是否刚好取满一页。
  // limit 用响应里的实际 page_size 而不是请求常量：服务端上限可配置（20~500），
  // 否则“仅显示最近 200 条”可能和真正加载到的条数对不上。
  const feed = data
    ? toAscendingPage(data.items, data.total, data.page_size || FEED_PAGE_SIZE)
    : null;
  const cards = feed?.items ?? [];
  const unreadCount = data ? cards.filter((card) => !isRead(card)).length : 0;

  // 未读数只在数据真正加载后上报；加载中上报 0 会把任务树红点提前抹掉。
  useEffect(() => {
    if (!data) return;
    onUnreadChangeRef.current?.(taskId, unreadCount);
  }, [data, taskId, unreadCount]);

  const markRead = useCallback(
    async (cardId: string): Promise<void> => {
      if (processingRef.current.has(cardId)) return;
      processingRef.current.add(cardId);
      try {
        await markCardRead(cardId);
        setReadIds((prev) => {
          const next = new Set(prev);
          next.add(cardId);
          return next;
        });
      } catch (cause) {
        // 失败后把 id 从“处理中”移出，卡片保持未读；
        // 下次打开任务会重新观察并重试，而不是在本地假装已经读过。
        processingRef.current.delete(cardId);
        notify('error', `标记已读失败：${describeError(cause)}`);
      }
    },
    [notify],
  );

  useEffect(() => {
    const root = rootRef.current;
    const container = feedRef.current;
    if (!root || !container || !data) return undefined;

    // 只观察当前仍未读的条目。threshold 0.6 表示“大部分露出来了”才算看到：
    // 只有卡片边缘刚探进视口，不应该算读过。
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const cardId = (entry.target as HTMLElement).dataset.cardId;
          if (!cardId) continue;
          // 先取消观察再发请求：同一张卡在请求飞行期间反复进出视口，
          // 不应该产生一串重复请求（虽然服务端幂等，但没必要）。
          observer.unobserve(entry.target);
          void markRead(cardId);
        }
      },
      { root, threshold: 0.6 },
    );

    container
      .querySelectorAll<HTMLElement>('[data-unread="true"]')
      .forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [data, readIds, rootRef, markRead]);

  return (
    <section className="task-feed" aria-label="任务信息流" ref={feedRef}>
      <div className="panel-header">
        <h4>
          任务信息流{' '}
          <span className="muted small">
            {data ? `${cards.length} 条` : ''}
            {data && unreadCount > 0 ? ` · ${unreadCount} 条未读` : ''}
          </span>
        </h4>
        <button type="button" className="btn btn-small btn-ghost" onClick={reload}>
          刷新
        </button>
      </div>

      <p className="muted small">
        滚动到卡片即自动标记已读；未读只在任务里消除，决策台只保留待拍板的决策卡。
      </p>

      {/* 窗口被填满且服务端还有更早的卡时，必须明说“这里不是全部”，
          否则用户会以为任务只有这些消息。 */}
      {feed?.truncated ? (
        <p className="muted small">
          共 {feed.total} 条，仅显示最近 {feed.limit} 条
        </p>
      ) : null}

      {loading && !data ? <Loading label="加载信息流…" /> : null}
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}

      {data && cards.length === 0 ? (
        <p className="muted small">这个任务下还没有信息卡。</p>
      ) : null}

      <div className="task-feed-list">
        {cards.map((card) => {
          const unread = !isRead(card);
          return (
            <article
              key={card.id}
              className={unread ? 'task-feed-item unread' : 'task-feed-item'}
              data-card-id={card.id}
              data-unread={unread ? 'true' : 'false'}
            >
              <button
                type="button"
                className="task-feed-main"
                title="打开卡片详情"
                onClick={() => openCard(card.id)}
              >
                <span className="task-feed-head">
                  <CardTypeBadge type={card.type} />
                  <PriorityBadge priority={card.priority} />
                  {unread ? <span className="task-feed-unread">未读</span> : null}
                  <span className="grow" />
                  <time title={formatAbsolute(card.created_at)}>
                    {formatRelative(card.created_at)}
                  </time>
                </span>
                <span className="task-feed-title">
                  <MarkdownInline source={card.title || card.summary || card.id} />
                </span>
                {feedExcerpt(card) ? (
                  <span className="task-feed-excerpt">{feedExcerpt(card)}</span>
                ) : null}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * 信息流摘要：按类型挑一段最能说明“这条消息说了什么”的正文。
 *
 * 不直接渲染完整 Markdown：详情里已经有卡片抽屉，信息流只负责让人快速判断
 * “要不要点开”。截断后也不再解析 Markdown，避免半截链接/代码块渲染错位。
 */
function feedExcerpt(card: CardView): string {
  const raw =
    card.summary ||
    card.body_md ||
    card.decision_md ||
    card.detail_md ||
    card.message_md ||
    '';
  return truncate(raw.replace(/\s+/g, ' ').trim(), 160);
}
