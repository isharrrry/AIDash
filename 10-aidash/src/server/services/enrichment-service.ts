import { AppError } from '../../shared/errors.js';
import type { Clock } from '../../shared/time.js';
import type { Card, EnrichmentView, SuggestionItem } from '../../shared/types.js';
import type { Db } from '../db/connection.js';
import type { CardRepo } from '../repos/card-repo.js';
import type { EventRepo } from '../repos/support-repos.js';
import type { KbService } from './kb-service.js';
import type { LlmService } from './llm-service.js';
import type { RuntimeSettings, SettingsService } from './settings-service.js';

export interface EnrichmentDeps {
  db: Db;
  cards: CardRepo;
  events: EventRepo;
  kb: KbService;
  llm: LlmService;
  settings: SettingsService;
  clock: Clock;
}

const MAX_ANALYSIS_CHARS = 4000;
const MAX_QUEUE = 200;
const PENDING_SCAN_LIMIT = 50;
const RETRY_INTERVAL_MS = 60_000;

/**
 * 可选的 LLM 增强。
 *
 * 设计底线：
 * - 增强只是“附加信息”，失败绝不能影响卡片本身；所有异常都落到 unavailable；
 * - 输入只来自已脱敏的卡片与知识库摘要，不额外拼接环境变量；
 * - 输出按严格形状收敛，模型胡说八道时宁可丢弃字段，也不把半截 JSON 存库；
 * - 配置不完整时直接 skipped，不发出注定失败的请求。
 */
export class EnrichmentService {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: EnrichmentDeps) {}

  start(): void {
    this.stopped = false;
    // 崩溃恢复：把上次停在 pending 的卡拉回队列。
    this.schedulePending();

    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.schedulePending();
    }, RETRY_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.queued.clear();
  }

  schedule(cardId: string): void {
    if (this.stopped || this.queued.has(cardId) || this.queue.length >= MAX_QUEUE) return;
    this.queued.add(cardId);
    this.queue.push(cardId);
    void this.drain();
  }

  private schedulePending(): void {
    const rows = this.deps.db
      .prepare(
        `SELECT id FROM card WHERE enrichment_status = 'pending'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(PENDING_SCAN_LIMIT) as Array<{ id: string }>;
    for (const row of rows) this.schedule(row.id);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const cardId = this.queue.shift()!;
        this.queued.delete(cardId);
        await this.runOne(cardId);
      }
    } finally {
      this.running = false;
    }
  }

  async runOne(cardId: string): Promise<void> {
    // 停止后不再碰数据库：关机路径里 stop() 早于 db.close()，
    // 已经排队的 drain 不应该在库关闭后继续读卡。
    if (this.stopped) return;
    const card = this.deps.cards.get(cardId);
    if (!card || card.enrichment_status !== 'pending') return;

    const settings = this.deps.settings.current();
    if (!settings.enrichmentEnabled) {
      this.finish(card, 'skipped', { status: 'skipped', reason: 'enrichment_disabled' });
      return;
    }
    if (!settings.llmEndpoint || !settings.llmModel || !settings.llmApiKey) {
      this.finish(card, 'unavailable', { status: 'unavailable', reason: 'llm_not_configured' });
      return;
    }

    this.deps.cards.setEnrichment(cardId, 'running', null);
    try {
      const hits = this.searchKb(card);
      const result = await this.callLlm(card, hits, settings);
      const view: EnrichmentView = {
        status: 'done',
        analysis_md: result.analysis_md,
        suggestions: result.suggestions,
        kb_refs: hits.map((hit) => ({
          path: hit.path,
          title: hit.title,
          excerpt: stripHighlight(hit.snippet).slice(0, 500),
        })),
        confidence: result.confidence,
        model: settings.llmModel,
        has_kb_basis: hits.length > 0,
      };
      this.finish(card, 'done', view);
    } catch (error) {
      // 不把原始错误写进卡片：可能带 URL、上游响应体甚至请求头。
      const reason = error instanceof AppError ? error.message : 'llm_unavailable';
      this.finish(card, 'unavailable', { status: 'unavailable', reason });
    }
  }

  private finish(card: Card, status: Card['enrichment_status'], view: EnrichmentView): void {
    this.deps.cards.setEnrichment(card.id, status, JSON.stringify(view));
    this.deps.events.card(
      card.id,
      `enrichment_${status}`,
      'system',
      { status, reason: view.reason ?? null },
      this.deps.clock.now(),
    );
  }

  private searchKb(card: Card): Array<{ path: string; title: string | null; snippet: string }> {
    if (!this.deps.kb.isConfigured()) return [];
    for (const query of buildKbQueries(card)) {
      try {
        const items = this.deps.kb.search(query, { top_k: 3 }).items;
        // 标题先搜、命中即停：正文命中面更宽，但标题命中的相关性通常更高。
        if (items.length > 0) return items;
      } catch {
        // 知识库坏了不影响增强主流程。
        return [];
      }
    }
    return [];
  }

  private async callLlm(
    card: Card,
    hits: Array<{ path: string; title: string | null; snippet: string }>,
    settings: RuntimeSettings,
  ): Promise<{ analysis_md: string; suggestions: SuggestionItem[]; confidence: number | null }> {
    const context = hits
      .map((hit, index) => `[${index + 1}] ${hit.path}\n${stripHighlight(hit.snippet)}`)
      .join('\n\n');

    const user = [
      `卡片类型：${card.type}`,
      `标题：${card.title ?? '（无）'}`,
      card.background_md ? `背景：${card.background_md}` : '',
      card.body_md ? `正文：${card.body_md}` : '',
      card.options_json ? `选项：${card.options_json}` : '',
      context ? `知识库片段：\n${context}` : '知识库片段：无',
    ]
      .filter(Boolean)
      .join('\n');

    // 两套能力提示词的分界点不是“有没有配置知识库”，而是“这次有没有命中片段”：
    // 配了 KB 但一条都没搜到，用“知识库建议”提示词只会逼模型硬编依据。
    const content = await this.deps.llm.chat({
      system: this.deps.llm.prompt(hits.length > 0 ? 'kb_suggestion' : 'card_analysis'),
      user,
      timeoutMs: settings.enrichmentTimeoutMs,
    });
    return sanitizeOutput(content);
  }
}

/** 从模型输出里截取第一个 JSON 对象，并逐字段收敛类型与长度。 */
export function sanitizeOutput(content: string): {
  analysis_md: string;
  suggestions: SuggestionItem[];
  confidence: number | null;
} {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new AppError('INTERNAL', 'LLM_OUTPUT_NOT_JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new AppError('INTERNAL', 'LLM_OUTPUT_NOT_JSON');
  }
  const data = (parsed ?? {}) as Record<string, unknown>;
  const analysis =
    typeof data.analysis_md === 'string' ? data.analysis_md.slice(0, MAX_ANALYSIS_CHARS) : '';
  const suggestions = Array.isArray(data.suggestions)
    ? data.suggestions
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .slice(0, 5)
        .map((item) => ({
          text: typeof item.text === 'string' ? item.text.slice(0, 2000) : '',
          rationale: typeof item.rationale === 'string' ? item.rationale.slice(0, 4000) : null,
          confidence:
            typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1
              ? item.confidence
              : null,
        }))
        .filter((item) => item.text.length > 0)
    : [];
  const confidence =
    typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1
      ? data.confidence
      : null;
  return { analysis_md: analysis, suggestions, confidence };
}

function stripHighlight(value: string): string {
  return value.replace(/<\/?mark>/g, '');
}

/**
 * 把卡片字段变成知识库可用的查询。
 *
 * 为什么不能整段拼接：KB 的 FTS 会把空格分隔的每个词做 AND。标题 + 背景 + 正文
 * 拼成一条长查询后，只要有一个词（时间、版本号、语气词）不在文档里就 0 命中，
 * 表现是“明明配了知识库却永远没有建议”。这里按字段截取前 4 个词、逐级回退。
 */
export function buildKbQueries(card: Pick<Card, 'title' | 'background_md' | 'body_md'>): string[] {
  const parts = [card.title, card.background_md, card.body_md].filter(
    (part): part is string => Boolean(part?.trim()),
  );
  const queries: string[] = [];
  for (const part of parts) {
    const query = part
      .replace(/[，。；：、!?！？,.;:()（）[\]【】\n\r\t]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join(' ')
      .slice(0, 60);
    if (query && !queries.includes(query)) queries.push(query);
  }
  return queries;
}
