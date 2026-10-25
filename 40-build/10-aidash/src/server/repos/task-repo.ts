import type { Page, Task, TaskStatus, TreeNode, TaskView } from '../../shared/types.js';
import type { Db } from '../db/connection.js';

export interface TaskListFilter {
  channelId?: string;
  statuses?: TaskStatus[];
  assignee?: string;
  parentId?: string | null;
  q?: string;
  /** true=曾经标记过隐患（含已解除），false=从未标记；用于复盘。 */
  hasRisk?: boolean;
  /** true=只看仍未解除的隐患；比 hasRisk 更严格。 */
  riskOpen?: boolean;
  page?: number;
  page_size?: number;
}

export interface ClaimOutcome {
  ok: boolean;
  task?: Task;
  claimToken?: string | null;
  reason?: 'NOT_FOUND' | 'ALREADY_CLAIMED' | 'NOT_CLAIMABLE';
  /** true 表示同一个 harness 续租，沿用原令牌。 */
  renewed?: boolean;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * task 表的显式列清单。
 *
 * 为什么不用 `SELECT *`：description_md 可能内嵌 base64 截图（单条可达 2,000,000 字符）。
 * 批量查询即使最终把 description_md 置为 null，`SELECT *` 也已经把整段文本从 SQLite
 * 读进 Node 堆；任务树会周期性轮询，几十条带图任务就会造成内存尖峰。
 * 这里在 SQL 层直接投影成 `NULL`，数据库不需要把 TEXT 列的内容读出来。
 *
 * 迁移新增列时必须同步这个数组；漏掉会让列表字段变成 undefined，测试会暴露。
 */
const TASK_COLUMNS = [
  'id',
  'channel_id',
  'parent_id',
  'path',
  'title',
  'description_md',
  'kind',
  'category',
  'status',
  'priority',
  'assignee',
  'tags_json',
  'due_at',
  'claimed_by',
  'claim_token',
  'claim_expires_at',
  'claimed_at',
  'started_at',
  'blocked_at',
  'completed_at',
  'failed_at',
  'cancelled_at',
  'blocked_reason',
  'fail_reason',
  'cancel_reason',
  'end_notice_read_at',
  'defer_reason',
  'deferred_at',
  'deferred_until',
  'risk_note',
  'risk_flagged_at',
  'risk_resolved_at',
  'risk_resolution',
  'evidence_json',
  'idempotency_key',
  'created_by',
  'created_at',
  'updated_at',
] as const;

/** 生成 SELECT 投影：不需要正文时把 description_md 换成常量 NULL，避免读取大字段。 */
function taskColumns(includeDescription: boolean): string {
  return TASK_COLUMNS.map((column) =>
    column === 'description_md' && !includeDescription ? 'NULL AS description_md' : column,
  ).join(', ');
}

/**
 * task 表的数据访问。
 *
 * 物化路径格式：`/{id}/{childId}/`。
 * 为什么不用递归 CTE 查子树：路径前缀一次索引扫描就够，且移动节点只需重写前缀；
 * 代价是移动时要保证新父节点不在自己的子树里（由 service 的环检测负责）。
 */
export class TaskRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Task | undefined {
    return this.db.prepare('SELECT * FROM task WHERE id = ?').get(id) as Task | undefined;
  }

  /**
   * 幂等键按通道隔离查询（D-1）。
   *
   * 不能只按 key 查：同一 key 在另一个通道是「另一件事」，全局命中的话
   * 会把旧任务当成新请求的结果返回，并让请求通道留下空记录。
   * 对应迁移 017 把唯一索引改成了 (channel_id, idempotency_key)。
   */
  findByIdem(channelId: string, key: string): Task | undefined {
    return this.db
      .prepare('SELECT * FROM task WHERE channel_id = ? AND idempotency_key = ?')
      .get(channelId, key) as Task | undefined;
  }

  insert(task: Task): Task {
    this.db
      .prepare(
        `INSERT INTO task
         (id, channel_id, parent_id, path, title, description_md, kind, category, status, priority, assignee,
          tags_json, due_at, claimed_by, claim_token, claim_expires_at,
          claimed_at, started_at, blocked_at, completed_at, failed_at, cancelled_at,
          blocked_reason, fail_reason, cancel_reason, end_notice_read_at,
          defer_reason, deferred_at, deferred_until,
          risk_note, risk_flagged_at, risk_resolved_at, risk_resolution,
          evidence_json, idempotency_key, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        task.id,
        task.channel_id,
        task.parent_id,
        task.path,
        task.title,
        task.description_md,
        task.kind,
        task.category,
        task.status,
        task.priority,
        task.assignee,
        task.tags_json,
        task.due_at,
        task.claimed_by,
        task.claim_token,
        task.claim_expires_at,
        // 状态时间线落在 task 行上，Web 渲染任务树时不需要逐节点回查 task_event。
        task.claimed_at,
        task.started_at,
        task.blocked_at,
        task.completed_at,
        task.failed_at,
        task.cancelled_at,
        task.blocked_reason,
        task.fail_reason,
        task.cancel_reason,
        task.end_notice_read_at,
        task.defer_reason,
        task.deferred_at,
        task.deferred_until,
        task.risk_note,
        task.risk_flagged_at,
        task.risk_resolved_at,
        task.risk_resolution,
        task.evidence_json,
        task.idempotency_key,
        task.created_by,
        task.created_at,
        task.updated_at,
      );
    return task;
  }

  updateFields(id: string, patch: Partial<Task>): void {
    const allowed = new Set<string>([
      'parent_id',
      'path',
      'title',
      'description_md',
      'category',
      'status',
      'priority',
      'assignee',
      'tags_json',
      'due_at',
      'claimed_by',
      'claim_token',
      'claim_expires_at',
      'claimed_at',
      'started_at',
      'blocked_at',
      'completed_at',
      'failed_at',
      'cancelled_at',
      'blocked_reason',
      'fail_reason',
      'cancel_reason',
      'end_notice_read_at',
      'defer_reason',
      'deferred_at',
      'deferred_until',
      'risk_note',
      'risk_flagged_at',
      'risk_resolved_at',
      'risk_resolution',
      'evidence_json',
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
    this.db.prepare(`UPDATE task SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * 原子认领（G-T05）。
   * 判定完全交给单条 UPDATE 的 WHERE：两个 harness 同时抢，只有一个 changes=1，
   * 另一个拿到 changes=0 后重新读状态，不会出现“都以为自己抢到”。
   */
  claim(
    id: string,
    harnessId: string,
    claimToken: string,
    now: number,
    leaseSeconds: number,
  ): ClaimOutcome {
    const expires = now + leaseSeconds * 1000;
    const current = this.get(id);
    if (!current) return { ok: false, reason: 'NOT_FOUND' };

    // 同 owner 且租约未过期：续租，沿用原令牌（ADR-015 不新增 task.renew）。
    if (
      current.claimed_by === harnessId &&
      current.claim_token &&
      current.claim_expires_at !== null &&
      current.claim_expires_at > now &&
      ['claimed', 'in_progress', 'blocked'].includes(current.status)
    ) {
      this.db
        .prepare(
          `UPDATE task SET claim_expires_at = ?, updated_at = ?
           WHERE id = ? AND claimed_by = ? AND claim_token = ?`,
        )
        .run(expires, now, id, harnessId, current.claim_token);
      return { ok: true, task: this.get(id), claimToken: current.claim_token, renewed: true };
    }

    // pending 直接抢；过期租约允许接管（包含同 owner 过期的情况）。
    // 两条 UPDATE 都写 claimed_at：时间线记录“最近一次被谁在何时接手”，
    // 续租分支（上面的 if）刻意不写，否则续租会把原始认领时间覆盖成心跳时间。
    const pending = this.db
      .prepare(
        `UPDATE task
         SET status = 'claimed', claimed_by = ?, claim_token = ?, claim_expires_at = ?,
             claimed_at = ?, updated_at = ?,
             -- 认领等于“重新开始处理”：暂缓标记必须清掉，否则页面上会同时显示
             -- “待认领任务已开始”和“已暂缓”，两个信号互相打架。
             defer_reason = NULL, deferred_at = NULL, deferred_until = NULL
         WHERE id = ? AND status = 'pending'`,
      )
      .run(harnessId, claimToken, expires, now, now, id);
    if (pending.changes === 1) {
      return { ok: true, task: this.get(id), claimToken };
    }

    const takeover = this.db
      .prepare(
        `UPDATE task
         SET status = 'claimed', claimed_by = ?, claim_token = ?, claim_expires_at = ?,
             claimed_at = ?, updated_at = ?,
             defer_reason = NULL, deferred_at = NULL, deferred_until = NULL
         WHERE id = ? AND status IN ('claimed','in_progress','blocked')
           AND claim_expires_at IS NOT NULL AND claim_expires_at < ?`,
      )
      .run(harnessId, claimToken, expires, now, now, id, now);
    if (takeover.changes === 1) {
      return { ok: true, task: this.get(id), claimToken };
    }

    const latest = this.get(id);
    if (!latest) return { ok: false, reason: 'NOT_FOUND' };
    return {
      ok: false,
      reason: ['claimed', 'in_progress', 'blocked'].includes(latest.status)
        ? 'ALREADY_CLAIMED'
        : 'NOT_CLAIMABLE',
      task: latest,
    };
  }

  /**
   * 原子释放：令牌不匹配就不改，避免旧持有者把新持有者的任务打回 pending。
   *
   * 这里刻意不清空 started_at。释放只说明“当前没人干”，不说明“从来没开工”；
   * 把它抹掉会让 Web 上的时间线凭空少一段，用户在复盘时无法回答“上次干到几点”。
   * 当前状态由 status 表达，时间列只负责记录历史。
   */
  release(id: string, claimToken: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE task
         SET status = 'pending', claimed_by = NULL, claim_token = NULL,
             claim_expires_at = NULL, updated_at = ?
         WHERE id = ? AND claim_token = ? AND status IN ('claimed','in_progress','blocked')`,
      )
      .run(now, id, claimToken);
    return result.changes === 1;
  }

  /**
   * 取子树全部字段，供 copy 使用。
   *
   * 这里不能省 description_md：复制任务要把正文一起带过去。
   * 只做深度/环校验的调用方应改用 findSubtreePaths，别为了几个 path 读整行。
   */
  findSubtree(rootId: string): Task[] {
    const root = this.get(rootId);
    if (!root) return [];
    const prefix = escapeLike(root.path);
    return this.db
      .prepare(
        `SELECT ${taskColumns(true)} FROM task
          WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY path`,
      )
      .all(root.path, `${prefix}%`) as Task[];
  }

  /**
   * 只取子树路径。
   *
   * move 前的深度校验只需要“最深后代有多少层”；走 findSubtree 会把每个节点的
   * description_md（可能内嵌 base64 截图）一起读进 Node 堆。
   * 根节点也只投影 path，避免“为了查路径先读一次全文”。
   */
  findSubtreePaths(rootId: string): string[] {
    const root = this.db
      .prepare('SELECT path FROM task WHERE id = ?')
      .get(rootId) as { path: string } | undefined;
    if (!root) return [];
    const prefix = escapeLike(root.path);
    const rows = this.db
      .prepare("SELECT path FROM task WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY path")
      .all(root.path, `${prefix}%`) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  /**
   * 移动子树：把旧前缀换成新前缀。
   * SQL 里用 substr 拼接而不是循环逐条更新，保证一次语句完成，移动是原子的。
   */
  rewriteSubtreePath(oldPrefix: string, newPrefix: string): number {
    const result = this.db
      .prepare(
        `UPDATE task
         SET path = ? || substr(path, ?)
         WHERE path LIKE ? ESCAPE '\\'`,
      )
      .run(newPrefix, oldPrefix.length + 1, `${escapeLike(oldPrefix)}%`);
    return result.changes;
  }

  list(filter: TaskListFilter = {}, includeDescription = false): Page<Task> {
    const page = filter.page ?? 1;
    const pageSize = filter.page_size ?? 100;
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.channelId) {
      where.push('channel_id = ?');
      params.push(filter.channelId);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    if (filter.assignee) {
      where.push('assignee = ?');
      params.push(filter.assignee);
    }
    if (filter.parentId !== undefined) {
      if (filter.parentId === null) {
        where.push('parent_id IS NULL');
      } else {
        where.push('parent_id = ?');
        params.push(filter.parentId);
      }
    }
    if (filter.q?.trim()) {
      where.push("(title LIKE ? ESCAPE '\\' OR description_md LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(filter.q.trim())}%`;
      params.push(like, like);
    }
    if (filter.hasRisk === true) {
      where.push('risk_note IS NOT NULL');
    } else if (filter.hasRisk === false) {
      where.push('risk_note IS NULL');
    }
    if (filter.riskOpen === true) {
      where.push('risk_note IS NOT NULL AND risk_resolved_at IS NULL');
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM task ${whereSql}`)
        .get(...params) as { n: number }
    ).n;
    const items = this.db
      .prepare(
        `SELECT ${taskColumns(includeDescription)} FROM task ${whereSql}
         ORDER BY path LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as Task[];
    return { items, page, page_size: pageSize, total, has_more: page * pageSize < total };
  }

  /**
   * 通道内全量任务建树；单通道任务量在千级，内存建树比递归查询更简单。
   *
   * 默认不把 description_md 带进树：描述里可能内嵌 base64 截图，
   * 一棵几十个节点的树如果每个节点都带正文，一次轮询就是几 MB。
   */
  tree(channelId: string, includeDescription = false): TreeNode[] {
    const rows = this.db
      .prepare(
        `SELECT ${taskColumns(includeDescription)} FROM task
         WHERE channel_id = ? ORDER BY path`,
      )
      .all(channelId) as Task[];
    // 未读数由 TaskService 用 CardRepo 一次算好后填入：repo 只负责任务行，
    // 不跨表读 card/card_read，避免两套统计口径各自生长。
    const nodes = new Map<string, TreeNode>();
    for (const row of rows) {
      nodes.set(row.id, {
        ...toTaskView(row, '', includeDescription),
        children: [],
      });
    }
    const roots: TreeNode[] = [];
    for (const row of rows) {
      const node = nodes.get(row.id)!;
      if (row.parent_id && nodes.has(row.parent_id)) {
        nodes.get(row.parent_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /**
   * 回收过期租约。与 release 同理：只退回 pending，不抹 started_at。
   *
   * 这样“被回收”的任务在 Web 上仍能看到上次开工时间，
   * 用户能判断它是不是反复被捡起又掉线，而不是看起来像从未开始过。
   */
  expireLeases(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE task
         SET status = 'pending', claimed_by = NULL, claim_token = NULL,
             claim_expires_at = NULL, updated_at = ?
         WHERE status IN ('claimed','in_progress','blocked')
           AND claim_expires_at IS NOT NULL AND claim_expires_at < ?`,
      )
      .run(now, now);
    return result.changes;
  }

}

export function toTaskView(
  task: Task,
  channelKey: string,
  includeDescription = true,
  unreadCount = 0,
): TaskView {
  return {
    id: task.id,
    channel_id: task.channel_id,
    channel_key: channelKey,
    parent_id: task.parent_id,
    path: task.path,
    title: task.title,
    // 列表/树默认只给 null；详情与写操作响应才带正文，避免截图 base64 灌进批量查询。
    description_md: includeDescription ? task.description_md : null,
    kind: task.kind,
    // 分类是单值归属；tag 语义（多个、可横切）仍由 tags 承担。
    category: task.category,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    tags: parseJsonArray(task.tags_json),
    due_at: task.due_at === null ? null : new Date(task.due_at).toISOString(),
    claimed_by: task.claimed_by,
    claim_expires_at:
      task.claim_expires_at === null ? null : new Date(task.claim_expires_at).toISOString(),
    // 时间线统一转 ISO：页面与 MCP 看到的是同一套字符串格式，不用各自猜时区。
    claimed_at: toIsoOrNull(task.claimed_at),
    started_at: toIsoOrNull(task.started_at),
    blocked_at: toIsoOrNull(task.blocked_at),
    completed_at: toIsoOrNull(task.completed_at),
    failed_at: toIsoOrNull(task.failed_at),
    cancelled_at: toIsoOrNull(task.cancelled_at),
    blocked_reason: task.blocked_reason,
    fail_reason: task.fail_reason,
    cancel_reason: task.cancel_reason,
    end_notice_read_at: toIsoOrNull(task.end_notice_read_at),
    // 派生标记放在视图层：Web 只消费布尔值，不用重复维护“哪些状态算结束”。
    end_notice_pending:
      task.end_notice_read_at === null && isTerminalStatus(task.status),
    defer_reason: task.defer_reason,
    deferred_at: toIsoOrNull(task.deferred_at),
    deferred_until: toIsoOrNull(task.deferred_until),
    risk_note: task.risk_note,
    risk_flagged_at: toIsoOrNull(task.risk_flagged_at),
    risk_resolved_at: toIsoOrNull(task.risk_resolved_at),
    risk_resolution: task.risk_resolution,
    evidence_ids: parseJsonArray(task.evidence_json),
    unread_count: unreadCount,
    created_at: new Date(task.created_at).toISOString(),
    updated_at: new Date(task.updated_at).toISOString(),
  };
}

function toIsoOrNull(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** 哪些状态算“任务已结束”。与服务层状态机保持一致，只用于派生通知标记。 */
function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
