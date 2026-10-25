import type { Db } from '../db/connection.js';

/* ------------------------------------------------------------------ *
 * setting
 * ------------------------------------------------------------------ */

export class SettingRepo {
  constructor(private readonly db: Db) {}

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value_json FROM setting WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown, now: number): void {
    this.db
      .prepare(
        `INSERT INTO setting(key, value_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), now);
  }

  all(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value_json FROM setting').all() as Array<{
      key: string;
      value_json: string;
    }>;
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value_json);
      } catch {
        result[row.key] = null;
      }
    }
    return result;
  }
}
