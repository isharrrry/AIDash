import { DAY_MS } from '../../shared/time.js';
import type { AppContext } from '../context.js';
import type { Logger } from '../log.js';

const TICK_MS = 30_000;

export interface BackgroundWorker {
  start(): void;
  stop(): void;
  /**
   * 触发首轮 KB 索引。
   *
   * 由 `main.ts` 在 listen 回调里调用：端口先可用，索引再异步分批跑，
   * 避免“文档多时服务还没开始监听就先卡住几十秒”。
   */
  indexKb(): void;
  /** 关机前等待在途索引退出；stop() 会先 abort，通常很快返回。 */
  waitForIdle(): Promise<void>;
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
  /** 在途的异步 KB 索引；同一时刻只允许一个，避免定时与手动触发互相叠加。 */
  let kbTask: Promise<void> | null = null;
  let kbAbort: AbortController | null = null;

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

  const indexKb = (): void => {
    if (!ctx.services.kb.isConfigured() || kbTask) return;
    lastKbIndex = ctx.clock.now();
    const controller = new AbortController();
    kbAbort = controller;
    kbTask = ctx.services.kb
      .indexAsync({ signal: controller.signal })
      .then((report) => {
        log.info('kb_indexed', {
          scanned: report.scanned,
          indexed: report.indexed,
          unchanged: report.unchanged,
          removed: report.removed,
          errors: report.errors.length,
        });
      })
      .catch((error: unknown) => {
        // 关机 abort 是预期路径，不记成 worker 故障。
        if (controller.signal.aborted) return;
        log.warn('worker_task_failed', {
          task: 'kb_index',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      })
      .finally(() => {
        kbTask = null;
        if (kbAbort === controller) kbAbort = null;
      });
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
        // 用运行时可改的设置，而不是启动时冻结的配置：
        // 设置页 PATCH 后 SettingsService 会更新 runtime，下一拍就会采用新值；
        // 若读 ctx.config，页面改完必须重启进程才生效，等于设置项名不副实。
        // 用运行时可改的设置，而不是启动时冻结的配置：
        // 设置页 PATCH 后 SettingsService 会更新 runtime，下一拍就会采用新值；
        // 若读 ctx.config，页面改完必须重启进程才生效，等于设置项名不副实。
        const retentionDays = ctx.services.settings.current().cardRetentionDays;
        const cutoff = now - retentionDays * DAY_MS;
        const stale = ctx.repos.cards.findOlderThanOpen(cutoff, 200);
        for (const card of stale) {
          ctx.repos.cards.setStatus(card.id, 'archived', now, true);
          ctx.repos.events.card(card.id, 'archived', 'system', { reason: 'retention' }, now);
        }
        if (stale.length > 0) log.info('cards_archived_by_retention', { count: stale.length });
      });

      if (
        ctx.services.kb.isConfigured() &&
        !kbTask &&
        now - lastKbIndex >= ctx.config.kbIndexIntervalMs
      ) {
        // 异步索引：不阻塞本拍后面的维护，也不阻塞 HTTP/MCP。
        indexKb();
      }
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      // 立即跑一拍：重启后不需要等 30 秒才开始回收过期租约。
      // 但首轮 KB 索引必须等 listen 之后由 indexKb() 触发：
      // 否则 worker.start() 会先于端口监听把事件循环占住。
      lastKbIndex = ctx.clock.now();
      tick();
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      // 索引可能正在 await 文件读取或批次让出；abort 让它在下一个检查点停下。
      kbAbort?.abort();
    },
    indexKb,
    async waitForIdle(): Promise<void> {
      await kbTask;
    },
  };
}
