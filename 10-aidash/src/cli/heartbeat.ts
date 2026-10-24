import { isAuthError, errorMessage } from './errors.js';
import type { WatchConfig } from './config.js';
import type { Logger } from './log.js';
import type { AidashMcpClient } from './mcp-client.js';

/**
 * 心跳循环。
 *
 * 为什么心跳和主循环分开计时：
 * 一次任务可能跑几十分钟，轮询间隔也可能被用户调大；心跳必须独立按固定间隔发送，
 * 否则服务端会把 harness 判成 offline。401 是例外：立刻停，不重试。
 */

export interface HeartbeatContext {
  client: AidashMcpClient;
  config: WatchConfig;
  logger: Logger;
}

export async function sendHeartbeat(ctx: HeartbeatContext, busy: boolean): Promise<void> {
  await ctx.client.call(
    'harness.heartbeat',
    {
      harness_id: ctx.config.harness_id,
      status_hint: busy ? 'busy' : 'idle',
    },
    { timeoutMs: 10_000 },
  );
}

export class HeartbeatLoop {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private busy = false;
  private stopped = false;
  private authFailed = false;

  /** 401 之后禁止任何后续 MCP 调用（包括“尽力释放”），调用方据此跳过收尾写操作。 */
  get hasAuthFailed(): boolean {
    return this.authFailed;
  }

  constructor(
    private readonly ctx: HeartbeatContext,
    private readonly onFatal: (error: unknown) => void,
  ) {}

  start(): void {
    void this.tick();
    const timer = setInterval(() => {
      void this.tick();
    }, this.ctx.config.heartbeat_interval_seconds * 1000);
    timer.unref();
    this.timer = timer;
  }

  setBusy(value: boolean): void {
    this.busy = value;
  }

  async stop(graceful: boolean): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!graceful) return;
    try {
      await sendHeartbeat(this.ctx, false);
    } catch (error) {
      this.ctx.logger.warn(`停止前最后一次心跳失败：${errorMessage(error)}`);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    try {
      await sendHeartbeat(this.ctx, this.busy);
    } catch (error) {
      if (isAuthError(error)) {
        // 401 是终态：停表、标记，并让主循环立即退出；不再发任何请求。
        this.authFailed = true;
        this.stopped = true;
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        this.onFatal(error);
        return;
      }
      this.ctx.logger.warn(`心跳失败：${errorMessage(error)}`);
    } finally {
      this.inFlight = false;
    }
  }
}
