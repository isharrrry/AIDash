import type { MemoryDigestResult } from '../../shared/types.js';
import type { Db } from '../db/connection.js';

export interface MemoryDigestRow {
  id: string;
  project: string;
  trigger: 'manual' | 'schedule';
  window_start: number;
  window_end: number;
  source_count: number;
  appended: number;
  skipped_duplicates: number;
  result: MemoryDigestResult;
  error_message: string | null;
  lines_json: string | null;
  created_at: number;
}

export interface MemoryDigestInsert {
  id: string;
  project: string;
  trigger: 'manual' | 'schedule';
  windowStart: number;
  windowEnd: number;
  sourceCount: number;
  appended: number;
  skippedDuplicates: number;
  result: MemoryDigestResult;
  errorMessage: string | null;
  lines: string[];
  createdAt: number;
}

/**
 * 归纳运行记录的数据访问。
 *
 * 只做“插入 + 按项目倒序查询”，不在这里判断该不该归纳：
 * 触发条件（间隔、时间窗、是否配置模型）属于业务规则，放在服务层，
 * 这样手动触发和定时触发共用同一套判断。
 */
export class MemoryDigestRepo {
  constructor(private readonly db: Db) {}

  insert(input: MemoryDigestInsert): void {
    this.db
      .prepare(
        `INSERT INTO memory_digest_run
         (id, project, trigger, window_start, window_end, source_count,
          appended, skipped_duplicates, result, error_message, lines_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.project,
        input.trigger,
        input.windowStart,
        input.windowEnd,
        input.sourceCount,
        input.appended,
        input.skippedDuplicates,
        input.result,
        input.errorMessage,
        input.lines.length > 0 ? JSON.stringify(input.lines) : null,
        input.createdAt,
      );
  }

  list(project: string, limit = 10): MemoryDigestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_digest_run
          WHERE project = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(project, limit) as MemoryDigestRow[];
  }

  last(project: string): MemoryDigestRow | undefined {
    return this.list(project, 1)[0];
  }
}
