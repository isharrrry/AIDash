import type { ReactElement } from 'react';
import type { CardView } from '../types';
import { formatConfidence } from '../lib/format';
import { EnrichmentBadge } from './Badge';
import { KbMiniSearch } from './KbMiniSearch';
import { Markdown } from './Markdown';

/** SCR-02 R3：增强分析、建议、知识引用，以及随手查 KB。 */
export function EnrichmentPanel({
  card,
  onOpenKb,
}: {
  card: CardView;
  onOpenKb: (path: string) => void;
}): ReactElement {
  const enrichment = card.enrichment;
  // suggestion 卡的正式建议已由 CardBody 展示；这里只展示“增强分析”自己的建议，
  // 避免同一组条目在抽屉里出现两遍。
  const suggestions = enrichment.suggestions ?? [];
  const kbRefs =
    enrichment.kb_refs && enrichment.kb_refs.length > 0 ? enrichment.kb_refs : card.kb_refs;

  return (
    <section className="drawer-section">
      <h3>
        增强与知识依据 <EnrichmentBadge status={enrichment.status} />
      </h3>

      {enrichment.status === 'pending' || enrichment.status === 'running' ? (
        <p className="muted">增强任务尚未完成，稍后刷新可看到分析结果。</p>
      ) : null}
      {enrichment.status === 'unavailable' ? (
        <p className="warn-text">
          增强不可用{enrichment.reason ? `：${enrichment.reason}` : ''}。这不影响你直接回答。
        </p>
      ) : null}

      {enrichment.analysis_md ? <Markdown source={enrichment.analysis_md} /> : null}

      {suggestions.length > 0 ? (
        <ul className="suggestion-list">
          {suggestions.map((item, index) => (
            <li key={`${index}-${item.text.slice(0, 16)}`}>
              <p>{item.text}</p>
              {item.rationale ? <p className="muted small">{item.rationale}</p> : null}
              {item.confidence !== null && item.confidence !== undefined ? (
                <div className="confidence">
                  <div
                    className="confidence-fill"
                    style={{ width: `${Math.round(item.confidence * 100)}%` }}
                  />
                  <span>{formatConfidence(item.confidence)}</span>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : enrichment.status === 'done' ? (
        <p className="muted">本次增强没有给出建议条目。</p>
      ) : null}

      <p className="muted small">
        知识依据：{enrichment.has_kb_basis ? '有' : '无'}
        {enrichment.confidence !== null && enrichment.confidence !== undefined
          ? ` · 置信度 ${formatConfidence(enrichment.confidence)}`
          : ''}
        {enrichment.model ? ` · 模型 ${enrichment.model}` : ''}
      </p>

      {kbRefs.length > 0 ? (
        <ul className="link-list">
          {kbRefs.map((ref) => (
            <li key={ref.path}>
              <button type="button" className="link-button" onClick={() => onOpenKb(ref.path)}>
                {ref.title || ref.path}
              </button>
              {ref.excerpt ? <p className="muted small">{ref.excerpt}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <KbMiniSearch onOpenDoc={onOpenKb} />
    </section>
  );
}
