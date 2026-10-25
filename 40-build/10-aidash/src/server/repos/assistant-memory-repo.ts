import type { AssistantMemory } from '../../shared/types.js';
import type { Db } from '../db/connection.js';
import {
  upsertVersionedDocument,
  type VersionedDocUpsertResult,
} from './versioned-doc.js';

/** 保留原导出名，调用方与测试不需要因为内部重构改 import。 */
export type AssistantMemoryUpsertResult = VersionedDocUpsertResult<AssistantMemory>;

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
    // 插入/更新的分支与冲突回传由 versioned-doc 统一实现；
    // 单行表只多一个固定 id 条件，仍由本仓储保有表结构知识。
    return upsertVersionedDocument(
      {
        read: () => this.get(),
        insert: (nextContent, nextActor, nextNow) =>
          this.db
            .prepare(
              `INSERT INTO assistant_memory
                 (id, content_md, version, updated_by, created_at, updated_at)
               VALUES (?, ?, 1, ?, ?, ?)
               ON CONFLICT(id) DO NOTHING`,
            )
            .run(SINGLETON_ID, nextContent, nextActor, nextNow, nextNow).changes,
        update: (nextContent, version, nextActor, nextNow) =>
          this.db
            .prepare(
              `UPDATE assistant_memory
                  SET content_md = ?, version = version + 1, updated_by = ?, updated_at = ?
                WHERE id = ? AND version = ?`,
            )
            .run(nextContent, nextActor, nextNow, SINGLETON_ID, version).changes,
      },
      content,
      expectedVersion,
      actor,
      now,
    );
  }
}
