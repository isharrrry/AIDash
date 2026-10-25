import type { AssistantMemory } from '../../shared/types.js';
import type { Db } from '../db/connection.js';

export interface AssistantMemoryUpsertResult {
  ok: boolean;
  /** 成功时是写入后的行；失败时是最新行（可能为 undefined），供服务层报告实际版本。 */
  memory?: AssistantMemory;
  actualVersion: number;
}

/** 单行表里唯一的行 id。用常量而不是魔法数字，读代码时能直接看出“只有一行”。 */
const SINGLETON_ID = 1;

/**
 * assistant_memory 的数据访问。
 *
 * 与 MemoryRepo 一样，这里只负责“按版本号写入”，去重/上限/敏感词扫描都在服务层：
 * 自动学习器和 Web 编辑必须走同一套规则，否则直接从仓储写入会绕过 64,000 字符上限。
 *
 * 为什么插入与更新拆成两条语句：
 * 首次写入时期望版本是 0（行还不存在），后续写入期望具体版本；
 * 一条 UPSERT 很难同时表达“期望不存在”和“期望某个版本”，拆开更容易在冲突时
 * 告诉调用方实际版本。
 */
export class AssistantMemoryRepo {
  constructor(private readonly db: Db) {}

  get(): AssistantMemory | undefined {
    return this.db
      .prepare('SELECT * FROM assistant_memory WHERE id = ?')
      .get(SINGLETON_ID) as AssistantMemory | undefined;
  }

  upsert(
    content: string,
    expectedVersion: number,
    actor: string,
    now: number,
  ): AssistantMemoryUpsertResult {
    if (expectedVersion === 0) {
      // 期望“还没有记忆”：只允许在确实没有行时插入。
      // ON CONFLICT DO NOTHING 会把“别人抢先写了”变成 changes=0，而不是覆盖。
      const inserted = this.db
        .prepare(
          `INSERT INTO assistant_memory
             (id, content_md, version, updated_by, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(SINGLETON_ID, content, actor, now, now);
      if (inserted.changes === 1) {
        return { ok: true, memory: this.get(), actualVersion: 1 };
      }
      return { ok: false, memory: this.get(), actualVersion: this.get()?.version ?? 0 };
    }

    // 期望某个版本：只有版本仍然匹配才写入，否则把最新版本回传，由调用方合并。
    const updated = this.db
      .prepare(
        `UPDATE assistant_memory
            SET content_md = ?, version = version + 1, updated_by = ?, updated_at = ?
          WHERE id = ? AND version = ?`,
      )
      .run(content, actor, now, SINGLETON_ID, expectedVersion);
    if (updated.changes === 1) {
      const saved = this.get();
      return { ok: true, memory: saved, actualVersion: saved?.version ?? expectedVersion + 1 };
    }
    return { ok: false, memory: this.get(), actualVersion: this.get()?.version ?? 0 };
  }
}
