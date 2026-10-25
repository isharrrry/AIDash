import { DAY_MS } from '../../shared/time.js';
import type { AppContext } from '../context.js';
import type { Logger } from '../log.js';

const TICK_MS = 30_000;

export interface BackgroundWorker {
  start(): void;
  stop(): void;
}

/**
 * 后台维护 worker。
 *
 * 为什么要独立于请求路径：
 * - 决策卡到期、租约回收、harness 离线都是“没有请求也要发生”的事；
 * - 放在请求里会被流量左右；放在这里固定 30 秒一拍，逻辑更可预测。
 *
 * 所有任务都允许失败：单个 tick 抛错只记日志，下一拍继续，
 * 否则一次数据库瞬时 BUSY 会让整个进程的维护停摆。
 */
export function createBackgroundWorker(ctx: AppContext, log: Logger): BackgroundWorker {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let lastKbIndex = 0;

  const safe = (name: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      log.warn('worker_task_failed', {
        task: name,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  const tick = (): void => {
    if (running) return;
    running = true;
    const now = ctx.clock.now();
    try {
      safe('expire_cards', () => {
        const count = ctx.services.cards.expireDueQuestions(now);
        if (count > 0) log.info('cards_expired', { count });
      });

      safe('expire_leases', () => {
        const count = ctx.services.tasks.expireLeases(now);
        if (count > 0) log.info('leases_expired', { count });
      });

      safe('mark_harness_offline', () => {
        const cutoff = now - ctx.config.offlineThresholdSeconds * 1000;
        const count = ctx.repos.harnesses.markOffline(cutoff, now);
        if (count > 0) log.info('harnesses_offline', { count });
      });

      safe('card_retention', () => {
        const cutoff = now - ctx.config.cardRetentionDays * DAY_MS;
        const stale = ctx.repos.cards.findOlderThanOpen(cutoff, 200);
        for (const card of stale) {
          ctx.repos.cards.setStatus(card.id, 'archived', now, true);
          ctx.repos.events.card(card.id, 'archived', 'system', { reason: 'retention' }, now);
        }
        if (stale.length > 0) log.info('cards_archived_by_retention', { count: stale.length });
      });

      if (ctx.services.kb.isConfigured() && now - lastKbIndex >= ctx.config.kbIndexIntervalMs) {
        lastKbIndex = now;
        safe('kb_index', () => {
          const report = ctx.services.kb.index();
          log.info('kb_indexed', {
            scanned: report.scanned,
            indexed: report.indexed,
            unchanged: report.unchanged,
            removed: report.removed,
            errors: report.errors.length,
          });
        });
      }
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      // 立即跑一拍：重启后不需要等 30 秒才开始回收过期租约。
      tick();
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
