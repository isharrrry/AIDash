import type { KbDoc, Page } from '../../shared/types.js';
import type { Db } from '../db/connection.js';

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

/**
 * 查询侧单字符判定。
 *
 * 这两个正则故意不带 g：带 g 的 RegExp.test 会记住 lastIndex，
 * 在逐字符循环里第二次调用就可能从中间位置继续匹配，结果时对时错。
 * 汉字范围与上方 map/segmentCjk 保持一致。
 */
const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿]/;
const ASCII_ALNUM = /[A-Za-z0-9]/;

/**
 * 按字符类别把一个查询片段切成 token，规则必须和索引侧对齐：
 * - 汉字 → 每个字一个 token（索引侧 segmentCjk 存的就是“登 录”）；
 * - ASCII 字母/数字连续段 → 整段一个 token（大小写折叠交给 FTS5 unicode61，不在这里 lower）；
 * - 其余字符（空白、中英文标点、FTS5 语法字符）→ 分隔符，直接丢弃。
 *
 * 为什么要丢掉标点：旧实现只要片段里出现一个汉字，就把“片段内每个字符”
 * 都塞进短语。于是 `登录500` 变成 `"登 录 5 0 0"`，而索引 token 是 `500`，
 * 短语要求相邻且逐字相等，必然 0 命中；`"`、`*`、`(` 等语法字符也会被原样带进查询。
 */
function tokenizeQueryChunk(chunk: string): string[] {
  const tokens: string[] = [];
  let ascii = '';
  const flushAscii = (): void => {
    if (ascii) {
      tokens.push(ascii);
      ascii = '';
    }
  };
  for (const ch of chunk) {
    if (CJK_CHAR.test(ch)) {
      flushAscii();
      tokens.push(ch);
    } else if (ASCII_ALNUM.test(ch)) {
      ascii += ch;
    } else {
      flushAscii();
    }
  }
  flushAscii();
  return tokens;
}

/**
 * 查询转 FTS5 MATCH 表达式。
 *
 * 安全策略：先按空白分片再分词，token 只可能由 ASCII 字母数字或单个汉字组成；
 * 最后仍整体包进双引号并转义内部双引号，作为纵深防御（正常分词后不会出现引号）。
 *
 * 语义取舍：分片内用短语，保留“登 录”这类相邻要求；分片间用 AND，
 * 与旧实现的多关键词语义一致。纯标点分片没有 token，直接跳过，
 * 避免拼出空短语 `""`（FTS5 会报语法错误而被误判为降级）。
 */
function buildFtsQuery(raw: string): string {
  const chunks = raw.trim().split(/\s+/).filter(Boolean);
  const terms: string[] = [];
  for (const chunk of chunks) {
    const tokens = tokenizeQueryChunk(chunk);
    if (tokens.length === 0) continue;
    const phrase = tokens.join(' ').replace(/"/g, '""');
    terms.push(`"${phrase}"`);
  }
  return terms.join(' AND ');
}

export interface KbSearchOptions {
  type?: string;
  tags?: string[];
  top_k?: number;
  /** 分页偏移，来自 REST 的 page 参数换算。 */
  offset?: number;
  /**
   * FTS 查询失败、已退化为 LIKE 子串搜索时调用。
   *
   * 为什么需要它：LIKE 只能匹配标题/描述里的连续子串，正文命中和分词都被丢掉，
   * 结果会明显变少甚至为 0。以前这个 catch 是静默的，用户只会看到「搜不到」。
   * 仓库层不直接依赖日志器（它只负责存取），所以把「发生了降级」交回调用方决定怎么喊。
   */
  onDegraded?: (error: unknown) => void;
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
    } catch (error) {
      // FTS 语法错误（比如用户输入了裸引号）不应 500：退化为 LIKE 子串搜索。
      // 但必须告诉调用方「这次是降级结果」——否则用户会以为自己搜的词真的不存在。
      options.onDegraded?.(error);
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
