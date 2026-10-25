import type { z } from 'zod';
import { MAX_MEMORY_CHARS, MAX_MEMORY_LINE_CHARS } from '../../shared/constants.js';
import { AppError } from '../../shared/errors.js';
import {
  memoryAppendSchema,
  memorySearchSchema,
  memoryUpdateSchema,
} from '../../shared/schemas.js';
import { assertNoSecrets } from '../../shared/secrets.js';
import type { Clock } from '../../shared/time.js';
import type {
  Ctx,
  MemoryLineMatch,
  MemoryProjectView,
  MemorySearchResult,
  ProjectMemory,
  ProjectMemoryView,
} from '../../shared/types.js';
import { txImmediate, type Db } from '../db/connection.js';
import type { MemoryRepo } from '../repos/memory-repo.js';
import type { AuditService } from './audit-service.js';
import {
  mergeVersionedLines,
  writeVersionedDocument,
} from './versioned-document.js';

export type MemoryAppendInput = z.infer<typeof memoryAppendSchema>;
export type MemorySearchInput = z.infer<typeof memorySearchSchema>;
export type MemoryUpdateInput = z.infer<typeof memoryUpdateSchema>;

export interface MemoryAppendResult {
  project: string;
  version: number;
  appended: number;
  skipped_duplicates: number;
  skipped_blank: number;
  line_count: number;
  updated_at: string | null;
  /** 全部行都是重复/空行时为 true：调用方可以据此判断“这条约束早就记过了”。 */
  unchanged: boolean;
}

export interface MemoryUpdateResult {
  memory: ProjectMemoryView;
  changed: boolean;
}

export interface MemoryServiceDeps {
  db: Db;
  memory: MemoryRepo;
  audit: AuditService;
  clock: Clock;
}

/**
 * 主通道记忆。
 *
 * 读/写都围绕“整篇 Markdown”这一唯一真相：
 * - 追加行在事务里读-改-写，避免两个 agent 同时追加时后者覆盖前者；
 * - 整体编辑必须带 expected_version，覆盖冲突显式报给调用方，而不是静默丢改动；
 * - 所有写入口都做敏感模式扫描，记忆和卡片一样不该成为令牌的落脚点。
 */
export class MemoryService {
  private readonly db: Db;
  private readonly memory: MemoryRepo;
  private readonly audit: AuditService;
  private readonly clock: Clock;

  constructor(deps: MemoryServiceDeps) {
    this.db = deps.db;
    this.memory = deps.memory;
    this.audit = deps.audit;
    this.clock = deps.clock;
  }

  get(project: string): ProjectMemoryView {
    return toMemoryView(this.memory.get(project), project);
  }

  /**
   * 记忆 Tab 的主对话列表。
   *
   * 这里不读整篇 Markdown：列表只需要“有没有、多少行、什么时候更新”，
   * 用户点开某个项目时再走 `get()` 拉全文。
   */
  listProjects(): MemoryProjectView[] {
    return this.memory.listProjects().map((row) => ({
      project: row.project,
      alias: row.alias,
      version: row.version ?? 0,
      has_memory: row.version !== null,
      line_count: row.line_count,
      updated_at: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
      channel_count: row.channel_count,
      active_channel_count: row.active_channel_count,
    }));
  }

  /**
   * 追加若干行。
   *
   * 为什么整个读-改-写放在一个事务里：追加的“去重”依赖当前全文，
   * 如果先读后写、中间又来了另一个追加，后写入的会用旧全文覆盖前者。
   * better-sqlite3 是同步 API，事务内的循环不会让出事件循环，行为是可预期的。
   */
  append(input: MemoryAppendInput, ctx: Ctx): MemoryAppendResult {
    const normalized = input.lines.map(normalizeLine);
    const candidates = normalized.filter((line) => line.trim().length > 0);
    const skippedBlank = normalized.length - candidates.length;
    if (candidates.length === 0) {
      throw new AppError('INVALID_ARGUMENT', 'MEMORY_APPEND_EMPTY', {
        hint: 'lines 里至少要有 1 行非空内容',
      });
    }
    assertNoSecrets({ content_md: candidates.join('\n') });

    const now = this.clock.now();
    const outcome = txImmediate(this.db, () => {
      const current = this.memory.get(input.project);
      const merged = mergeVersionedLines({
        currentContent: current?.content_md,
        lines: candidates,
        dedupe: input.dedupe,
      });
      if (merged.accepted.length === 0) {
        return {
          memory: current,
          appended: 0,
          skippedDuplicates: merged.skippedDuplicates,
          skippedBlank,
        };
      }

      this.assertWithinLimit(merged.content, current?.content_md ?? '', merged.accepted.length);
      const saved = writeVersionedDocument({
        current,
        content: merged.content,
        expectedVersion: current?.version ?? 0,
        actor: ctx.actorLabel,
        now,
        upsert: (content, version, actor, at) =>
          this.memory.upsert(input.project, content, version, actor, at),
      });
      return {
        memory: saved.memory,
        appended: merged.accepted.length,
        skippedDuplicates: merged.skippedDuplicates,
        skippedBlank,
      };
    });

    if (outcome.appended > 0) {
      this.audit.record(ctx, 'memory.append', 'ok', 'project_memory', input.project, {
        appended: outcome.appended,
        skipped_duplicates: outcome.skippedDuplicates,
        version: outcome.memory?.version,
      });
    }

    const view = toMemoryView(outcome.memory, input.project);
    return {
      project: input.project,
      version: view.version,
      appended: outcome.appended,
      skipped_duplicates: outcome.skippedDuplicates,
      skipped_blank: outcome.skippedBlank,
      line_count: view.line_count,
      updated_at: view.updated_at,
      unchanged: outcome.appended === 0,
    };
  }

  /**
   * 按 key 搜索记忆行（大小写不敏感的子串匹配）。
   *
   * 返回行号而不是整篇文档：agent 的上下文预算有限，先搜到相关几行，
   * 确认需要全文时再调用 memory.get。命中行按单行上限截断，避免超长行把响应撑爆。
   */
  search(input: MemorySearchInput): MemorySearchResult {
    const row = this.memory.get(input.project);
    const needle = input.query.trim().toLowerCase();
    if (!needle) {
      throw new AppError('INVALID_ARGUMENT', 'MEMORY_QUERY_EMPTY');
    }

    const lines = (row?.content_md ?? '').split('\n');
    const matches: MemoryLineMatch[] = [];
    let total = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (!line.toLowerCase().includes(needle)) continue;
      total += 1;
      if (matches.length < input.limit) {
        matches.push({
          line_no: index + 1,
          line:
            line.length > MAX_MEMORY_LINE_CHARS
              ? `${line.slice(0, MAX_MEMORY_LINE_CHARS)}…`
              : line,
        });
      }
    }

    return {
      project: input.project,
      query: input.query,
      version: row?.version ?? 0,
      total,
      truncated: total > matches.length,
      matches,
    };
  }

  /**
   * 整体替换。
   *
   * 内容没变时直接返回 changed=false，不递增版本：否则 Web 上每点一次保存，
   * 即便什么都没改，也会让其他终端的 expected_version 失效。
   */
  replace(input: MemoryUpdateInput, ctx: Ctx): MemoryUpdateResult {
    const content = input.content_md.replace(/\r\n?/g, '\n');
    if (content.length > MAX_MEMORY_CHARS) {
      throw new AppError('INVALID_ARGUMENT', 'MEMORY_TOO_LARGE', {
        max_chars: MAX_MEMORY_CHARS,
        actual_chars: content.length,
      });
    }
    assertNoSecrets({ content_md: content });

    const now = this.clock.now();
    const outcome = txImmediate(this.db, () =>
      writeVersionedDocument({
        current: this.memory.get(input.project),
        content,
        expectedVersion: input.expected_version,
        actor: ctx.actorLabel,
        now,
        hint: '先 memory.get 读取最新内容，合并后再用新的 version 保存',
        upsert: (nextContent, version, actor, at) =>
          this.memory.upsert(input.project, nextContent, version, actor, at),
      }),
    );

    if (outcome.changed) {
      this.audit.record(ctx, 'memory.update', 'ok', 'project_memory', input.project, {
        version: outcome.memory?.version,
        chars: content.length,
      });
    }
    return { memory: toMemoryView(outcome.memory, input.project), changed: outcome.changed };
  }

  private assertWithinLimit(next: string, current: string, incomingLines: number): void {
    if (next.length <= MAX_MEMORY_CHARS) return;
    throw new AppError('INVALID_ARGUMENT', 'MEMORY_TOO_LARGE', {
      max_chars: MAX_MEMORY_CHARS,
      current_chars: current.length,
      incoming_lines: incomingLines,
      hint: '记忆是长期约束，不是日志；请先整理/删除过期条目',
    });
  }
}

export function toMemoryView(
  row: ProjectMemory | undefined,
  project: string,
): ProjectMemoryView {
  if (!row) {
    return {
      project,
      content_md: '',
      version: 0,
      exists: false,
      line_count: 0,
      updated_by: null,
      created_at: null,
      updated_at: null,
    };
  }
  return {
    project: row.project,
    content_md: row.content_md,
    version: row.version,
    exists: true,
    line_count: row.content_md ? row.content_md.split('\n').length : 0,
    updated_by: row.updated_by,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** 只去掉行尾空白与 CR；保留行首缩进，Markdown 列表层级依赖它。 */
function normalizeLine(raw: string): string {
  return raw.replace(/\r/g, '').replace(/\s+$/, '');
}
