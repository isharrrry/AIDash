import { randomUUID } from 'node:crypto';
import { MAX_MEMORY_LINE_CHARS } from '../../shared/constants.js';
import { AppError } from '../../shared/errors.js';
import type { Clock } from '../../shared/time.js';
import type { Ctx, MemoryDigestResult, MemoryDigestRunView } from '../../shared/types.js';
import type { Db } from '../db/connection.js';
import type { MemoryDigestRepo, MemoryDigestRow } from '../repos/memory-digest-repo.js';
import type { AuditService } from './audit-service.js';
import { BatchRunner } from './batch-runner.js';
import type { LlmService } from './llm-service.js';
import type { MemoryService } from './memory-service.js';
import type { SettingsService } from './settings-service.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** 定时检查频率：分钟级太频繁（每次都要读设置/项目），小时级又会让“昨天该跑”拖太久。 */
const CHECK_INTERVAL_MS = 10 * 60_000;
/** 启动后先等一分钟：让迁移、KB 索引和首次通道活动先稳定下来。 */
const STARTUP_DELAY_MS = 60_000;
const MAX_SOURCES = 30;
/** 少于这个数量说明没有足够素材，调用模型只会产生空话，还花钱。 */
const MIN_SOURCES = 3;
const MAX_LINES = 5;
const MAX_SOURCE_CHARS = 500;
const MAX_PROMPT_CHARS = 12_000;
const MAX_EXISTING_MEMORY_CHARS = 6_000;
/** 每个检查周期最多归纳几个项目：防止首次开启时把所有历史项目一次性打满。 */
const MAX_PROJECTS_PER_TICK = 3;

interface DigestSource {
  lines: string[];
  count: number;
}

export interface MemoryDigestDeps {
  db: Db;
  digest: MemoryDigestRepo;
  memory: MemoryService;
  llm: LlmService;
  settings: SettingsService;
  audit: AuditService;
  clock: Clock;
}

/**
 * 自动记忆归纳。
 *
 * 设计底线：
 * - 只用“最近一段时间”的卡片与任务，不把整库历史塞给模型；
 * - 只产出“约束 / 坑 / 稳定偏好”，最多 5 行，宁缺毋滥；
 * - 写回走 MemoryService.append：去重、长度上限、敏感词扫描与 agent 手动追加共用一套规则；
 * - 模型不可用、没有素材、输出为空都记一条运行记录，用户能看到“为什么没新增”；
 * - 定时与手动共用 execute，差别只在 trigger 字段和并发保护。
 */
export class MemoryDigestService {
  private readonly running = new Set<string>();
  private scheduledRunning = false;
  private intervalTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** 在途归纳与报告批次共用启停/取消语义：每条归纳各持一个 AbortController。 */
  private readonly batches = new BatchRunner();
  private scheduledPromise: Promise<void> = Promise.resolve();

  constructor(private readonly deps: MemoryDigestDeps) {}

  start(): void {
    this.stopped = false;
    this.intervalTimer = setInterval(() => {
      this.scheduledPromise = this.runScheduled().catch(() => {});
    }, CHECK_INTERVAL_MS);
    this.intervalTimer.unref?.();

    this.startupTimer = setTimeout(() => {
      this.scheduledPromise = this.runScheduled().catch(() => {});
    }, STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.batches.abortAll();
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.intervalTimer = null;
    this.startupTimer = null;
  }

  /**
   * 等定时批次与手动归纳都收尾。
   *
   * 与 EnrichmentService 同理：stop() 只阻止新任务并 abort 在途请求，
   * 运行记录（成功/失败/取消）仍要写库；必须在 db.close() 之前等完。
   */
  async waitForIdle(): Promise<void> {
    await Promise.allSettled([this.batches.waitForIdle(), this.scheduledPromise]);
  }

  listRuns(project: string, limit = 10): MemoryDigestRunView[] {
    return this.deps.digest.list(project, limit).map(toView);
  }

  /**
   * 手动归纳。
   *
   * 同一项目已有归纳在跑时直接 409：两个请求同时进行会各自追加一次，
   * 去重只能挡住完全相同的行，语义相近的两组建议仍会重复。
   */
  async run(project: string, trigger: 'manual' | 'schedule'): Promise<MemoryDigestRunView> {
    if (this.running.has(project)) {
      throw new AppError('CONFLICT', 'DIGEST_RUNNING', { project });
    }
    this.running.add(project);
    // 用 batch runner 跟踪在途归纳：关机等待覆盖“已经进入模型调用”的请求，
    // 同时拿到可 abort 的 signal，与报告批次保持同一套取消语义。
    const task = this.batches.run(`digest:${project}`, (signal) =>
      this.execute(project, trigger, signal),
    );
    // 停机后手动调用仍应像旧实现一样被取消，而不是重新开一个未被 abort 的请求。
    if (this.stopped) this.batches.abort(`digest:${project}`);
    try {
      return await task;
    } finally {
      this.running.delete(project);
    }
  }

  private async runScheduled(): Promise<void> {
    if (this.stopped) return;
    const settings = this.deps.settings.current();
    if (!settings.memoryDigestEnabled || !this.deps.llm.isConfigured()) return;
    if (this.scheduledRunning) return;
    this.scheduledRunning = true;
    try {
      const projects = this.deps.memory.listProjects().map((row) => row.project);
      const intervalMs = settings.memoryDigestIntervalHours * HOUR_MS;
      let started = 0;
      for (const project of projects) {
        // 关机信号可能在两个项目之间到达：停止后不再启动新的归纳。
        if (this.stopped) break;
        if (started >= MAX_PROJECTS_PER_TICK) break;
        if (this.running.has(project)) continue;
        const last = this.deps.digest.last(project);
        if (last && this.deps.clock.now() - last.created_at < intervalMs) continue;
        started += 1;
        // 单个项目失败不能把后面的项目一起带走；run 内部已把失败写成运行记录。
        await this.run(project, 'schedule');
      }
    } finally {
      this.scheduledRunning = false;
    }
  }

  private async execute(
    project: string,
    trigger: 'manual' | 'schedule',
    signal: AbortSignal,
  ): Promise<MemoryDigestRunView> {
    const now = this.deps.clock.now();
    const settings = this.deps.settings.current();
    const last = this.deps.digest.last(project);
    // 失败/不可用的那次不该“吃掉”时间窗：否则用户配好 key 后，
    // 之前那批素材会永远错过归纳。
    const reusableLast =
      last && last.result !== 'failed' && last.result !== 'unavailable' ? last.created_at : 0;
    const windowStart = Math.max(now - settings.memoryDigestWindowDays * DAY_MS, reusableLast);
    const id = `dg_${randomUUID()}`;

    if (!this.deps.llm.isConfigured()) {
      return this.record({
        id,
        project,
        trigger,
        windowStart,
        windowEnd: now,
        sourceCount: 0,
        appended: 0,
        skipped: 0,
        result: 'unavailable',
        errorMessage: 'llm_not_configured',
        lines: [],
      });
    }

    const source = this.collectSources(project, windowStart);
    if (source.count < MIN_SOURCES) {
      return this.record({
        id,
        project,
        trigger,
        windowStart,
        windowEnd: now,
        sourceCount: source.count,
        appended: 0,
        skipped: 0,
        result: 'empty',
        errorMessage: null,
        lines: [],
      });
    }

    try {
      const content = await this.deps.llm.chat({
        system: this.deps.llm.prompt('memory_digest'),
        user: buildUserPrompt(project, windowStart, now, source.lines, this.existingMemory(project)),
        timeoutMs: settings.enrichmentTimeoutMs,
        maxTokens: 2_048,
        signal,
      });
      const lines = sanitizeDigestLines(content);
      if (lines.length === 0) {
        return this.record({
          id,
          project,
          trigger,
          windowStart,
          windowEnd: now,
          sourceCount: source.count,
          appended: 0,
          skipped: 0,
          result: 'empty',
          errorMessage: null,
          lines: [],
        });
      }

      const ctx: Ctx = {
        actorLabel: 'memory-digest',
        // audit_log.request_id 有唯一索引：同一批次先写 memory.append 审计，
        // 若这里也用 digest_<id>，后面的 memory.digest 汇总行会被降级成 null。
        // 加 _append 后缀既保留批次关联，又让两条审计各自可追踪。
        requestId: `digest_${id}_append`,
        isOwner: false,
      };
      const appended = this.deps.memory.append({ project, lines, dedupe: true }, ctx);
      return this.record({
        id,
        project,
        trigger,
        windowStart,
        windowEnd: now,
        sourceCount: source.count,
        appended: appended.appended,
        skipped: appended.skipped_duplicates,
        result: appended.appended > 0 ? 'ok' : 'empty',
        errorMessage: null,
        lines,
      });
    } catch (error) {
      // 不落上游响应体/URL；AppError 的 message 已经是收敛后的错误码。
      const reason = error instanceof AppError ? error.message : 'digest_failed';
      return this.record({
        id,
        project,
        trigger,
        windowStart,
        windowEnd: now,
        sourceCount: source.count,
        appended: 0,
        skipped: 0,
        result: 'failed',
        errorMessage: reason,
        lines: [],
      });
    }
  }

  private collectSources(project: string, windowStart: number): DigestSource {
    const cards = this.deps.db
      .prepare(
        `SELECT c.type, c.status, c.title, c.summary, c.detail_md,
                c.body_md, c.background_md, c.result
           FROM card c
           JOIN channel ch ON ch.id = c.channel_id
          WHERE ch.project = ? AND c.created_at >= ?
          ORDER BY c.created_at DESC
          LIMIT ?`,
      )
      .all(project, windowStart, MAX_SOURCES) as Array<{
      type: string;
      status: string;
      title: string | null;
      summary: string | null;
      detail_md: string | null;
      body_md: string | null;
      background_md: string | null;
      result: string | null;
    }>;

    const tasks = this.deps.db
      .prepare(
        `SELECT t.title, t.status, t.blocked_reason, t.fail_reason,
                t.cancel_reason, t.defer_reason, t.description_md
           FROM task t
           JOIN channel ch ON ch.id = t.channel_id
          WHERE ch.project = ? AND (t.created_at >= ? OR t.updated_at >= ?)
          ORDER BY t.updated_at DESC
          LIMIT ?`,
      )
      .all(project, windowStart, windowStart, MAX_SOURCES) as Array<{
      title: string;
      status: string;
      blocked_reason: string | null;
      fail_reason: string | null;
      cancel_reason: string | null;
      defer_reason: string | null;
      description_md: string | null;
    }>;

    const lines: string[] = [];
    for (const card of cards) {
      const text =
        clip(card.summary, MAX_SOURCE_CHARS) ||
        clip(card.detail_md, MAX_SOURCE_CHARS) ||
        clip(card.body_md, MAX_SOURCE_CHARS) ||
        clip(card.background_md, MAX_SOURCE_CHARS);
      if (!text) continue;
      const title = clip(card.title, 120) || '（无标题）';
      const result = card.result ? `/${card.result}` : '';
      lines.push(`- [卡片/${card.type}/${card.status}${result}] ${title}：${text}`);
    }
    for (const task of tasks) {
      const title = clip(task.title, 160);
      if (!title) continue;
      const reason =
        clip(task.blocked_reason, 200) ||
        clip(task.fail_reason, 200) ||
        clip(task.cancel_reason, 200) ||
        clip(task.defer_reason, 200);
      const suffix = reason ? `（原因：${reason}）` : '';
      const description = clip(task.description_md, 200);
      lines.push(
        `- [任务/${task.status}] ${title}${suffix}${description ? `：${description}` : ''}`,
      );
    }
    return { lines, count: lines.length };
  }

  private existingMemory(project: string): string {
    const content = this.deps.memory.get(project).content_md;
    return content.length > MAX_EXISTING_MEMORY_CHARS
      ? `${content.slice(0, MAX_EXISTING_MEMORY_CHARS)}\n…（已截断）`
      : content;
  }

  private record(input: {
    id: string;
    project: string;
    trigger: 'manual' | 'schedule';
    windowStart: number;
    windowEnd: number;
    sourceCount: number;
    appended: number;
    skipped: number;
    result: MemoryDigestResult;
    errorMessage: string | null;
    lines: string[];
  }): MemoryDigestRunView {
    this.deps.digest.insert({
      id: input.id,
      project: input.project,
      trigger: input.trigger,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      sourceCount: input.sourceCount,
      appended: input.appended,
      skippedDuplicates: input.skipped,
      result: input.result,
      errorMessage: input.errorMessage,
      lines: input.lines,
      createdAt: input.windowEnd,
    });
    this.deps.audit.record(
      // 用运行 id 作为请求 id：手动归纳没有 HTTP 请求上下文，
      // 空串会让审计行失去与 digest_runs 的关联；同一批次的事件应能串起来。
      { actorLabel: 'memory-digest', requestId: `digest_${input.id}`, isOwner: false },
      'memory.digest',
      input.result === 'failed' ? 'error' : 'ok',
      'project_memory',
      input.project,
      {
        trigger: input.trigger,
        result: input.result,
        source_count: input.sourceCount,
        appended: input.appended,
        skipped_duplicates: input.skipped,
        error: input.errorMessage,
      },
    );
    return {
      id: input.id,
      project: input.project,
      trigger: input.trigger,
      window_start: new Date(input.windowStart).toISOString(),
      window_end: new Date(input.windowEnd).toISOString(),
      source_count: input.sourceCount,
      appended: input.appended,
      skipped_duplicates: input.skipped,
      result: input.result,
      error_message: input.errorMessage,
      lines: input.lines,
      created_at: new Date(input.windowEnd).toISOString(),
    };
  }
}

function buildUserPrompt(
  project: string,
  windowStart: number,
  windowEnd: number,
  sources: string[],
  existing: string,
): string {
  const material = sources.join('\n');
  return [
    `项目：${project}`,
    `时间窗：${new Date(windowStart).toISOString()} ~ ${new Date(windowEnd).toISOString()}`,
    '',
    '已有记忆（不要重复）：',
    existing.trim() || '（空）',
    '',
    '最近的卡片与任务：',
    material.length > MAX_PROMPT_CHARS ? `${material.slice(0, MAX_PROMPT_CHARS)}\n…（已截断）` : material,
  ].join('\n');
}

/**
 * 把模型输出收敛成可写入记忆的行。
 *
 * 为什么强制 `- [日期] [key] 内容`：
 * - MemoryService 的去重是按整行 trim 比较，格式稳定才能挡住重复；
 * - 用户用 memory.search 按 key 找约束时，key 就在固定位置；
 * - 模型偶尔会少写 `- ` 或写成代码块，这里做最小归一化，格式仍不对就丢弃。
 */
export function sanitizeDigestLines(content: string): string[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  const raw = (parsed as { lines?: unknown })?.lines;
  if (!Array.isArray(raw)) return [];

  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    let line = item.trim();
    if (!line) continue;
    if (!line.startsWith('-')) line = `- ${line}`;
    const match = /^-\s*\[([^\]\n]{1,40})\]\s*\[([^\]\n]{1,80})\]\s*(.+)$/.exec(line);
    if (!match) continue;
    const normalized = `- [${match[1] ?? ''}] [${match[2] ?? ''}] ${(match[3] ?? '').trim()}`;
    if (!result.includes(normalized)) result.push(normalized.slice(0, MAX_MEMORY_LINE_CHARS));
    if (result.length >= MAX_LINES) break;
  }
  return result;
}

function clip(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function toView(row: MemoryDigestRow): MemoryDigestRunView {
  let lines: string[] = [];
  if (row.lines_json) {
    try {
      const parsed: unknown = JSON.parse(row.lines_json);
      if (Array.isArray(parsed)) {
        lines = parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      lines = [];
    }
  }
  return {
    id: row.id,
    project: row.project,
    trigger: row.trigger,
    window_start: new Date(row.window_start).toISOString(),
    window_end: new Date(row.window_end).toISOString(),
    source_count: row.source_count,
    appended: row.appended,
    skipped_duplicates: row.skipped_duplicates,
    result: row.result,
    error_message: row.error_message,
    lines,
    created_at: new Date(row.created_at).toISOString(),
  };
}
