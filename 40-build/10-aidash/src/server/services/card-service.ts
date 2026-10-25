import type { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { cardPostSchema, normalizeCardResult } from '../../shared/schemas.js';
import { assertNoSecrets, assertSafeUrl } from '../../shared/secrets.js';
import type { Clock } from '../../shared/time.js';
import type {
  Artifact,
  BatchAnswerResult,
  Card,
  CardAnswer,
  CardOption,
  CardView,
  Ctx,
  Digest,
  EnrichmentView,
  KbRef,
  Link,
  Page,
  Priority,
  SuggestionItem,
} from '../../shared/types.js';
import { txImmediate, type Db } from '../db/connection.js';
import type { CardListFilter, CardRepo } from '../repos/card-repo.js';
import type { ArtifactRepo, EventRepo } from '../repos/support-repos.js';
import type { TaskRepo } from '../repos/task-repo.js';
import type { AuditService } from './audit-service.js';
import type { ChannelService } from './channel-service.js';

export type CardPostInput = z.infer<typeof cardPostSchema>;

export interface EnrichmentScheduler {
  schedule(cardId: string): void;
}

export interface CardServiceDeps {
  db: Db;
  cards: CardRepo;
  artifacts: ArtifactRepo;
  events: EventRepo;
  tasks: TaskRepo;
  channels: ChannelService;
  audit: AuditService;
  clock: Clock;
  enrichment?: EnrichmentScheduler;
  /** 答案落库后的同步回调：DecisionService 用它唤醒等待中的 MCP 请求。 */
  onAnswered?: (cardId: string, answer: CardAnswer) => void;
}

const ENRICHABLE: ReadonlySet<string> = new Set(['question', 'suggestion']);

/**
 * 卡片服务：六种类型的唯一写入口。
 *
 * 类型差异只体现在“字段映射”上；状态、幂等、脱敏、审计这些横切规则
 * 全部走同一条路径，避免六份 if 各自长歪。
 */
export class CardService {
  private readonly db: Db;
  private readonly cards: CardRepo;
  private readonly artifacts: ArtifactRepo;
  private readonly events: EventRepo;
  private readonly tasks: TaskRepo;
  private readonly channels: ChannelService;
  private readonly audit: AuditService;
  private readonly clock: Clock;
  private readonly enrichment?: EnrichmentScheduler;
  /**
   * 答案监听器在装配时才有（CardService 先于 DecisionService 构造），
   * 因此不能用 readonly 构造注入，否则会形成循环依赖。
   */
  private onAnswered?: (cardId: string, answer: CardAnswer) => void;

  constructor(deps: CardServiceDeps) {
    this.db = deps.db;
    this.cards = deps.cards;
    this.artifacts = deps.artifacts;
    this.events = deps.events;
    this.tasks = deps.tasks;
    this.channels = deps.channels;
    this.audit = deps.audit;
    this.clock = deps.clock;
    this.enrichment = deps.enrichment;
    this.onAnswered = deps.onAnswered;
  }

  /** 装配阶段绑定等待唤醒；测试可传 no-op。 */
  bindAnswerListener(listener: (cardId: string, answer: CardAnswer) => void): void {
    this.onAnswered = listener;
  }

  post(input: CardPostInput, ctx: Ctx): { card: CardView; created: boolean } {
    const { channel } = this.channels.ensure(
      { channel_key: input.channel_key, title: null },
      ctx,
    );
    // schema 已经拦过一遍；service 是唯一写入口，这里再守一次，
    // 防止未来新增内部调用方绕过 zod 直接构造输入。
    if (input.type !== 'question' && !input.task_id) {
      throw new AppError('INVALID_ARGUMENT', 'TASK_REQUIRED', { type: input.type });
    }
    if (input.task_id) this.assertTaskInChannel(input.task_id, channel.id);
    assertNoSecrets(collectText(input));
    for (const link of input.links ?? []) assertSafeUrl(link.url);
    if (input.type === 'artifact') assertSafeUrl(input.url!, { allowFile: true });

    if (input.idempotency_key) {
      const existing = this.cards.findByIdem(channel.id, input.idempotency_key);
      if (existing) {
        this.audit.record(ctx, 'card.post', 'ok', 'card', existing.id, { idempotent: true });
        return { card: this.toView(existing, channel.channel_key), created: false };
      }
    }

    const now = this.clock.now();
    const canEnrich = ENRICHABLE.has(input.type) && this.enrichment !== undefined;
    const card: Card = {
      id: newId('cd'),
      channel_id: channel.id,
      type: input.type,
      status: 'open',
      priority: input.priority,
      title: input.title ?? null,
      body_md: null,
      background_md: null,
      // 四段背景先统一置空，只有 question 分支会真正赋值；
      // 这样六种卡共享同一个初始化路径，不会出现某个类型漏字段。
      goal_md: null,
      research_md: null,
      decision_md: null,
      message_md: null,
      summary: input.summary ?? null,
      detail_md: input.detail_md ?? null,
      severity: null,
      recipient: null,
      channel_kind: null,
      reason: null,
      handoff_state: null,
      options_json: null,
      allow_free_text: input.allow_free_text ? 1 : 0,
      default_action: input.default_action ?? null,
      due_at: input.due_at ? Date.parse(input.due_at) : null,
      answer_json: null,
      answered_at: null,
      artifact_url: null,
      artifact_kind: null,
      links_json: input.links?.length ? JSON.stringify(input.links) : null,
      result: null,
      suggestions_json: null,
      kb_refs_json: null,
      confidence: input.confidence ?? null,
      blocking: input.blocking ? 1 : 0,
      task_id: input.task_id ?? null,
      enrichment_status: canEnrich ? 'pending' : 'skipped',
      enrichment_json: null,
      idempotency_key: input.idempotency_key ?? null,
      created_by: ctx.actorLabel,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };

    switch (input.type) {
      case 'info':
        card.body_md = input.body_md ?? null;
        card.severity = input.severity ?? null;
        break;
      case 'handoff':
        card.recipient = input.recipient ?? null;
        card.channel_kind = input.channel_kind ?? null;
        card.reason = input.reason ?? null;
        card.message_md = input.message_md ?? null;
        card.handoff_state = input.handoff_state ?? 'draft';
        break;
      case 'question':
        // 四段背景缺一不可（schemas 的 superRefine 已校验），这里按字段原样落库；
        // 选项整体存 JSON，pros/cons/recommendation_role 随选项一起持久化。
        card.background_md = input.background_md ?? null;
        card.goal_md = input.goal_md ?? null;
        card.research_md = input.research_md ?? null;
        card.decision_md = input.decision_md ?? null;
        card.options_json = JSON.stringify(input.options ?? []);
        card.default_action = input.default_action ?? null;
        break;
      case 'suggestion':
        // 04 把分析正文命名 analysis_md；库里统一存 body_md，视图再映射回去。
        card.body_md = input.analysis_md ?? null;
        card.suggestions_json = JSON.stringify(input.suggestions ?? []);
        card.kb_refs_json = input.kb_refs?.length ? JSON.stringify(input.kb_refs) : null;
        break;
      case 'status':
        card.summary = input.summary ?? null;
        card.detail_md = input.detail_md ?? null;
        card.result = normalizeCardResult(input.result);
        break;
      case 'artifact':
        card.artifact_url = input.url ?? null;
        card.artifact_kind = input.kind ?? null;
        card.summary = input.summary ?? null;
        break;
    }

    txImmediate(this.db, () => {
      this.cards.insert(card);
      if (card.type === 'artifact') {
        this.artifacts.insert({
          id: newId('ar'),
          card_id: card.id,
          kind: card.artifact_kind as Artifact['kind'],
          url: card.artifact_url!,
          summary: card.summary,
          size_bytes: input.size_bytes ?? null,
          created_at: now,
        });
      }
      this.events.card(card.id, 'created', ctx.actorLabel, { type: card.type }, now);
      this.channels.touch(channel.id, now);
    });

    this.audit.record(ctx, 'card.post', 'ok', 'card', card.id, { type: card.type });

    if (canEnrich) {
      // 放到事务提交之后，异步失败也不会回滚已发出去的卡。
      setTimeout(() => this.enrichment!.schedule(card.id), 0);
    }

    return {
      card: this.toView(card, channel.channel_key, input.size_bytes ?? null),
      created: true,
    };
  }

  get(id: string): CardView {
    const card = this.cards.get(id);
    if (!card) throw new AppError('NOT_FOUND', 'CARD_NOT_FOUND', { card_id: id });
    return this.toView(card);
  }

  list(filter: CardListFilter = {}): Page<CardView> {
    const page = this.cards.list(filter);
    const sizes = this.artifactSizes(page.items.map((card) => card.id));
    return {
      ...page,
      items: page.items.map((card) =>
        // read_at 由 repo 的 LEFT JOIN 带回；这里只做时间格式转换。
        toCardView(card, card.channel_key, sizes.get(card.id) ?? null, card.read_at),
      ),
    };
  }

  /**
   * 标记一张卡已读。
   *
   * 不写 card_event、不写审计：
   * - 读卡是高频 UI 动作，写事件会把任务/卡片时间线灌满，真正重要的状态变化反而被淹没；
   * - 已读时间本身就是事实，存在 card_read 里，足够回答“什么时候第一次看到”。
   * 幂等：重复调用返回同一个 read_at，不会把“第一次看到”改成最后一次。
   */
  markRead(cardId: string, _ctx: Ctx): CardView {
    this.requireCard(cardId);
    this.cards.markRead(cardId, this.clock.now());
    return this.toView(this.cards.get(cardId)!);
  }

  search(q: string, filter: Omit<CardListFilter, 'q'> = {}): Page<CardView> {
    return this.list({ ...filter, q });
  }

  /**
   * 回答决策卡。
   * 三条守卫：类型必须是 question、状态必须是 open、选项必须存在；
   * allow_free_text=false 时不允许只给自由文本，否则用户会看到“答了但没选项”。
   */
  answer(cardId: string, answer: CardAnswer, ctx: Ctx): CardView {
    const card = this.cards.get(cardId);
    if (!card) throw new AppError('NOT_FOUND', 'CARD_NOT_FOUND', { card_id: cardId });
    if (card.type !== 'question') {
      throw new AppError('INVALID_ARGUMENT', 'CARD_NOT_QUESTION', { card_id: cardId });
    }
    if (card.status !== 'open') {
      throw new AppError('CONFLICT', 'CARD_NOT_OPEN', { guard: 'G-C03', status: card.status });
    }

    const options = parseJson<CardOption[]>(card.options_json) ?? [];
    if (answer.option_id) {
      if (!options.some((option) => option.id === answer.option_id)) {
        throw new AppError('INVALID_ARGUMENT', 'OPTION_NOT_FOUND', { option_id: answer.option_id });
      }
    } else {
      if (!card.allow_free_text) {
        throw new AppError('INVALID_ARGUMENT', 'FREE_TEXT_NOT_ALLOWED', { guard: 'G-C04' });
      }
      if (!answer.free_text?.trim()) {
        throw new AppError('INVALID_ARGUMENT', 'ANSWER_REQUIRED');
      }
    }

    const now = this.clock.now();
    const stored: CardAnswer = {
      option_id: answer.option_id ?? null,
      free_text: answer.free_text?.trim() || null,
      note: answer.note ?? null,
      answered_by: ctx.actorLabel,
      answered_at: new Date(now).toISOString(),
    };

    const applied = txImmediate(this.db, () => {
      const ok = this.cards.setAnswered(cardId, JSON.stringify(stored), now);
      if (!ok) return false;
      this.events.card(cardId, 'answered', ctx.actorLabel, { option_id: stored.option_id }, now);
      this.channels.touch(card.channel_id, now);
      return true;
    });
    if (!applied) {
      throw new AppError('CONFLICT', 'CARD_NOT_OPEN', { guard: 'G-C03', status: 'answered' });
    }

    this.audit.record(ctx, 'card.answer', 'ok', 'card', cardId, { option_id: stored.option_id });
    this.onAnswered?.(cardId, stored);
    return this.toView(this.cards.get(cardId)!);
  }

  batchAnswer(items: Array<{ card_id: string; answer: CardAnswer }>, ctx: Ctx): BatchAnswerResult {
    const results = items.map((item) => {
      try {
        this.answer(item.card_id, item.answer, ctx);
        return { card_id: item.card_id, ok: true };
      } catch (error) {
        const appError =
          error instanceof AppError ? error : new AppError('INTERNAL', 'INTERNAL_ERROR');
        return {
          card_id: item.card_id,
          ok: false,
          error: { code: appError.code, message: appError.message },
        };
      }
    });
    const success = results.filter((item) => item.ok).length;
    return { results, success_count: success, failure_count: results.length - success };
  }

  dismiss(cardId: string, ctx: Ctx): CardView {
    const card = this.requireCard(cardId);
    if (card.status !== 'open') {
      throw new AppError('CONFLICT', 'CARD_NOT_OPEN', { status: card.status });
    }
    const now = this.clock.now();
    txImmediate(this.db, () => {
      this.cards.setStatus(cardId, 'dismissed', now);
      this.events.card(cardId, 'dismissed', ctx.actorLabel, undefined, now);
    });
    this.audit.record(ctx, 'card.dismiss', 'ok', 'card', cardId);
    return this.toView(this.cards.get(cardId)!);
  }

  archive(cardId: string, ctx: Ctx): CardView {
    const card = this.requireCard(cardId);
    if (card.status === 'archived') return this.toView(card);
    const now = this.clock.now();
    txImmediate(this.db, () => {
      this.cards.setStatus(cardId, 'archived', now, true);
      this.events.card(cardId, 'archived', ctx.actorLabel, undefined, now);
    });
    this.audit.record(ctx, 'card.archive', 'ok', 'card', cardId);
    return this.toView(this.cards.get(cardId)!);
  }

  updateMeta(cardId: string, patch: { title?: string; priority?: Priority }, ctx: Ctx): CardView {
    const card = this.requireCard(cardId);
    if (card.status === 'archived') {
      throw new AppError('CONFLICT', 'CARD_ARCHIVED', { card_id: cardId });
    }
    const now = this.clock.now();
    txImmediate(this.db, () => {
      this.cards.updateFields(cardId, { ...patch, updated_at: now });
      this.events.card(cardId, 'updated', ctx.actorLabel, patch, now);
    });
    this.audit.record(ctx, 'card.update', 'ok', 'card', cardId);
    return this.toView(this.cards.get(cardId)!);
  }

  /** 交接卡的“已复制/已发送/对方已知悉”只是本地状态，AIDash 不追踪对方是否真的收到。 */
  setHandoffState(cardId: string, state: NonNullable<Card['handoff_state']>, ctx: Ctx): CardView {
    const card = this.requireCard(cardId);
    if (card.type !== 'handoff') {
      throw new AppError('INVALID_ARGUMENT', 'CARD_NOT_HANDOFF', { card_id: cardId });
    }
    const now = this.clock.now();
    txImmediate(this.db, () => {
      this.cards.updateFields(cardId, { handoff_state: state, updated_at: now });
      this.events.card(cardId, 'handoff_state', ctx.actorLabel, { state }, now);
    });
    this.audit.record(ctx, 'card.handoff_state', 'ok', 'card', cardId, { state });
    return this.toView(this.cards.get(cardId)!);
  }

  /** 到期未答的决策卡标记 expired，但不替用户做选择（AGENTS §4.3）。 */
  expireDueQuestions(now: number): number {
    const due = this.cards.findOpenQuestionsDue(now);
    let count = 0;
    for (const card of due) {
      const applied = txImmediate(this.db, () => {
        if (card.status !== 'open') return false;
        this.cards.setStatus(card.id, 'expired', now);
        this.events.card(card.id, 'expired', 'system', { due_at: card.due_at }, now);
        return true;
      });
      if (applied) count += 1;
    }
    return count;
  }

  digest(channelKey?: string): Digest {
    const channelId = channelKey ? this.channels.getByKeyOrThrow(channelKey).id : undefined;
    const p0 = this.views(this.cards.findTopByPriority(['P0'], 5, channelId));
    const p1 = this.views(this.cards.findTopByPriority(['P1'], 5, channelId));
    const recentStatus = this.views(
      this.cards
        .findRecentByType('status', 10, channelId)
        .filter((card) => card.status !== 'archived')
        .slice(0, 5),
    );
    const recentSuggestions = this.views(
      this.cards
        .findRecentByType('suggestion', 10, channelId)
        .filter((card) => card.status !== 'archived')
        .slice(0, 5),
    );
    return {
      generated_at: new Date(this.clock.now()).toISOString(),
      pending_decisions: this.cards.countOpenQuestions(channelId),
      p0_cards: p0,
      p1_cards: p1,
      recent_status: recentStatus,
      recent_suggestions: recentSuggestions,
      channels_active: this.channels.list({ page_size: 200 }).total,
    };
  }

  toView(card: Card, channelKey?: string, sizeBytes?: number | null): CardView {
    const key = channelKey ?? this.channels.getOrThrow(card.channel_id).channel_key;
    return toCardView(
      card,
      key,
      sizeBytes === undefined ? this.artifactSize(card) : sizeBytes,
      this.cards.getReadAt(card.id),
    );
  }

  private views(cards: Card[]): CardView[] {
    const sizes = this.artifactSizes(cards.map((card) => card.id));
    // 一次取回本组卡的已读时间，避免 digest 里逐卡查 card_read。
    const reads = this.cards.readAtFor(cards.map((card) => card.id));
    return cards.map((card) => {
      const key = card.channel_id ? this.channels.getOrThrow(card.channel_id).channel_key : '';
      return toCardView(card, key, sizes.get(card.id) ?? null, reads.get(card.id) ?? null);
    });
  }

  private requireCard(id: string): Card {
    const card = this.cards.get(id);
    if (!card) throw new AppError('NOT_FOUND', 'CARD_NOT_FOUND', { card_id: id });
    return card;
  }

  private assertTaskInChannel(taskId: string, channelId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError('NOT_FOUND', 'TASK_NOT_FOUND', { task_id: taskId });
    if (task.channel_id !== channelId) {
      throw new AppError('INVALID_ARGUMENT', 'TASK_CHANNEL_MISMATCH', { task_id: taskId });
    }
  }

  private artifactSize(card: Card): number | null {
    if (card.type !== 'artifact') return null;
    return this.artifacts.listByCard(card.id)[0]?.size_bytes ?? null;
  }

  /** 一次查询取回本页所有 artifact 卡的体积，避免逐卡 N+1。 */
  private artifactSizes(cardIds: string[]): Map<string, number | null> {
    const result = new Map<string, number | null>();
    if (cardIds.length === 0) return result;
    const rows = this.db
      .prepare(
        `SELECT card_id, size_bytes FROM artifact
         WHERE card_id IN (${cardIds.map(() => '?').join(',')})
         ORDER BY created_at DESC`,
      )
      .all(...cardIds) as Array<{ card_id: string; size_bytes: number | null }>;
    for (const row of rows) {
      if (!result.has(row.card_id)) result.set(row.card_id, row.size_bytes);
    }
    return result;
  }
}

/** 视图组装：JSON 列在这里统一解析，页面与 MCP 拿到的是同一形状。 */
export function toCardView(
  card: Card,
  channelKey: string,
  sizeBytes: number | null,
  readAt: number | null,
): CardView {
  const enrichment = parseJson<EnrichmentView>(card.enrichment_json);
  return {
    id: card.id,
    channel_id: card.channel_id,
    channel_key: channelKey,
    type: card.type,
    status: card.status,
    priority: card.priority,
    title: card.title,
    body_md: card.body_md,
    background_md: card.background_md,
    goal_md: card.goal_md,
    research_md: card.research_md,
    decision_md: card.decision_md,
    message_md: card.message_md,
    summary: card.summary,
    detail_md: card.detail_md,
    severity: card.severity,
    recipient: card.recipient,
    channel_kind: card.channel_kind,
    reason: card.reason,
    handoff_state: card.handoff_state,
    options: parseJson<CardOption[]>(card.options_json) ?? [],
    allow_free_text: card.allow_free_text === 1,
    default_action: card.default_action,
    due_at: card.due_at === null ? null : new Date(card.due_at).toISOString(),
    answer: parseJson<CardAnswer>(card.answer_json),
    answered_at: card.answered_at === null ? null : new Date(card.answered_at).toISOString(),
    url: card.artifact_url,
    kind: card.artifact_kind,
    size_bytes: sizeBytes,
    result: card.result,
    suggestions: parseJson<SuggestionItem[]>(card.suggestions_json) ?? [],
    kb_refs: parseJson<KbRef[]>(card.kb_refs_json) ?? [],
    links: parseJson<Link[]>(card.links_json) ?? [],
    blocking: card.blocking === 1,
    task_id: card.task_id,
    read_at: readAt === null ? null : new Date(readAt).toISOString(),
    enrichment: {
      ...(enrichment ?? { status: card.enrichment_status }),
      status: card.enrichment_status,
    },
    created_at: new Date(card.created_at).toISOString(),
    updated_at: new Date(card.updated_at).toISOString(),
    archived_at: card.archived_at === null ? null : new Date(card.archived_at).toISOString(),
  };
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** 一次性收集需要做敏感模式扫描的文本字段。 */
function collectText(input: CardPostInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    title: input.title ?? '',
    body_md: input.body_md ?? '',
    background_md: input.background_md ?? '',
    // 四段背景都是自由文本，和正文一样纳入敏感模式扫描，避免令牌从新字段漏出去。
    goal_md: input.goal_md ?? '',
    research_md: input.research_md ?? '',
    decision_md: input.decision_md ?? '',
    message_md: input.message_md ?? '',
    summary: input.summary ?? '',
    detail_md: input.detail_md ?? '',
    reason: input.reason ?? '',
    analysis_md: input.analysis_md ?? '',
  };
  (input.suggestions ?? []).forEach((item, index) => {
    fields[`suggestions[${index}].text`] = item.text;
    fields[`suggestions[${index}].rationale`] = item.rationale ?? '';
  });
  (input.kb_refs ?? []).forEach((item, index) => {
    fields[`kb_refs[${index}].excerpt`] = item.excerpt ?? '';
  });
  return fields;
}
