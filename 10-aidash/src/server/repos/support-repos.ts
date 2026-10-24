import { createHash } from 'node:crypto';
import type {
  Artifact,
  AuditEntry,
  Harness,
  HarnessStatus,
  KbDoc,
  Page,
} from '../../shared/types.js';
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

/* ------------------------------------------------------------------ *
 * artifact
 * ------------------------------------------------------------------ */

export class ArtifactRepo {
  constructor(private readonly db: Db) {}

  insert(artifact: Artifact): Artifact {
    this.db
      .prepare(
        `INSERT INTO artifact(id, card_id, kind, url, summary, size_bytes, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        artifact.id,
        artifact.card_id,
        artifact.kind,
        artifact.url,
        artifact.summary,
        artifact.size_bytes,
        artifact.created_at,
      );
    return artifact;
  }

  listByCard(cardId: string): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifact WHERE card_id = ? ORDER BY created_at DESC')
      .all(cardId) as Artifact[];
  }

  get(id: string): Artifact | undefined {
    return this.db.prepare('SELECT * FROM artifact WHERE id = ?').get(id) as
      | Artifact
      | undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 知识库：只读索引
 * ------------------------------------------------------------------ */

/** 中日韩统一表意文字范围（含扩展 A 与兼容区）。 */
const CJK = /[㐀-䶿一-鿿豈-﫿]/g;

/**
 * 中文逐字分词（03 §KB）。
 * 原理：FTS5 的 unicode61 不认识中文词边界，一整段汉字会被当成一个 token，
 * 于是“登录失败”搜不到“登录接口失败”。把每个汉字拆成独立 token 后，
 * 查询侧用短语 `"登 录"` 就能要求相邻，既保留顺序又支持任意子串起点。
 */
export function segmentCjk(text: string): string {
  return text
    .replace(CJK, (ch) => ` ${ch} `)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把索引期的逐字空格还原成正常中文。
 *
 * 写索引时 `segmentCjk` 把“登录”拆成“登 录”，FTS 的 snippet 直接返回索引文本，
 * 于是搜索结果会显示成“登 录 排 查”，模型读起来也像乱码。这里只在汉字与汉字
 * （以及汉字与 `<mark>` 标签）之间去空格，保留“登录 500”这类中西文之间的空格。
 */
function desegmentSnippet(snippet: string): string {
  return snippet
    .replace(/([㐀-䶿一-鿿豈-﫿])\s+(?=[㐀-䶿一-鿿豈-﫿])/g, '$1')
    .replace(/(<\/?mark>)\s+(?=[㐀-䶿一-鿿豈-﫿])/g, '$1')
    .replace(/([㐀-䶿一-鿿豈-﫿])\s+(<\/?mark>)/g, '$1$2')
    .replace(/(<\/mark>)\s+(<mark>)/g, '$1$2');
}

function buildFtsQuery(raw: string): string {
  const chunks = raw.trim().split(/\s+/).filter(Boolean);
  const terms = chunks.map((chunk) => {
    const hasCjk = /[㐀-䶿一-鿿豈-﫿]/.test(chunk);
    if (hasCjk) {
      const chars = Array.from(chunk.replace(/\s+/g, ''));
      return `"${chars.join(' ')}"`;
    }
    return `"${chunk.replace(/"/g, '""')}"`;
  });
  return terms.join(' AND ');
}

export interface KbSearchOptions {
  type?: string;
  tags?: string[];
  top_k?: number;
  /** 分页偏移，来自 REST 的 page 参数换算。 */
  offset?: number;
}

export interface KbSearchHit {
  path: string;
  type: string;
  title: string | null;
  description: string | null;
  tags: string[];
  doc_date: string | null;
  snippet: string;
  score: number;
}

export class KbRepo {
  constructor(private readonly db: Db) {}

  getByPath(path: string): KbDoc | undefined {
    return this.db.prepare('SELECT * FROM kb_doc WHERE path = ?').get(path) as KbDoc | undefined;
  }

  /**
   * 写入或更新索引：kb_doc 是元数据，kb_fts 用 rowid = kb_doc.id 关联正文。
   * 先删后插 FTS 行，避免 FTS5 的 delete 语义要求按原值删除带来的麻烦。
   */
  upsertDoc(
    doc: {
      path: string;
      type: string;
      title: string | null;
      description: string | null;
      tags_json: string | null;
      doc_date: string | null;
      hash: string;
      indexed_at: number;
    },
    body: string,
  ): { id: number; unchanged: boolean } {
    const existing = this.getByPath(doc.path);
    if (existing && existing.hash === doc.hash) {
      return { id: existing.id, unchanged: true };
    }
    const id = this.db.transaction((): number => {
      this.db
        .prepare(
          `INSERT INTO kb_doc(path, type, title, description, tags_json, doc_date, hash, indexed_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET
             type = excluded.type, title = excluded.title, description = excluded.description,
             tags_json = excluded.tags_json, doc_date = excluded.doc_date,
             hash = excluded.hash, indexed_at = excluded.indexed_at`,
        )
        .run(
          doc.path,
          doc.type,
          doc.title,
          doc.description,
          doc.tags_json,
          doc.doc_date,
          doc.hash,
          doc.indexed_at,
        );
      const row = this.db.prepare('SELECT id FROM kb_doc WHERE path = ?').get(doc.path) as {
        id: number;
      };
      this.db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(row.id);
      this.db
        .prepare('INSERT INTO kb_fts(rowid, title, description, body, tags) VALUES (?,?,?,?,?)')
        .run(
          row.id,
          segmentCjk(doc.title ?? ''),
          segmentCjk(doc.description ?? ''),
          segmentCjk(body),
          segmentCjk(parseTags(doc.tags_json).join(' ')),
        );
      return row.id;
    })();
    return { id, unchanged: false };
  }

  removeByPath(path: string): boolean {
    const existing = this.getByPath(path);
    if (!existing) return false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(existing.id);
      this.db.prepare('DELETE FROM kb_doc WHERE id = ?').run(existing.id);
    })();
    return true;
  }

  search(query: string, options: KbSearchOptions = {}): KbSearchHit[] {
    const limit = options.top_k ?? 10;
    const offset = options.offset ?? 0;
    const filters: string[] = [];
    const filterParams: unknown[] = [];
    if (options.type) {
      filters.push('d.type = ?');
      filterParams.push(options.type);
    }
    for (const tag of options.tags ?? []) {
      filters.push("d.tags_json LIKE ? ESCAPE '\\'");
      filterParams.push(`%${tag.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const filterSql = filters.length ? ` AND ${filters.join(' AND ')}` : '';

    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.db
        .prepare(
          // FTS5 的 MATCH/bm25/snippet 只认真实表名，不认别名：
          // 写成 `FROM kb_fts f ... WHERE f MATCH ?` 会抛 "no such column: f"，
          // 而这里原本的 catch 会把它静默降级成 LIKE，导致多词查询永远 0 命中。
          `SELECT d.path, d.type, d.title, d.description, d.tags_json, d.doc_date,
                  snippet(kb_fts, 2, '<mark>', '</mark>', '…', 24) AS snippet,
                  bm25(kb_fts) AS score
           FROM kb_fts JOIN kb_doc d ON d.id = kb_fts.rowid
           WHERE kb_fts MATCH ?${filterSql}
           ORDER BY score ASC, d.indexed_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(buildFtsQuery(query), ...filterParams, limit, offset) as Array<
        Record<string, unknown>
      >;
    } catch {
      // FTS 语法错误（比如用户输入了裸引号）不应 500：退化为 LIKE 子串搜索。
      const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      rows = this.db
        .prepare(
          `SELECT d.path, d.type, d.title, d.description, d.tags_json, d.doc_date,
                  '' AS snippet, 0 AS score
           FROM kb_doc d
           WHERE (d.title LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\')
             ${filterSql}
           ORDER BY d.indexed_at DESC LIMIT ? OFFSET ?`,
        )
        .all(like, like, ...filterParams, limit, offset) as Array<Record<string, unknown>>;
    }

    return rows.map((row) => ({
      path: String(row.path),
      type: String(row.type),
      title: (row.title as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      tags: parseTags((row.tags_json as string | null) ?? null),
      doc_date: (row.doc_date as string | null) ?? null,
      snippet: desegmentSnippet(String(row.snippet ?? '')),
      score: Number(row.score ?? 0),
    }));
  }

  listDocs(options: { type?: string; page?: number; page_size?: number } = {}): Page<KbDoc> {
    const page = options.page ?? 1;
    const pageSize = options.page_size ?? 50;
    const where = options.type ? 'WHERE type = ?' : '';
    const params = options.type ? [options.type] : [];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM kb_doc ${where}`).get(...params) as { n: number }
    ).n;
    const items = this.db
      .prepare(`SELECT * FROM kb_doc ${where} ORDER BY path LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as KbDoc[];
    return { items, page, page_size: pageSize, total, has_more: page * pageSize < total };
  }

  stats(): {
    docs: number;
    types: Array<{ type: string; count: number }>;
    last_indexed_at: number | null;
  } {
    const docs = (this.db.prepare('SELECT COUNT(*) AS n FROM kb_doc').get() as { n: number }).n;
    const types = this.db
      .prepare('SELECT type, COUNT(*) AS count FROM kb_doc GROUP BY type ORDER BY type')
      .all() as Array<{ type: string; count: number }>;
    const last = this.db.prepare('SELECT MAX(indexed_at) AS ts FROM kb_doc').get() as {
      ts: number | null;
    };
    return { docs, types, last_indexed_at: last.ts };
  }

  /** 索引任务用：文件从磁盘消失时要能清理旧记录。 */
  listPaths(): string[] {
    return (this.db.prepare('SELECT path FROM kb_doc').all() as Array<{ path: string }>).map(
      (row) => row.path,
    );
  }
}

function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

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
