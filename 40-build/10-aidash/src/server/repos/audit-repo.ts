import { createHash } from 'node:crypto';
import type { AuditEntry, Page } from '../../shared/types.js';
import type { Db } from '../db/connection.js';

/* ------------------------------------------------------------------ *
 * 审计：只追加 + 哈希链
 * ------------------------------------------------------------------ */

export interface AuditInput {
  ts: number;
  actor_label: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  result: 'ok' | 'denied' | 'error';
  request_id: string | null;
  detail_json: string | null;
}

export interface AuditFilter {
  since?: number;
  until?: number;
  action?: string;
  object_type?: string;
  object_id?: string;
  result?: 'ok' | 'denied' | 'error';
  page?: number;
  page_size?: number;
}

/**
 * hash = sha256(prev_hash + 规范化字段)。
 * 为什么要包含 prev_hash：任何一条被改或中间被删，后面的链都会对不上，
 * 配合 001 的 no-update/no-delete 触发器形成“改不了 + 改得掉也能发现”的双保险。
 */
function chainHash(prevHash: string | null, e: AuditInput): string {
  const canonical = JSON.stringify([
    prevHash ?? '',
    e.ts,
    e.actor_label,
    e.action,
    e.object_type,
    e.object_id,
    e.result,
    e.request_id,
    e.detail_json,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  /**
   * uq_audit_request 让 request_id 只能出现一次：
   * 一次请求通常写一条主审计；同一请求内的次要动作传 null，避免约束冲突。
   */
  append(entry: AuditInput): AuditEntry {
    const run = this.db.transaction((): AuditEntry => {
      const last = this.db
        .prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')
        .get() as { hash: string } | undefined;
      const prev_hash = last?.hash ?? null;
      const hash = chainHash(prev_hash, entry);
      const info = this.db
        .prepare(
          `INSERT INTO audit_log
           (ts, actor_label, action, object_type, object_id, result, request_id,
            detail_json, prev_hash, hash)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          entry.ts,
          entry.actor_label,
          entry.action,
          entry.object_type,
          entry.object_id,
          entry.result,
          entry.request_id,
          entry.detail_json,
          prev_hash,
          hash,
        );
      return {
        id: Number(info.lastInsertRowid),
        ...entry,
        prev_hash,
        hash,
      };
    });
    return run.immediate();
  }

  list(filter: AuditFilter = {}): Page<AuditEntry> {
    const page = filter.page ?? 1;
    const pageSize = filter.page_size ?? 50;
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.since !== undefined) {
      where.push('ts >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      where.push('ts <= ?');
      params.push(filter.until);
    }
    if (filter.action) {
      where.push('action = ?');
      params.push(filter.action);
    }
    if (filter.object_type) {
      where.push('object_type = ?');
      params.push(filter.object_type);
    }
    if (filter.object_id) {
      where.push('object_id = ?');
      params.push(filter.object_id);
    }
    if (filter.result) {
      where.push('result = ?');
      params.push(filter.result);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`)
        .get(...params) as { n: number }
    ).n;
    const items = this.db
      .prepare(`SELECT * FROM audit_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as AuditEntry[];
    return { items, page, page_size: pageSize, total, has_more: page * pageSize < total };
  }

  lastHash(): string | null {
    const row = this.db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    return row?.hash ?? null;
  }

  /** 启动自检与测试用：返回第一条断链的位置。 */
  verifyChain(): { ok: boolean; broken_at?: number } {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all() as AuditEntry[];
    let prev: string | null = null;
    for (const row of rows) {
      const expected = chainHash(prev, {
        ts: row.ts,
        actor_label: row.actor_label,
        action: row.action,
        object_type: row.object_type,
        object_id: row.object_id,
        result: row.result,
        request_id: row.request_id,
        detail_json: row.detail_json,
      });
      if (row.prev_hash !== prev || row.hash !== expected) return { ok: false, broken_at: row.id };
      prev = row.hash;
    }
    return { ok: true };
  }
}
