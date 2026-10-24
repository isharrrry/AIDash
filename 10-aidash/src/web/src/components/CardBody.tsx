import type { ReactElement } from 'react';
import type { CardView, HandoffState } from '../types';
import {
  formatAbsolute,
  formatBytes,
  HANDOFF_STATE_LABELS,
  safeHttpUrl,
} from '../lib/format';
import {
  CardStatusBadge,
  CardTypeBadge,
  HandoffStateBadge,
  PriorityBadge,
  ResultBadge,
  SeverityBadge,
} from './Badge';
import { Markdown } from './Markdown';

const HANDOFF_STATES: HandoffState[] = ['draft', 'copied', 'sent', 'ack'];

/** SCR-02 R2：按卡片类型切换正文，六种类型互斥。 */
export function CardBody({
  card,
  onCopyHandoff,
  onHandoffState,
  handoffBusy,
}: {
  card: CardView;
  onCopyHandoff: () => void;
  onHandoffState: (state: HandoffState) => void;
  handoffBusy: boolean;
}): ReactElement {
  return (
    <div className="drawer-section">
      <div className="drawer-badges">
        <CardTypeBadge type={card.type} />
        <PriorityBadge priority={card.priority} />
        <CardStatusBadge status={card.status} />
        <SeverityBadge severity={card.severity} />
        {card.blocking ? <span className="badge blocking">阻塞</span> : null}
        {card.due_at ? <span className="tag">到期 {formatAbsolute(card.due_at)}</span> : null}
      </div>

      <h2 className="drawer-title">{card.title || '（无标题）'}</h2>
      <p className="muted small">
        通道{' '}
        <a className="inline-link" href={`#/c/${encodeURIComponent(card.channel_key)}`}>
          {card.channel_key}
        </a>
        {' · '}创建 {formatAbsolute(card.created_at)}
        {' · '}更新 {formatAbsolute(card.updated_at)}
        {card.task_id ? ` · 任务 ${card.task_id}` : ''}
      </p>

      {card.type === 'question' ? (
        // 卡片正文只讲“为什么做、做到什么程度、查过什么、在选什么”。
        // 选项与回答统一交给 AnswerPanel，避免同一份选项在抽屉里出现两次。
        <section className="question-background">
          <CardSection title="议题背景" source={card.background_md} />
          <CardSection title="达到目的或结果" source={card.goal_md} />
          <CardSection title="调查参考" source={card.research_md} />
          <CardSection title="决策项描述" source={card.decision_md} />
        </section>
      ) : null}

      {card.type === 'info' ? (
        <section>
          <Markdown source={card.body_md} />
        </section>
      ) : null}

      {card.type === 'suggestion' ? (
        <section>
          <h3>分析</h3>
          <Markdown source={card.body_md} />
          <h3>建议列表</h3>
          <SuggestionList card={card} />
        </section>
      ) : null}

      {card.type === 'status' ? (
        <section>
          <h3>
            结果 <ResultBadge result={card.result} />
          </h3>
          <p className="status-summary">{card.summary || '（无摘要）'}</p>
          {card.detail_md ? <Markdown source={card.detail_md} /> : null}
        </section>
      ) : null}

      {card.type === 'artifact' ? (
        <section>
          <p>
            类型：<span className="tag">{card.kind ?? 'file'}</span>
            {' · '}大小：{formatBytes(card.size_bytes)}
          </p>
          <p className="status-summary">{card.summary || '（无产物说明）'}</p>
          <ArtifactLink url={card.url} />
        </section>
      ) : null}

      {card.type === 'handoff' ? (
        <section>
          <p>
            接收人：<strong>{card.recipient ?? '未指定'}</strong>
            {' · '}渠道：<span className="tag">{card.channel_kind ?? '未知'}</span>
            {' · '}状态：<HandoffStateBadge state={card.handoff_state} />
          </p>
          {card.reason ? <p className="muted">原因：{card.reason}</p> : null}
          <h3>交接话术</h3>
          <Markdown source={card.message_md} />
          <div className="inline wrap">
            <button type="button" className="btn btn-small" onClick={onCopyHandoff}>
              复制话术
            </button>
            {HANDOFF_STATES.map((state) => (
              <button
                key={state}
                type="button"
                className="btn btn-small btn-ghost"
                disabled={handoffBusy || card.handoff_state === state}
                onClick={() => onHandoffState(state)}
              >
                标记{HANDOFF_STATE_LABELS[state]}
              </button>
            ))}
          </div>
          <p className="muted small">
            AIDash 只能记录“已复制/已发送/已知悉”，无法确认对方是否真的收到。
          </p>
        </section>
      ) : null}

      {card.links.length > 0 ? (
        <section>
          <h3>相关链接</h3>
          <ul className="link-list">
            {card.links.map((link) => {
              const href = safeHttpUrl(link.url);
              return (
                <li key={`${link.label}-${link.url}`}>
                  {href ? (
                    <a className="inline-link" href={href} target="_blank" rel="noopener noreferrer">
                      {link.label}
                    </a>
                  ) : (
                    <span>{link.label}（不安全的链接已禁用）</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

    </div>
  );
}

/**
 * 决策卡四段背景的统一渲染。
 *
 * 旧卡可能只有 background_md，缺段时不能静默隐藏：用户需要知道“这段当年没写”，
 * 否则会把空白误读成“没有风险/没有调查”。所以缺段显式给一行占位文案。
 */
function CardSection({
  title,
  source,
}: {
  title: string;
  source: string | null;
}): ReactElement {
  return (
    <div className="card-section">
      <h3>{title}</h3>
      {source && source.trim() ? (
        <Markdown source={source} />
      ) : (
        <p className="muted card-section-missing">旧卡片未提供该段。</p>
      )}
    </div>
  );
}

function SuggestionList({ card }: { card: CardView }): ReactElement {
  if (card.suggestions.length === 0) {
    return <p className="muted">暂无建议条目。</p>;
  }
  return (
    <ul className="suggestion-list">
      {card.suggestions.map((item, index) => (
        <li key={`${index}-${item.text.slice(0, 12)}`}>
          <p>{item.text}</p>
          {item.rationale ? <p className="muted small">{item.rationale}</p> : null}
          {item.confidence !== null && item.confidence !== undefined ? (
            <div className="confidence">
              <div className="confidence-fill" style={{ width: `${Math.round(item.confidence * 100)}%` }} />
              <span>{Math.round(item.confidence * 100)}%</span>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ArtifactLink({ url }: { url: string | null }): ReactElement {
  const href = safeHttpUrl(url);
  if (!href) return <p className="warn-text">产物地址缺失或不是 http/https。</p>;
  return (
    <a className="btn btn-small" href={href} target="_blank" rel="noopener noreferrer">
      打开产物
    </a>
  );
}
