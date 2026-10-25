import type { Channel, ChannelStatus, Page } from '../../shared/types.js';
import type { Db } from '../db/connection.js';

/**
 * channel 表的数据访问。
 * 分层纪律：这里只写 SQL，不判断“是否该归档/恢复”，那是 channel-service 的事。
 */
export class ChannelRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Channel | undefined {
    return this.db.prepare('SELECT * FROM channel WHERE id = ?').get(id) as Channel | undefined;
  }

  findByKey(key: string): Channel | undefined {
    return this.db.prepare('SELECT * FROM channel WHERE channel_key = ?').get(key) as
      | Channel
      | undefined;
  }

  /**
   * 批量取通道 key。
   *
   * 列表/摘要一次要展示几十条来自不同通道的记录；逐条 get() 会把一次请求
   * 放大成 N+1。这里只投影 id + channel_key：调用方需要的只是一个映射，
   * 不需要 title/status 等完整 Channel 字段。
   */
  findKeysByIds(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT id, channel_key FROM channel
          WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as Array<{ id: string; channel_key: string }>;
    return new Map(rows.map((row) => [row.id, row.channel_key]));
  }

  insert(channel: Channel): Channel {
    this.db
      .prepare(
        `INSERT INTO channel
         (id, channel_key, title, alias, harness_id, project, topic, workdir, status,
          last_mcp_at, created_at, updated_at, archived_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        channel.id,
        channel.channel_key,
        channel.title,
        // 别名是展示层标签，允许为空；空值时视图层回退到 topic/title/key。
        channel.alias,
        channel.harness_id,
        channel.project,
        channel.topic,
        // 工作路径登记在通道上：用户在 Web 上一眼能确认“这条对话在改哪份代码”。
        channel.workdir,
        channel.status,
        // 新建时通常还没发生 MCP 调用；随后入口的 touchMcp 会补上。
        channel.last_mcp_at,
        channel.created_at,
        channel.updated_at,
        channel.archived_at,
      );
    return channel;
  }

  updateMeta(
    id: string,
    patch: Partial<
      Pick<
        Channel,
        'title' | 'alias' | 'harness_id' | 'project' | 'topic' | 'workdir' | 'updated_at'
      >
    >,
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of [
      'title',
      'alias',
      'harness_id',
      'project',
      'topic',
      'workdir',
      'updated_at',
    ] as const) {
      if (patch[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(patch[key]);
      }
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE channel SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * 记录一次 MCP 活动。
   *
   * 只写 last_mcp_at，不动 updated_at：读操作（task.list/card.get）也算“agent 在线”，
   * 但不应该把通道提到列表顶部或改变“最后修改时间”的语义。
   */
  touchMcp(id: string, now: number): void {
    this.db.prepare('UPDATE channel SET last_mcp_at = ? WHERE id = ?').run(now, id);
  }

  /**
   * 按 key 记录 MCP 活动。
   *
   * 用于“这次调用本身刚把通道建出来”的场景（首次 channel.upsert / card.post
   * 自动建通道）：请求开始前查不到 id，只能等工具执行完再按 key 补一次。
   * 通道不存在时静默不写，不影响工具结果。
   */
  touchMcpByKey(key: string, now: number): void {
    this.db.prepare('UPDATE channel SET last_mcp_at = ? WHERE channel_key = ?').run(now, key);
  }

  setStatus(id: string, status: ChannelStatus, now: number): void {
    this.db
      .prepare(
        `UPDATE channel
         SET status = ?, updated_at = ?,
             archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END
         WHERE id = ?`,
      )
      .run(status, now, status, now, id);
  }

  /**
   * 列表带卡片数、任务数与最近活跃时间。
   *
   * 为什么用相关子查询而不是 JOIN + GROUP BY：channel 表很小，子查询走
   * task(channel_id, status) 与 card(channel_id...) 索引即可，且不会因为
   * 多表 JOIN 让分页总数与列表口径出现偏差；一个通道最多几百张卡/任务，
   * 相关子查询的成本远低于让调用方逐通道再查一次（N+1）。
   */
  list(
    options: {
      includeArchived?: boolean;
      page?: number;
      page_size?: number;
      q?: string;
    } = {},
  ): Page<
    Channel & {
      card_count: number;
      task_count: number;
      open_task_count: number;
      last_active_at: number | null;
    }
  > {
    const page = options.page ?? 1;
    const pageSize = options.page_size ?? 50;
    const where: string[] = [];
    const params: unknown[] = [];
    if (!options.includeArchived) {
      where.push("c.status <> 'archived'");
    }
    if (options.q) {
      // 别名也参与搜索：用户记得的是“登录 500 排查”，不是 auth-bug 这种 key。
      // 下面把 % 和 _ 转义成字面量，但 SQLite 的 LIKE 默认没有转义符：
      // 不显式声明 ESCAPE，`\%`/`\_` 会被理解成“反斜杠 + 任意字符”，
      // 搜含 _/% 的 key 或标题会直接 0 命中。源码里的 `\\` 会被 JS 还原成
      // 单个反斜杠，SQLite 单引号字符串恰好把 `'\'` 当成一个反斜杠。
      where.push(
        `(c.channel_key LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\'
          OR c.alias LIKE ? ESCAPE '\\')`,
      );
      const like = `%${options.q.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM channel c ${whereSql}`)
        .get(...params) as { n: number }
    ).n;

    const rows = this.db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM card cd
                  WHERE cd.channel_id = c.id AND cd.status <> 'archived') AS card_count,
                -- 任务总数含终态，用来回答“这条通道一共干过多少活”；
                -- open_task_count 只统计未结束状态，回答“还有多少没干完”。
                (SELECT COUNT(*) FROM task t WHERE t.channel_id = c.id) AS task_count,
                (SELECT COUNT(*) FROM task t
                  WHERE t.channel_id = c.id
                    AND t.status IN ('pending','claimed','in_progress','blocked')) AS open_task_count,
                (SELECT MAX(cd.created_at) FROM card cd WHERE cd.channel_id = c.id) AS last_card_at
         FROM channel c
         ${whereSql}
         ORDER BY c.updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as Array<
      Channel & {
        card_count: number;
        task_count: number;
        open_task_count: number;
        last_card_at: number | null;
      }
    >;

    return {
      items: rows.map((row) => ({
        ...row,
        // “最后活动”同时纳入 MCP 读操作：只看卡片时间会把“agent 刚查过任务”
        // 显示成很久没动，与右上角的在线判定自相矛盾。
        last_active_at:
          Math.max(row.updated_at, row.last_card_at ?? 0, row.last_mcp_at ?? 0) || null,
      })),
      page,
      page_size: pageSize,
      total,
      has_more: page * pageSize < total,
    };
  }

  countActive(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM channel WHERE status = 'active'").get() as {
        n: number;
      }
    ).n;
  }
}
