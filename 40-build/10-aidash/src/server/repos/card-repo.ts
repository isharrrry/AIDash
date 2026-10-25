import type {
  Card,
  CardStatus,
  CardType,
  Page,
  Priority,
  StatusResult,
} from '../../shared/types.js';
import type { Db } from '../db/connection.js';

export interface CardListFilter {
  channelId?: string;
  channelKey?: string;
  /**
   * 按通道所属项目过滤（channel_key 的第二段）。
   * 为什么落在 SQL 而不是让调用方先查通道：一个项目可能对应多个话题通道，
   * Web 的“只看本项目”需要一次分页查询把跨通道的卡一起取回。
   */
  project?: string;
  types?: CardType[];
  statuses?: CardStatus[];
  priorities?: Priority[];
  includeArchived?: boolean;
  q?: string;
  taskId?: string;
  /**
   * 只查没有任务归属的卡。
   *
   * 新卡已强制非 question 必须带 task_id，这个过滤只服务于历史数据：
   * 旧版允许无任务发卡，升级后这些卡不在任何任务信息流里，
   * 需要给用户一个“历史遗留”入口，而不是让它们凭空消失。
   */
  unassigned?: boolean;
  page?: number;
  page_size?: number;
  sort?: 'created_at' | 'updated_at' | 'priority' | 'due_at';
  order?: 'asc' | 'desc';
}

const SORT_SQL: Record<NonNullable<CardListFilter['sort']>, string> = {
  created_at: 'c.created_at',
  updated_at: 'c.updated_at',
  priority: "CASE c.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END",
  due_at: 'c.due_at',
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * card 表的数据访问。
 * 搜索为什么用 LIKE 而不是 FTS：05 只定义 14 张表（kb_fts 是 TBL-009），
 * 再建 card_fts 会破坏计数基线；10k 卡片规模下 LIKE 足够，且可在后续迁移中替换。
 */
export class CardRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Card | undefined {
    return this.db.prepare('SELECT * FROM card WHERE id = ?').get(id) as Card | undefined;
  }

  findByIdem(channelId: string, key: string): Card | undefined {
    return this.db
      .prepare('SELECT * FROM card WHERE channel_id = ? AND idempotency_key = ?')
      .get(channelId, key) as Card | undefined;
  }

  insert(card: Card): Card {
    this.db
      .prepare(
        `INSERT INTO card
         (id, channel_id, type, status, priority, title, body_md, background_md,
          goal_md, research_md, decision_md, message_md,
          summary, detail_md, severity, recipient, channel_kind, reason, handoff_state,
          options_json, allow_free_text, default_action, due_at, answer_json, answered_at,
          artifact_url, artifact_kind, links_json, result, suggestions_json, kb_refs_json,
          confidence, blocking, task_id, enrichment_status, enrichment_json, idempotency_key,
          created_by, created_at, updated_at, archived_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        card.id,
        card.channel_id,
        card.type,
        card.status,
        card.priority,
        card.title,
        card.body_md,
        card.background_md,
        // 决策卡四段背景：goal/research/decision 与 background_md 同属“为什么做这个决定”，
        // 分开存是为了 Web 分块渲染，也避免把长文拼进一个字段后无法单独检索。
        card.goal_md,
        card.research_md,
        card.decision_md,
        card.message_md,
        card.summary,
        card.detail_md,
        card.severity,
        card.recipient,
        card.channel_kind,
        card.reason,
        card.handoff_state,
        card.options_json,
        card.allow_free_text,
        card.default_action,
        card.due_at,
        card.answer_json,
        card.answered_at,
        card.artifact_url,
        card.artifact_kind,
        card.links_json,
        card.result,
        card.suggestions_json,
        card.kb_refs_json,
        card.confidence,
        card.blocking,
        card.task_id,
        card.enrichment_status,
        card.enrichment_json,
        card.idempotency_key,
        card.created_by,
        card.created_at,
        card.updated_at,
        card.archived_at,
      );
    return card;
  }

  updateFields(id: string, patch: Partial<Card>): void {
    const allowed = new Set<string>([
      'title',
      'priority',
      'body_md',
      'background_md',
      'goal_md',
      'research_md',
      'decision_md',
      'message_md',
      'summary',
      'detail_md',
      'severity',
      'recipient',
      'channel_kind',
      'reason',
      'handoff_state',
      'options_json',
      'allow_free_text',
      'default_action',
      'due_at',
      'answer_json',
      'answered_at',
      'artifact_url',
      'artifact_kind',
      'links_json',
      'result',
      'suggestions_json',
      'kb_refs_json',
      'confidence',
      'blocking',
      'task_id',
      'enrichment_status',
      'enrichment_json',
      'status',
      'archived_at',
      'updated_at',
    ]);
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE card SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  /** 返回 false 表示竞态中已被别人答掉/关掉，调用方必须据此报 CONFLICT。 */
  setAnswered(
    id: string,
    answerJson: string,
    answeredAt: number,
    status: CardStatus = 'answered',
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE card
         SET answer_json = ?, answered_at = ?, status = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(answerJson, answeredAt, status, answeredAt, id);
    return result.changes === 1;
  }

  setStatus(id: string, status: CardStatus, now: number, archived = false): void {
    this.db
      .prepare(
        `UPDATE card
         SET status = ?, updated_at = ?,
             archived_at = CASE WHEN ? = 1 THEN ? ELSE archived_at END
         WHERE id = ?`,
      )
      .run(status, now, archived ? 1 : 0, now, id);
  }

  setEnrichment(
    id: string,
    status: Card['enrichment_status'],
    enrichmentJson: string | null,
  ): void {
    this.db
      .prepare('UPDATE card SET enrichment_status = ?, enrichment_json = ? WHERE id = ?')
      .run(status, enrichmentJson, id);
  }

  /** 列表与计数共用同一段 WHERE，避免分页总数与列表口径不一致。 */
  private buildWhere(filter: CardListFilter): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.channelId) {
      where.push('c.channel_id = ?');
      params.push(filter.channelId);
    }
    if (filter.channelKey) {
      where.push('ch.channel_key = ?');
      params.push(filter.channelKey);
    }
    // project 存在 channel 表上；列表 SQL 已 JOIN channel（别名 ch），这里直接复用。
    if (filter.project) {
      where.push('ch.project = ?');
      params.push(filter.project);
    }
    if (filter.taskId) {
      where.push('c.task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.unassigned) {
      where.push('c.task_id IS NULL');
    }
    if (filter.types?.length) {
      where.push(`c.type IN (${filter.types.map(() => '?').join(',')})`);
      params.push(...filter.types);
    }
    if (filter.statuses?.length) {
      where.push(`c.status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    } else if (!filter.includeArchived) {
      where.push("c.status <> 'archived'");
    }
    if (filter.priorities?.length) {
      where.push(`c.priority IN (${filter.priorities.map(() => '?').join(',')})`);
      params.push(...filter.priorities);
    }
    if (filter.q?.trim()) {
      const like = `%${escapeLike(filter.q.trim())}%`;
      where.push(
        `(c.title LIKE ? ESCAPE '\\' OR c.body_md LIKE ? ESCAPE '\\'
          OR c.background_md LIKE ? ESCAPE '\\' OR c.message_md LIKE ? ESCAPE '\\'
          OR c.summary LIKE ? ESCAPE '\\' OR c.detail_md LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like, like, like, like, like);
    }

    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  /**
   * 卡片列表。
   *
   * 已读状态用 LEFT JOIN 一次带回：列表页每张卡都要显示“未读/已读”，
   * 若逐卡再查 card_read 会变成 N+1；LEFT JOIN 同时保留未读（r 行为 NULL）的卡。
   * COUNT 查询不 JOIN：总数与已读无关，少一次不必要的连接。
   */
  list(filter: CardListFilter = {}): Page<Card & { channel_key: string; read_at: number | null }> {
    const page = filter.page ?? 1;
    const pageSize = filter.page_size ?? 50;
    const { sql, params } = this.buildWhere(filter);
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM card c JOIN channel ch ON ch.id = c.channel_id ${sql}`,
        )
        .get(...params) as { n: number }
    ).n;

    const sort = SORT_SQL[filter.sort ?? 'created_at'];
    const order = filter.order === 'asc' ? 'ASC' : 'DESC';
    // due_at 排序时 NULL 永远排后面，避免“没截止时间”抢占第一屏。
    const orderSql =
      (filter.sort ?? 'created_at') === 'due_at'
        ? `c.due_at IS NULL ASC, ${sort} ${order}`
        : `${sort} ${order}`;

    const rows = this.db
      .prepare(
        `SELECT c.*, ch.channel_key, r.read_at AS read_at
         FROM card c
         JOIN channel ch ON ch.id = c.channel_id
         LEFT JOIN card_read r ON r.card_id = c.id
         ${sql}
         ORDER BY ${orderSql}, c.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as Array<
      Card & { channel_key: string; read_at: number | null }
    >;

    return {
      items: rows,
      page,
      page_size: pageSize,
      total,
      has_more: page * pageSize < total,
    };
  }

  search(
    q: string,
    filter: Omit<CardListFilter, 'q'> = {},
  ): Page<Card & { channel_key: string; read_at: number | null }> {
    return this.list({ ...filter, q });
  }

  /* ------------------------------ 已读 ------------------------------ */

  /**
   * 标记已读。重复标记保留第一次的时间：
   * “什么时候第一次看到”是唯一有意义的事实，反复滚动不应把它改成最后一次。
   */
  markRead(cardId: string, now: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO card_read(card_id, read_at) VALUES (?, ?)')
      .run(cardId, now);
  }

  getReadAt(cardId: string): number | null {
    const row = this.db
      .prepare('SELECT read_at FROM card_read WHERE card_id = ?')
      .get(cardId) as { read_at: number } | undefined;
    return row?.read_at ?? null;
  }

  /** 批量取已读时间；未读的 id 不出现在 Map 里。 */
  readAtFor(cardIds: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (cardIds.length === 0) return result;
    const rows = this.db
      .prepare(
        `SELECT card_id, read_at FROM card_read
         WHERE card_id IN (${cardIds.map(() => '?').join(',')})`,
      )
      .all(...cardIds) as Array<{ card_id: string; read_at: number }>;
    for (const row of rows) result.set(row.card_id, row.read_at);
    return result;
  }

  /**
   * 通道内每个任务的未读数。
   *
   * 统计口径：挂了任务、未归档、card_read 无记录。
   * - 已归档卡不算：归档是“从视野里拿走”，再冒红点等于把归档撤销了；
   * - question 也算：它可能同时出现在决策台和任务信息流里，两边都该有提示，
   *   已读状态只由“在任务信息流里滚到它”来消除。
   */
  countUnreadByTask(channelId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT c.task_id AS task_id, COUNT(*) AS n
         FROM card c
         LEFT JOIN card_read r ON r.card_id = c.id
         WHERE c.channel_id = ? AND c.task_id IS NOT NULL
           AND c.status <> 'archived' AND r.card_id IS NULL
         GROUP BY c.task_id`,
      )
      .all(channelId) as Array<{ task_id: string; n: number }>;
    return new Map(rows.map((row) => [row.task_id, row.n]));
  }

  /** 按任务 id 批量取未读数（任务列表可能跨通道，不能只按 channel 统计）。 */
  countUnreadForTasks(taskIds: string[]): Map<string, number> {
    if (taskIds.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT c.task_id AS task_id, COUNT(*) AS n
         FROM card c
         LEFT JOIN card_read r ON r.card_id = c.id
         WHERE c.task_id IN (${taskIds.map(() => '?').join(',')})
           AND c.status <> 'archived' AND r.card_id IS NULL
         GROUP BY c.task_id`,
      )
      .all(...taskIds) as Array<{ task_id: string; n: number }>;
    return new Map(rows.map((row) => [row.task_id, row.n]));
  }

  countUnreadForTask(taskId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM card c
           LEFT JOIN card_read r ON r.card_id = c.id
           WHERE c.task_id = ? AND c.status <> 'archived' AND r.card_id IS NULL`,
        )
        .get(taskId) as { n: number }
    ).n;
  }

  findOpenQuestionsDue(now: number, limit = 500): Card[] {
    return this.db
      .prepare(
        `SELECT * FROM card
         WHERE type = 'question' AND status = 'open' AND due_at IS NOT NULL AND due_at < ?
         ORDER BY due_at ASC LIMIT ?`,
      )
      .all(now, limit) as Card[];
  }

  findEvidenceCards(taskId: string): Card[] {
    return this.db
      .prepare(
        `SELECT * FROM card
         WHERE task_id = ? AND type IN ('status','artifact') AND status <> 'archived'
         ORDER BY created_at DESC`,
      )
      .all(taskId) as Card[];
  }

  findByIds(ids: string[]): Card[] {
    if (ids.length === 0) return [];
    return this.db
      .prepare(`SELECT * FROM card WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Card[];
  }

  countOpenQuestions(channelId?: string): number {
    const sql = channelId
      ? "SELECT COUNT(*) AS n FROM card WHERE type = 'question' AND status = 'open' AND channel_id = ?"
      : "SELECT COUNT(*) AS n FROM card WHERE type = 'question' AND status = 'open'";
    return (this.db.prepare(sql).get(...(channelId ? [channelId] : [])) as { n: number }).n;
  }

  countByStatus(status: CardStatus): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM card WHERE status = ?').get(status) as {
        n: number;
      }
    ).n;
  }

  /** 保留策略：只找“仍未归档且早于阈值”的卡，归档动作由 service 执行并写事件。 */
  findOlderThanOpen(cutoff: number, limit = 500): Card[] {
    return this.db
      .prepare(
        `SELECT * FROM card
         WHERE status IN ('open','answered','dismissed','expired') AND created_at < ?
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(cutoff, limit) as Card[];
  }

  findRecentByType(type: CardType, limit: number, channelId?: string): Card[] {
    const params: unknown[] = [type];
    let extra = '';
    if (channelId) {
      extra = ' AND channel_id = ?';
      params.push(channelId);
    }
    params.push(limit);
    return this.db
      .prepare(`SELECT * FROM card WHERE type = ?${extra} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as Card[];
  }

  findTopByPriority(priorities: Priority[], limit: number, channelId?: string): Card[] {
    if (priorities.length === 0) return [];
    const params: unknown[] = [...priorities];
    let extra = '';
    if (channelId) {
      extra = ' AND channel_id = ?';
      params.push(channelId);
    }
    params.push(limit);
    return this.db
      .prepare(
        `SELECT * FROM card
         WHERE type = 'question' AND status = 'open'
           AND priority IN (${priorities.map(() => '?').join(',')})${extra}
         ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
                  due_at IS NULL ASC, due_at ASC, created_at DESC
         LIMIT ?`,
      )
      .all(...params) as Card[];
  }

  setResult(id: string, result: StatusResult): void {
    this.db.prepare('UPDATE card SET result = ? WHERE id = ?').run(result, id);
  }
}
