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
         (harness_id, name, host, capabilities_json, status, last_seen, registered_at, updated_at)
         VALUES (?,?,?,?, 'online', ?, ?, ?)
         ON CONFLICT(harness_id) DO UPDATE SET
           name = excluded.name,
           host = excluded.host,
           capabilities_json = excluded.capabilities_json,
           status = CASE WHEN harness.status = 'disabled' THEN 'disabled' ELSE 'online' END,
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

  /** disabled 是人工封禁，心跳不能把它改回 online。 */
  heartbeat(id: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE harness SET last_seen = ?, updated_at = ?,
                status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'online' END
         WHERE harness_id = ?`,
      )
      .run(now, now, id);
    return result.changes === 1;
  }

  list(): Harness[] {
    return this.db.prepare('SELECT * FROM harness ORDER BY last_seen DESC').all() as Harness[];
  }

  setStatus(id: string, status: HarnessStatus, now: number): void {
    this.db
      .prepare('UPDATE harness SET status = ?, updated_at = ? WHERE harness_id = ?')
      .run(status, now, id);
  }

  markOffline(cutoff: number, now: number): number {
    const result = this.db
      .prepare(
        `UPDATE harness SET status = 'offline', updated_at = ?
         WHERE status = 'online' AND last_seen < ?`,
      )
      .run(now, cutoff);
    return result.changes;
  }
}
