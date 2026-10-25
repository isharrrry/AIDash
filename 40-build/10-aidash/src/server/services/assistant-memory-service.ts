import type { z } from 'zod';
import {
  MAX_MEMORY_APPEND_LINES,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_LINE_CHARS,
} from '../../shared/constants.js';
import { AppError } from '../../shared/errors.js';
import { assistantMemoryUpdateSchema } from '../../shared/schemas.js';
import { assertNoSecrets } from '../../shared/secrets.js';
import type { Clock } from '../../shared/time.js';
import type { AssistantMemory, AssistantMemoryView, Ctx } from '../../shared/types.js';
import { txImmediate, type Db } from '../db/connection.js';
import type { AssistantMemoryRepo } from '../repos/assistant-memory-repo.js';
import type { AuditService } from './audit-service.js';
import {
  mergeVersionedLines,
  writeVersionedDocument,
} from './versioned-document.js';

export type AssistantMemoryUpdateInput = z.infer<typeof assistantMemoryUpdateSchema>;

export interface AssistantMemoryAppendResult {
  /** 写入后的整篇视图，调用方不必再读一次。 */
  memory: AssistantMemoryView;
  appended: number;
  skipped_duplicates: number;
  unchanged: boolean;
}

export interface AssistantMemoryReplaceResult {
  memory: AssistantMemoryView;
  changed: boolean;
}

export interface AssistantMemoryServiceDeps {
  db: Db;
  memory: AssistantMemoryRepo;
  audit: AuditService;
  clock: Clock;
}

/**
 * AIDash 自身的长期记忆。
 *
 * 与 MemoryService（主对话记忆）刻意分成两个服务：
 * - 主对话记忆按 project 分片、由外部 agent 通过 MCP 读写；
 * - 这份记忆全局只有一篇，只给 AIDash 内部的 AI 能力读，写入来自“汇报学习器”
 *   和用户在 Web 上的整体编辑。
 *
 * 两者共用同一套“整篇 Markdown + 版本号”的并发模型：追加在事务里读-改-写，
 * 整体编辑带 expected_version，冲突显式报错而不是静默覆盖别人刚写的内容。
 */
export class AssistantMemoryService {
  private readonly db: Db;
  private readonly memory: AssistantMemoryRepo;
  private readonly audit: AuditService;
  private readonly clock: Clock;

  constructor(deps: AssistantMemoryServiceDeps) {
    this.db = deps.db;
    this.memory = deps.memory;
    this.audit = deps.audit;
    this.clock = deps.clock;
  }

  get(): AssistantMemoryView {
    return toAssistantMemoryView(this.memory.get());
  }

  /**
   * 追加若干行（自动学习器与未来可能的 MCP 入口共用）。
   *
   * 去重按“trim 后整行相等”比较：模型每次提炼的措辞可能略有不同，
   * 精确去重挡不住近义重复，但能挡住最常见的“同一句话反复追加”，
   * 且不会像模糊去重那样误删两条相似但含义不同的约束。
   */
  append(
    lines: string[],
    ctx: Ctx,
    options: { dedupe?: boolean } = {},
  ): AssistantMemoryAppendResult {
    if (lines.length > MAX_MEMORY_APPEND_LINES) {
      throw new AppError('INVALID_ARGUMENT', 'MEMORY_TOO_MANY_LINES', {
        max: MAX_MEMORY_APPEND_LINES,
        actual: lines.length,
      });
    }
    const normalized = lines.map(normalizeLine).filter((line) => line.trim().length > 0);
    if (normalized.length === 0) {
      throw new AppError('INVALID_ARGUMENT', 'MEMORY_APPEND_EMPTY');
    }
    assertNoSecrets({ content_md: normalized.join('\n') });

    const now = this.clock.now();
    const dedupe = options.dedupe !== false;
    const outcome = txImmediate(this.db, () => {
      const current = this.memory.get();
      const merged = mergeVersionedLines({
        currentContent: current?.content_md,
        lines: normalized,
        dedupe,
      });
      if (merged.accepted.length === 0) {
        return { memory: current, appended: 0, skippedDuplicates: merged.skippedDuplicates };
      }

      if (merged.content.length > MAX_MEMORY_CHARS) {
        throw new AppError('INVALID_ARGUMENT', 'MEMORY_TOO_LARGE', {
          max_chars: MAX_MEMORY_CHARS,
          // 与重构前保持一致：这里的 current_chars 是去掉行尾空白后的基数。
          current_chars: (current?.content_md ?? '').replace(/\s+$/, '').length,
          incoming_lines: merged.accepted.length,
          hint: 'AIDash 记忆是长期经验，不是日志；请先整理/删除过期条目',
        });
      }

      const saved = writeVersionedDocument({
        current,
        content: merged.content,
        expectedVersion: current?.version ?? 0,
        actor: ctx.actorLabel,
        now,
        upsert: (content, version, actor, at) =>
          this.memory.upsert(content, version, actor, at),
      });
      return {
        memory: saved.memory,
        appended: merged.accepted.length,
        skippedDuplicates: merged.skippedDuplicates,
      };
    });

    if (outcome.appended > 0) {
      this.audit.record(ctx, 'assistant_memory.append', 'ok', 'assistant_memory', 'assistant', {
        appended: outcome.appended,
        skipped_duplicates: outcome.skippedDuplicates,
        version: outcome.memory?.version,
      });
    }

    return {
      memory: toAssistantMemoryView(outcome.memory),
      appended: outcome.appended,
      skipped_duplicates: outcome.skippedDuplicates,
      unchanged: outcome.appended === 0,
    };
  }

  /**
   * 整体替换（Web 编辑）。
   *
   * 内容没变时返回 changed=false 且不递增版本：否则用户每点一次保存，
   * 即便什么都没改，也会让其他终端的 expected_version 失效。
   */
  replace(input: AssistantMemoryUpdateInput, ctx: Ctx): AssistantMemoryReplaceResult {
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
        current: this.memory.get(),
        content,
        expectedVersion: input.expected_version,
        actor: ctx.actorLabel,
        now,
        hint: '先读取最新内容，合并后再用新的 version 保存',
        upsert: (nextContent, version, actor, at) =>
          this.memory.upsert(nextContent, version, actor, at),
      }),
    );

    if (outcome.changed) {
      this.audit.record(ctx, 'assistant_memory.update', 'ok', 'assistant_memory', 'assistant', {
        version: outcome.memory?.version,
        chars: content.length,
      });
    }
    return { memory: toAssistantMemoryView(outcome.memory), changed: outcome.changed };
  }
}

export function toAssistantMemoryView(row: AssistantMemory | undefined): AssistantMemoryView {
  if (!row) {
    return {
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
  const line = raw.replace(/\r/g, '').replace(/\s+$/, '');
  return line.length > MAX_MEMORY_LINE_CHARS ? line.slice(0, MAX_MEMORY_LINE_CHARS) : line;
}
