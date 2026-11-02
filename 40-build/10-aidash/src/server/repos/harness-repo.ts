import type { Harness, HarnessStatus } from '../../shared/types.js';
import type { Db } from '../db/connection.js';

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

export class HarnessRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Harness | undefined {
    return this.db.prepare('SELECT * FROM harness WHERE harness_id = ?').get(id) as
      | Harness
      | undefined;
  }

  upsert(input: {
    harness_id: string;
    name: string;
    host: string | null;
    capabilities_json: string | null;
    now: number;
  }): Harness {
    this.db
      .prepare(
        `INSERT INTO harness
         (harness_id, name, host, capabilities_json, status, busy, busy_at,
          last_seen, registered_at, updated_at)
         VALUES (?,?,?,?, 'online', 0, NULL, ?, ?, ?)
         ON CONFLICT(harness_id) DO UPDATE SET
           name = excluded.name,
           host = excluded.host,
           capabilities_json = excluded.capabilities_json,
           status = CASE WHEN harness.status = 'disabled' THEN 'disabled' ELSE 'online' END,
           -- 重新注册通常意味着进程刚启动/重连，先按空闲展示；
           -- 真在跑任务的执行器会在下一拍（或立即）心跳里把 busy 报回来。
           busy = 0,
           busy_at = NULL,
           last_seen = excluded.last_seen,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.harness_id,
        input.name,
        input.host,
        input.capabilities_json,
        input.now,
        input.now,
        input.now,
      );
    return this.get(input.harness_id)!;
  }

  /**
   * 上报存活与运行态。
   *
   * statusHint 省略（null）时保留原来的 busy：老客户端不会传这个字段，
   * 不能因为一次“无提示心跳”就把正在跑任务的执行器误标成空闲。
   * disabled 是人工封禁，心跳不能把它改回 online。
   */
  heartbeat(id: string, now: number, statusHint: 'idle' | 'busy' | null = null): boolean {
    const busy = statusHint === null ? null : statusHint === 'busy' ? 1 : 0;
    const result = this.db
      .prepare(
        `UPDATE harness SET last_seen = ?, updated_at = ?,
                status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'online' END,
                busy = COALESCE(?, busy),
                busy_at = CASE WHEN ? IS NULL THEN busy_at ELSE ? END
         WHERE harness_id = ?`,
      )
      .run(now, now, busy, busy, now, id);
    return result.changes === 1;
  }

  list(): Harness[] {
    return this.db.prepare('SELECT * FROM harness ORDER BY last_seen DESC').all() as Harness[];
  }

  setStatus(id: string, status: HarnessStatus, now: number): void {
    // 人工改状态时顺手清掉运行态：无论是封禁还是手动置为 online，
    // 旧的 busy=1 都不该继续显示“运行中”；真在干活会由下一拍心跳补回来。
    this.db
      .prepare('UPDATE harness SET status = ?, busy = 0, updated_at = ? WHERE harness_id = ?')
      .run(status, now, id);
  }

  markOffline(cutoff: number, now: number): number {
    const result = this.db
      .prepare(
        `UPDATE harness SET status = 'offline', busy = 0, updated_at = ?
         WHERE status = 'online' AND last_seen < ?`,
      )
      .run(now, cutoff);
    return result.changes;
  }
}
