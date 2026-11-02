import { useState } from 'react';
import type { ReactElement } from 'react';
import { getCard } from '../api/endpoints';
import { useAsync } from '../hooks/useAsync';
import { shortId } from '../lib/format';
import { CardTypeBadge } from './Badge';
import { CardDetailInline } from './CardDetailInline';
import { ErrorBox, Loading } from './Feedback';
import { MarkdownInline } from './Markdown';

/**
 * 只有卡片 ID（例如任务的 evidence_ids）时的内联展开器。
 *
 * 卡片正文按需加载：任务详情里可能列了多张证据卡，但用户通常只看其中一张，
 * 打开任务就把每张卡的全文都拉回来没有必要。收起状态下只显示“卡片 cd_xxx”，
 * 第一次展开才发 GET /cards/{id}。
 *
 * 数据完整加载后交给 CardDetailInline，与信息流里的展开体是同一套内容，
 * 避免“从任务信息流点开的卡”和“从完成证据点开的卡”行为不一致。
 */
export function CardExpander({ cardId }: { cardId: string }): ReactElement {
  const [open, setOpen] = useState(false);
  // open=false 时 useAsync 不发请求；每次重新展开都会再拉一次，
  // 保证看到的是最新状态（卡片可能在别处被回答/归档）。
  const { data, loading, error, reload } = useAsync(
    () => getCard(cardId),
    [cardId],
    open,
  );
  // useAsync 会保留上一张卡的数据；用 id 校验避免切任务时短暂显示旧内容。
  const card = data && data.id === cardId ? data : null;
  const detailId = `card-expander-${cardId}`;

  return (
    <article className={open ? 'card-expander open' : 'card-expander'}>
      <button
        type="button"
        className="card-expander-head"
        aria-expanded={open}
        aria-controls={detailId}
        title={open ? '收起卡片详情' : '展开卡片详情'}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={open ? 'task-feed-caret open' : 'task-feed-caret'} aria-hidden="true">
          ▸
        </span>
        <span className="card-expander-label">卡片 {shortId(cardId)}</span>
        {card ? (
          <span className="card-expander-title">
            <MarkdownInline source={card.title || card.summary || card.id} />
          </span>
        ) : null}
        <span className="grow" />
        {card ? <CardTypeBadge type={card.type} /> : null}
      </button>

      {open ? (
        <div className="card-expander-body" id={detailId}>
          {loading && !card ? <Loading label="加载卡片…" /> : null}
          {error ? <ErrorBox message={error} onRetry={() => void reload()} /> : null}
          {card ? (
            <CardDetailInline
              card={card}
              onChanged={() => void reload()}
              onCollapse={() => setOpen(false)}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
