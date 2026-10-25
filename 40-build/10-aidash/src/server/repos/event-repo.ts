import type { Db } from '../db/connection.js';

/* ------------------------------------------------------------------ *
 * 事件流水：card_event / task_event
 * 与 audit_log 的分工：事件是“业务时间线”，审计是“谁在什么请求里做了什么”。
 * ------------------------------------------------------------------ */

export class EventRepo {
  constructor(private readonly db: Db) {}

  card(cardId: string, event: string, actor: string | null, detail: unknown, now: number): void {
    this.db
      .prepare(
        'INSERT INTO card_event(card_id, event, actor, detail_json, created_at) VALUES (?,?,?,?,?)',
      )
      .run(cardId, event, actor, detail === undefined ? null : JSON.stringify(detail), now);
  }

  task(taskId: string, event: string, actor: string | null, detail: unknown, now: number): void {
    this.db
      .prepare(
        'INSERT INTO task_event(task_id, event, actor, detail_json, created_at) VALUES (?,?,?,?,?)',
      )
      .run(taskId, event, actor, detail === undefined ? null : JSON.stringify(detail), now);
  }

  listCard(cardId: string, limit = 200): unknown[] {
    return this.db
      .prepare('SELECT * FROM card_event WHERE card_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(cardId, limit);
  }

  listTask(taskId: string, limit = 200): unknown[] {
    return this.db
      .prepare('SELECT * FROM task_event WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(taskId, limit);
  }
}
