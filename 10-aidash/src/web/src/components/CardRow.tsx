import type { KeyboardEvent, ReactElement } from 'react';
import type { CardView } from '../types';
import {
  cardHeadline,
  formatRelative,
  recommendedOption,
  safeHttpUrl,
  truncate,
} from '../lib/format';
import {
  CardStatusBadge,
  CardTypeBadge,
  HandoffStateBadge,
  PriorityBadge,
  ResultBadge,
  SeverityBadge,
} from './Badge';
import { MarkdownInline } from './Markdown';

function activateOnEnter(event: KeyboardEvent<HTMLElement>, action: () => void): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
}

export function QuestionCardRow({
  card,
  selected,
  selectable = false,
  quickBusy = false,
  onToggleSelect,
  onOpen,
  onQuickAnswer,
}: {
  card: CardView;
  selected: boolean;
  selectable?: boolean;
  quickBusy?: boolean;
  onToggleSelect?: (checked: boolean) => void;
  onOpen: () => void;
  onQuickAnswer: (card: CardView, optionId: string, optionLabel: string) => void;
}): ReactElement {
  const recommended = recommendedOption(card);

  return (
    <article
      className={selected ? 'card-row selected' : 'card-row'}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => activateOnEnter(event, onOpen)}
    >
      <div className="card-row-top">
        {selectable ? (
          <label className="check" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={(event) => onToggleSelect?.(event.target.checked)}
            />
            <span className="sr-only">选择卡片</span>
          </label>
        ) : null}
        <CardTypeBadge type={card.type} />
        <PriorityBadge priority={card.priority} />
        <CardStatusBadge status={card.status} />
        {card.blocking ? <span className="badge blocking">阻塞</span> : null}
        <span className="card-title grow">
          <MarkdownInline source={cardHeadline(card)} />
        </span>
        <span className="muted small" title={card.due_at ?? undefined}>
          {card.due_at ? `到期 ${formatRelative(card.due_at)}` : `创建 ${formatRelative(card.created_at)}`}
        </span>
      </div>

      <div className="card-meta">
        <span className="tag">{card.channel_key}</span>
        <span>{card.options.length} 个选项</span>
        {recommended ? (
          <span className="badge recommended">
            推荐：{truncate(recommended.label, 30)}
          </span>
        ) : null}
        {card.enrichment.status !== 'skipped' ? (
          <span className="muted small">增强：{card.enrichment.status}</span>
        ) : null}
      </div>

      {card.background_md ? (
        <p className="excerpt">
          <MarkdownInline source={truncate(card.background_md, 180)} fallback="" />
        </p>
      ) : null}

      <div className="quick-answer" onClick={(event) => event.stopPropagation()}>
        <span className="muted small">快速回答：</span>
        {card.options.slice(0, 3).map((option) => (
          <button
            key={option.id}
            type="button"
            className="btn btn-small"
            disabled={quickBusy || card.status !== 'open'}
            title={typeof option.recommendation === 'string' ? option.recommendation : undefined}
            onClick={() => onQuickAnswer(card, option.id, option.label)}
          >
            {truncate(option.label, 28)}
          </button>
        ))}
        {card.options.length > 3 ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={onOpen}>
            更多…
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function FeedCardRow({
  card,
  onOpen,
}: {
  card: CardView;
  onOpen: () => void;
}): ReactElement {
  const artifactUrl = safeHttpUrl(card.url);
  const detail =
    card.summary || card.body_md || card.reason || card.detail_md || '';

  return (
    <article
      className="card-row feed-row"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => activateOnEnter(event, onOpen)}
    >
      <div className="card-row-top">
        <CardTypeBadge type={card.type} />
        <PriorityBadge priority={card.priority} />
        <Span severity={card.severity} />
        <span className="card-title grow">
          <MarkdownInline source={cardHeadline(card)} />
        </span>
        <CardStatusBadge status={card.status} />
        <span className="muted small">{formatRelative(card.created_at)}</span>
      </div>

      <div className="card-meta">
        <span className="tag">{card.channel_key}</span>
        {card.type === 'handoff' ? (
          <>
            <span>→ {card.recipient ?? '未指定接收人'}</span>
            <span className="tag">{card.channel_kind ?? '渠道未知'}</span>
            <HandoffStateBadge state={card.handoff_state} />
          </>
        ) : null}
        {card.type === 'status' ? <ResultBadge result={card.result} /> : null}
        {card.type === 'artifact' ? (
          <span className="tag">
            {card.kind ?? 'file'}
            {card.size_bytes !== null ? ` · ${card.size_bytes} B` : ''}
          </span>
        ) : null}
        {card.task_id ? <span className="tag">任务 {card.task_id}</span> : null}
      </div>

      {detail ? (
        <p className="excerpt">
          <MarkdownInline source={truncate(detail, 200)} fallback="" />
        </p>
      ) : null}

      {artifactUrl ? (
        <a
          className="inline-link"
          href={artifactUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          打开产物
        </a>
      ) : null}
    </article>
  );
}

function Span({ severity }: { severity: 'info' | 'warn' | 'critical' | null }): ReactElement | null {
  return <SeverityBadge severity={severity} />;
}
