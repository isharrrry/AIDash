import type { ProjectMemory } from '../../shared/types.js';
import type { Db } from '../db/connection.js';

export interface MemoryUpsertResult {
  ok: boolean;
  /** 成功时是写入后的行；失败时是最新行（可能为 undefined），供服务层报告实际版本。 */
  memory?: ProjectMemory;
  actualVersion: number;
}

/**
 * project_memory 的数据访问。
 *
 * 这里只做“按版本号写入”这一件事，不拼接记忆内容：
 * 追加/去重/上限都属于业务规则，放在 MemoryService 里才能与 MCP、REST 共用同一套行为。
 * 写入用 `WHERE version = ?` 做乐观锁——即便当前是单进程，也避免未来并发接入时静默覆盖。
 */
export class MemoryRepo {
  constructor(private readonly db: Db) {}

  get(project: string): ProjectMemory | undefined {
    return this.db
      .prepare('SELECT * FROM project_memory WHERE project = ?')
      .get(project) as ProjectMemory | undefined;
  }

  /**
   * 记忆 Tab 的主对话列表。
   *
   * 为什么要从两张表取并集：
   * - 只查 project_memory 会漏掉“通道已建好、agent 还没写记忆”的项目，用户会误以为
   *   系统里根本没有这个项目；
   * - 只查 channel 会漏掉“通道都已归档、项目记忆仍要保留”的历史项目（记忆不做外键级联）。
   *
   * 行数在 SQL 里算，不把整篇 Markdown 拉到 Node：记忆上限 64,000 字符，
   * 列表有几十个项目时逐行传输全文纯属浪费。
   */
  listProjects(): Array<{
    project: string;
    alias: string | null;
    version: number | null;
    updated_at: number | null;
    line_count: number;
    channel_count: number;
    active_channel_count: number;
  }> {
    return this.db
      .prepare(
        `SELECT p.project,
                m.version AS version,
                m.updated_at AS updated_at,
                CASE
                  WHEN m.content_md IS NULL OR m.content_md = '' THEN 0
                  ELSE length(m.content_md) - length(replace(m.content_md, char(10), '')) + 1
                END AS line_count,
                (SELECT COUNT(*) FROM channel c
                  WHERE c.project = p.project) AS channel_count,
                (SELECT COUNT(*) FROM channel c
                  WHERE c.project = p.project AND c.status = 'active') AS active_channel_count,
                /*
                 * 主对话没有自己的别名字段：别名挂在通道上。
                 * 这里选“活跃优先、最近更新”的那条非空别名作为该项目的展示名——
                 * 同一项目下多个话题可能各有别名，列表只需要一个代表；
                 * 具体每个通道的别名仍由“共用这份记忆的通道”逐条展示。
                 */
                (SELECT c.alias FROM channel c
                  WHERE c.project = p.project
                    AND c.alias IS NOT NULL AND trim(c.alias) <> ''
                  ORDER BY CASE WHEN c.status = 'active' THEN 0 ELSE 1 END,
                           c.updated_at DESC, c.id DESC
                  LIMIT 1) AS alias
           FROM (
                  SELECT project FROM project_memory
                  UNION
                  SELECT DISTINCT project FROM channel
                   WHERE project IS NOT NULL AND trim(project) <> ''
                ) p
           LEFT JOIN project_memory m ON m.project = p.project
          ORDER BY COALESCE(m.updated_at, 0) DESC, p.project ASC`,
      )
      .all() as Array<{
      project: string;
      alias: string | null;
      version: number | null;
      updated_at: number | null;
      line_count: number;
      channel_count: number;
      active_channel_count: number;
    }>;
  }

  /**
   * 以期望版本号写入整篇内容。
   *
   * expectedVersion=0 表示“我认为这行还不存在”：用 INSERT ... ON CONFLICT DO NOTHING
   * 让数据库决定谁先创建；插入失败说明别人已经创建，返回实际版本供上层报冲突。
   */
  upsert(
    project: string,
    content: string,
    expectedVersion: number,
    actor: string | null,
    now: number,
  ): MemoryUpsertResult {
    if (expectedVersion === 0) {
      const inserted = this.db
        .prepare(
          `INSERT INTO project_memory
           (project, content_md, version, updated_by, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)
           ON CONFLICT(project) DO NOTHING`,
        )
        .run(project, content, actor, now, now);
      if (inserted.changes === 1) {
        return { ok: true, memory: this.get(project), actualVersion: 1 };
      }
      const current = this.get(project);
      return { ok: false, memory: current, actualVersion: current?.version ?? 0 };
    }

    const updated = this.db
      .prepare(
        `UPDATE project_memory
         SET content_md = ?, version = version + 1, updated_by = ?, updated_at = ?
         WHERE project = ? AND version = ?`,
      )
      .run(content, actor, now, project, expectedVersion);
    if (updated.changes === 1) {
      return { ok: true, memory: this.get(project), actualVersion: expectedVersion + 1 };
    }
    const current = this.get(project);
    return { ok: false, memory: current, actualVersion: current?.version ?? 0 };
  }
}
