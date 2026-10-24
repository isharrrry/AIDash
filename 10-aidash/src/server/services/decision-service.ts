import type { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { cardAskSchema } from '../../shared/schemas.js';
import type { Clock } from '../../shared/time.js';
import type { AskResult, CardAnswer, Ctx } from '../../shared/types.js';
import type { CardPostInput, CardService } from './card-service.js';

export type CardAskInput = z.infer<typeof cardAskSchema>;

interface Waiter {
  resolve: (answer: CardAnswer | null) => void;
}

/**
 * 有界阻塞等待（04 §MCP-005/007）。
 *
 * 为什么用“内存等待者表”而不是轮询数据库：
 * - 答案是同一进程写进库的，写成功后直接唤醒等待者，延迟从秒级降到毫秒级；
 * - 超时由 setTimeout 控制，绝不会把一个 HTTP 请求挂到天荒地老；
 * - 上限 maxWaitingRequests 防止大量空等把内存耗尽，超出直接 BUSY。
 *
 * 进程重启会丢掉等待者，但卡片答案已经落库，调用方重连后 card.get 仍能拿到结果。
 */
export class WaitRegistry {
  private readonly waiters = new Map<string, Set<Waiter>>();
  private total = 0;

  constructor(private readonly maxWaiting: number) {}

  wait(cardId: string, timeoutMs: number, signal?: AbortSignal): Promise<CardAnswer | null> {
    if (timeoutMs <= 0) return Promise.resolve(null);
    if (this.total >= this.maxWaiting) {
      throw new AppError('BUSY', 'TOO_MANY_WAITING', { max_waiting_requests: this.maxWaiting }, true);
    }
    return new Promise<CardAnswer | null>((resolve) => {
      let settled = false;
      const waiter: Waiter = {
        resolve: (answer) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(answer);
        },
      };
      const timer = setTimeout(() => waiter.resolve(null), timeoutMs);
      const onAbort = (): void => waiter.resolve(null);
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const set = this.waiters.get(cardId);
        if (set) {
          set.delete(waiter);
          if (set.size === 0) this.waiters.delete(cardId);
        }
        this.total -= 1;
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      let set = this.waiters.get(cardId);
      if (!set) {
        set = new Set();
        this.waiters.set(cardId, set);
      }
      set.add(waiter);
      this.total += 1;
    });
  }

  resolve(cardId: string, answer: CardAnswer): void {
    const set = this.waiters.get(cardId);
    if (!set) return;
    for (const waiter of [...set]) waiter.resolve(answer);
  }

  cancelAll(): void {
    for (const set of this.waiters.values()) {
      for (const waiter of [...set]) waiter.resolve(null);
    }
  }

  size(): number {
    return this.total;
  }
}

export interface DecisionServiceDeps {
  cards: CardService;
  waiters: WaitRegistry;
  clock: Clock;
  maxWaitSeconds: number;
}

const POLL_AFTER_MS = 1000;

/**
 * 决策卡的有界等待编排。
 * 返回 pending 不是失败：调用方应该记下 card_id，先做别的（AGENTS §8）。
 */
export class DecisionService {
  constructor(private readonly deps: DecisionServiceDeps) {}

  async ask(input: CardAskInput, ctx: Ctx, signal?: AbortSignal): Promise<AskResult> {
    const { card } = this.deps.cards.post(toCardPostInput(input), ctx);
    if (card.status === 'answered') return toAnswered(card.id, card.answer);

    const waitSeconds = Math.min(Math.max(input.wait_seconds ?? 0, 0), this.deps.maxWaitSeconds);
    if (waitSeconds <= 0) {
      return {
        status: 'pending',
        card_id: card.id,
        poll_after_ms: POLL_AFTER_MS,
        expires_at: card.due_at,
      };
    }

    const answer = await this.deps.waiters.wait(card.id, waitSeconds * 1000, signal);
    if (answer) return toAnswered(card.id, answer);

    // 超时与“刚好在超时边界答完”之间存在竞态，以数据库为准再读一次。
    const latest = this.deps.cards.get(card.id);
    if (latest.status === 'answered') return toAnswered(latest.id, latest.answer);
    return {
      status: 'pending',
      card_id: latest.id,
      poll_after_ms: POLL_AFTER_MS,
      expires_at: latest.due_at,
    };
  }

  async wait(cardId: string, waitSeconds: number, signal?: AbortSignal): Promise<AskResult> {
    const card = this.deps.cards.get(cardId);
    if (card.status === 'answered') return toAnswered(card.id, card.answer);
    if (card.status !== 'open') {
      throw new AppError('CONFLICT', 'CARD_NOT_OPEN', { status: card.status });
    }

    const seconds = Math.min(Math.max(waitSeconds, 0), this.deps.maxWaitSeconds);
    const answer = await this.deps.waiters.wait(card.id, seconds * 1000, signal);
    if (answer) return toAnswered(card.id, answer);

    const latest = this.deps.cards.get(card.id);
    if (latest.status === 'answered') return toAnswered(latest.id, latest.answer);
    return {
      status: 'pending',
      card_id: latest.id,
      poll_after_ms: POLL_AFTER_MS,
      expires_at: latest.due_at,
    };
  }

  /** CardService 的 onAnswered 回调。 */
  resolve = (cardId: string, answer: CardAnswer): void => {
    this.deps.waiters.resolve(cardId, answer);
  };

  cancelAll(): void {
    this.deps.waiters.cancelAll();
  }

  /** 指标用：当前有多少个 MCP 请求正阻塞在决策卡上。 */
  waitingCount(): number {
    return this.deps.waiters.size();
  }
}

function toAnswered(cardId: string, answer: CardAnswer | null): AskResult {
  if (!answer) {
    // 数据库里 answered 但 answer_json 为空属于数据损坏；宁可报错也不返回假答案。
    throw new AppError('INTERNAL', 'ANSWER_MISSING', { card_id: cardId });
  }
  return { status: 'answered', card_id: cardId, answer };
}

function toCardPostInput(input: CardAskInput): CardPostInput {
  return {
    channel_key: input.channel_key,
    type: 'question',
    title: input.title,
    priority: input.priority,
    body_md: null,
    background_md: input.background_md,
    // card.ask 是 REST/MCP 两个入口共用的“发问题卡”通道，
    // 四段背景必须原样透传到 CardService，否则 ask 发出的卡会缺段。
    goal_md: input.goal_md,
    research_md: input.research_md,
    decision_md: input.decision_md,
    message_md: null,
    summary: null,
    detail_md: null,
    severity: null,
    recipient: null,
    channel_kind: null,
    reason: null,
    handoff_state: null,
    options: input.options,
    allow_free_text: input.allow_free_text,
    default_action: input.default_action,
    due_at: input.due_at,
    analysis_md: null,
    suggestions: undefined,
    kb_refs: undefined,
    confidence: null,
    result: null,
    url: null,
    kind: null,
    size_bytes: null,
    links: undefined,
    blocking: false,
    task_id: input.task_id,
    idempotency_key: input.idempotency_key,
  };
}
