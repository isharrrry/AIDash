import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import type { Clock } from '../../shared/time.js';
import type {
  Ctx,
  LlmMode,
  Page,
  ReportKind,
  ReportPeriod,
  ReportRunView,
  ReportStatusView,
  ReportView,
} from '../../shared/types.js';
import type { Db } from '../db/connection.js';
import type { ReportRepo, ReportRow, ReportRunRow } from '../repos/report-repo.js';
import type { AuditService } from './audit-service.js';
import type { LlmService } from './llm-service.js';
import type { SettingsService } from './settings-service.js';
import {
  REPORT_PERIODS,
  periodRange,
  periodRangeFromKey,
  periodTitle,
} from './report-period.js';

const DAY_MS = 86_400_000;
/** 专题新建时默认回看 30 天；更新某期周期汇报时改用那一期的自然窗口。 */
const TOPIC_WINDOW_DAYS = 30;
const MAX_SOURCE_TASKS = 80;
const MAX_SOURCE_CARDS = 60;
const MAX_BACKLOG_TASKS = 30;
const MAX_SOURCE_CHARS = 400;
const MAX_PROMPT_CHARS = 40_000;
const MAX_TOPIC_INSTRUCTION_CHARS = 4_000;
const MAX_TOPIC_TITLE_CHARS = 200;
const MAX_TOPIC_TARGETS = 10;
const REPORT_MAX_TOKENS = 4_096;
const RECENT_RUNS = 10;
export const REPORT_PAGE_SIZE_MAX = 50;

export interface ReportServiceDeps {
  db: Db;
  reports: ReportRepo;
  llm: LlmService;
  settings: SettingsService;
  audit: AuditService;
  clock: Clock;
  /** 通道在线阈值，与设置页/通道树共用同一口径。 */
  offlineThresholdMs: number;
  /**
   * 批次成功完成后的旁路回调（用于更新 AIDash 自己的记忆）。
   *
   * 用回调而不是直接依赖学习器：汇报服务不需要知道“学什么、怎么写记忆”，
   * 测试里也可以完全不接这条链路。实现方必须自行吞掉异常——学习失败
   * 不能把已经完成的批次改回 failed。
   */
  onRunDone?: (runId: string) => void;
}

export interface TopicReportInput {
  /** 用户给的主题；为空时取要求首行，保证列表里能认出这条汇报。 */
  topic?: string | null;
  instruction: string;
  /** 要更新的已有汇报；为空表示新建专题汇报。一次最多 10 条。 */
  targetReportIds?: string[];
}

interface Material {
  text: string;
  count: number;
}

/**
 * 汇报生成服务。
 *
 * 三条硬约束：
 * - 同一时间只允许一个批次在跑（周期和专题共用一个闸门），否则两个模型请求
 *   会同时改写同一条汇报，最后写入者赢，用户看到的顺序不可解释；
 * - 周期批次固定按 日→周→月→季→半年→年 顺序，逐条写入，前端能看到进度；
 * - 取消要能穿透正在等待的模型请求：DB 标记用于“将来再查”，AbortController
 *   用于“现在就断”，两者缺一都会留下“取消后还在跑”的窗口。
 */
export class ReportService {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: ReportServiceDeps) {}

  /** 启动时收尸：上一个进程留下的 running 不会再有人推进，必须标失败。 */
  recover(): number {
    const count = this.deps.reports.recoverRunning(this.deps.clock.now());
    if (count > 0) {
      this.deps.audit.record(systemCtx('report-recover'), 'report.recover', 'ok', 'report_run', null, {
        recovered: count,
      });
    }
    return count;
  }

  status(): ReportStatusView {
    const running = this.deps.reports.findRunning();
    return {
      running: running ? toRunView(running) : null,
      runs: this.deps.reports.listRuns(RECENT_RUNS).map(toRunView),
    };
  }

  list(query: {
    period?: ReportPeriod;
    kind?: ReportKind;
    page?: number;
    page_size?: number;
  }): Page<ReportView> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(Math.max(query.page_size ?? 20, 1), REPORT_PAGE_SIZE_MAX);
    const { items, total } = this.deps.reports.list({
      period: query.period,
      kind: query.kind,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return {
      items: items.map(toReportView),
      page,
      page_size: pageSize,
      total,
      has_more: page * pageSize < total,
    };
  }

  get(id: string): ReportView {
    const row = this.deps.reports.get(id);
    if (!row) throw new AppError('NOT_FOUND', 'REPORT_NOT_FOUND', { report_id: id });
    return toReportView(row);
  }

  /**
   * 删除一条汇报。
   *
   * 生成中的汇报不允许删：后台批次还在按 id 更新这一行，删掉后 markReady/markFailed
   * 会落到不存在的行上，批次进度与列表状态会永久对不上。先取消/等批次结束再删。
   *
   * 审计只记标题与周期，不记正文——正文可能很长，且审计链不需要复制内容。
   */
  delete(id: string, ctx: Ctx): { deleted: true } {
    const row = this.deps.reports.get(id);
    if (!row) throw new AppError('NOT_FOUND', 'REPORT_NOT_FOUND', { report_id: id });
    if (row.status === 'generating') {
      throw new AppError('CONFLICT', 'REPORT_GENERATING', { report_id: id });
    }

    const changed = this.deps.reports.delete(id);
    this.deps.audit.record(ctx, 'report.delete', 'ok', 'report', id, {
      title: row.title,
      period: row.period,
      period_key: row.period_key,
      changed,
    });
    return { deleted: true };
  }

  /**
   * “更新汇报”按钮：按自然期限依次生成/覆盖六种周期汇报。
   *
   * 同步返回批次视图，真正的生成在后台跑：生成六个周期可能要几分钟，
   * 让 HTTP 请求一直挂着既会超时，也挡住用户点“取消”。
   */
  startPeriodUpdate(ctx: Ctx): ReportRunView {
    this.assertReady();
    this.assertIdle();
    const now = this.deps.clock.now();
    const run = this.deps.reports.createRun({
      id: newId('rn', now),
      kind: 'period',
      total: REPORT_PERIODS.length,
      targetReportId: null,
      instruction: null,
      now,
    });
    this.auditStart(run, ctx, 'report.update.start', { total: run.total });
    this.kick(run, (signal) => this.executePeriod(run, signal));
    return toRunView(run);
  }

  /**
   * 专题汇报：按用户写的一段话，新建一条专题，或更新指定的已有汇报。
   *
   * 允许一次指定多条目标（“某些汇报条目”）：批次里逐条生成，
   * 目标不存在的直接 404，生成中的目标 409——不在后台静默跳过，
   * 否则用户会以为“点了但没变”是模型没写好。
   */
  startTopic(input: TopicReportInput, ctx: Ctx): ReportRunView {
    const instruction = input.instruction.trim();
    if (!instruction) {
      throw new AppError('INVALID_ARGUMENT', 'PARAM_REQUIRED', { key: 'instruction' });
    }
    if (instruction.length > MAX_TOPIC_INSTRUCTION_CHARS) {
      throw new AppError('INVALID_ARGUMENT', 'PARAM_TOO_LONG', {
        key: 'instruction',
        max: MAX_TOPIC_INSTRUCTION_CHARS,
      });
    }
    this.assertReady();
    this.assertIdle();

    const targetIds = [...new Set((input.targetReportIds ?? []).filter(Boolean))];
    if (targetIds.length > MAX_TOPIC_TARGETS) {
      throw new AppError('INVALID_ARGUMENT', 'PARAM_OUT_OF_RANGE', {
        key: 'target_report_ids',
        max: MAX_TOPIC_TARGETS,
      });
    }

    const targets: ReportRow[] = [];
    for (const id of targetIds) {
      const row = this.deps.reports.get(id);
      if (!row) throw new AppError('NOT_FOUND', 'REPORT_NOT_FOUND', { report_id: id });
      if (row.status === 'generating') {
        throw new AppError('CONFLICT', 'REPORT_GENERATING', { report_id: id });
      }
      targets.push(row);
    }

    const now = this.deps.clock.now();
    const runId = newId('rn', now);
    const topic = normalizeTopic(input.topic, instruction);
    const reportId = targets.length === 0 ? newId('rp', now) : null;

    // 先建批次再建汇报：反过来一旦 createRun 失败，会留下一条 run_id
    // 指向不存在批次的 generating 汇报，重启收尸也找不到它。
    const run = this.deps.reports.createRun({
      id: runId,
      kind: 'topic',
      total: reportId ? 1 : targets.length,
      targetReportId: reportId ?? targets[0]?.id ?? null,
      instruction,
      now,
    });

    if (reportId) {
      try {
        this.deps.reports.createTopic({
          id: reportId,
          periodKey: dateKey(now),
          title: `专题 · ${topic}`,
          instruction,
          runId,
          now,
        });
      } catch (error) {
        // 批次已落库但没有任何汇报可生成；不收尾的话闸门会一直关着。
        this.failStart(run.id, 'report_start_failed');
        throw error;
      }
    }

    // 更新已有汇报不改编标题：用户要的是“按这段话重写这条月报”，
    // 把标题改成“专题 · xxx”会让周期身份丢失，也会和左侧按周期筛选对不上。
    // 本次要求写在 instruction_md 里，详情页单独展示。
    //
    // 这里刻意不预先把所有目标标成 generating：多目标批次里排在后面的汇报
    // 在轮到它之前应保持原状态。预标记会让前一条失败/取消时，后面的行
    // 永远停在“生成中”，且因 REPORT_GENERATING 再也无法提交。
    this.auditStart(run, ctx, 'report.topic.start', {
      ...(reportId ? { report_id: reportId } : { report_ids: targets.map((row) => row.id) }),
      mode: reportId ? 'create' : 'update',
      total: run.total,
    });

    if (reportId) {
      this.kick(run, (signal) =>
        this.executeTopic(
          run,
          [{ row: this.deps.reports.get(reportId)!, instruction }],
          instruction,
          signal,
        ),
      );
    } else {
      this.kick(run, (signal) =>
        this.executeTopic(
          run,
          targets.map((row) => ({ row, instruction })),
          instruction,
          signal,
        ),
      );
    }
    return toRunView(run);
  }

  /**
   * 取消本轮。
   *
   * 先写 DB 标记再 abort：即使取消请求与“某一期刚好生成完”擦肩而过，
   * 生成循环下一轮检查标记时仍会停下，不会把剩下的周期继续跑完。
   */
  cancel(runId: string, ctx: Ctx): ReportRunView {
    const run = this.deps.reports.getRun(runId);
    if (!run) throw new AppError('NOT_FOUND', 'REPORT_RUN_NOT_FOUND', { run_id: runId });
    if (run.status !== 'running') {
      throw new AppError('CONFLICT', 'REPORT_RUN_FINISHED', { run_id: runId, status: run.status });
    }
    this.deps.reports.requestCancel(runId);
    this.deps.audit.record(ctx, 'report.cancel', 'ok', 'report_run', runId, {
      completed: run.completed,
      total: run.total,
    });

    const controller = this.controllers.get(runId);
    if (controller) {
      controller.abort();
    } else {
      // 没有控制器说明这个批次不在当前进程里推进（异常残留）；
      // 不直接收尾的话，页面会永远停在“取消中”。
      const now = this.deps.clock.now();
      this.deps.reports.markRunCancelled(runId, now);
      this.deps.reports.finishRun(runId, 'cancelled', null, now);
    }
    return toRunView({ ...run, cancel_requested: 1 });
  }

  private assertReady(): void {
    if (!this.deps.llm.isConfigured()) {
      throw new AppError('INVALID_ARGUMENT', 'LLM_NOT_CONFIGURED', {
        hint: '请先在设置页配置模型端点、模型名与 API Key',
      });
    }
  }

  private assertIdle(): void {
    const running = this.deps.reports.findRunning();
    if (running) {
      throw new AppError('CONFLICT', 'REPORT_RUNNING', {
        run_id: running.id,
        hint: '等当前批次结束或先取消它',
      });
    }
  }

  /**
   * 记启动审计。
   *
   * 审计是旁路，但这里不能让它把批次留在 running：批次已经落库、还没有
   * 控制器推进，异常直接抛出去会让后续所有发起都被 409 挡住，只能重启进程。
   */
  private auditStart(
    run: ReportRunRow,
    ctx: Ctx,
    action: string,
    details: Record<string, unknown>,
  ): void {
    try {
      this.deps.audit.record(ctx, action, 'ok', 'report_run', run.id, details);
    } catch (error) {
      this.failStart(run.id, 'report_start_failed');
      throw error;
    }
  }

  /** 启动阶段失败时的收尾；尽力而为，不能掩盖导致失败的真实错误。 */
  private failStart(runId: string, message: string): void {
    const now = this.deps.clock.now();
    try {
      this.deps.reports.markRunFailed(runId, message, now);
    } catch {
      // 数据库写不进去时，finishRun 大概率也失败；下面再试一次即可。
    }
    try {
      this.deps.reports.finishRun(runId, 'failed', message, now);
    } catch {
      // 保留原始错误向上抛，调用方才能看到启动失败的真实原因。
    }
  }

  /** 注册 AbortController 并启动后台任务；任务结束后必须移除，否则取消会打到旧批次。 */
  private kick(run: ReportRunRow, task: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    void task(controller.signal)
      .catch(() => {
        // execute* 内部已把失败写进库；这里只兜底“连收尾都失败”的情况，
        // 不能把未处理的 rejection 留给进程。
        this.finishSafely(run.id, 'failed', 'report_internal_error');
      })
      .finally(() => {
        this.controllers.delete(run.id);
      });
  }

  private async executePeriod(run: ReportRunRow, signal: AbortSignal): Promise<void> {
    const deps = this.deps;
    // 以批次开始时刻定六个周期的边界：一次更新若跨过午夜，
    // 不能出现日报算今天、周报算下周的错位。
    const base = run.started_at;
    let completed = 0;

    for (const period of REPORT_PERIODS) {
      if (deps.reports.isCancelRequested(run.id)) {
        this.finishCancelled(run.id);
        return;
      }
      const range = periodRange(period, base);
      const existing = deps.reports.findPeriod(period, range.key);
      const reportId = existing?.id ?? newId('rp', deps.clock.now());
      deps.reports.updateRunProgress(run.id, period, completed);
      deps.reports.beginPeriod({
        id: reportId,
        period,
        periodKey: range.key,
        title: periodTitle(period, range.key),
        runId: run.id,
        now: deps.clock.now(),
      });

      try {
        const material = this.collectMaterial(range.start, range.end);
        const content = await deps.llm.chat({
          system: deps.llm.prompt('report'),
          user: buildPeriodPrompt(range.label, range.key, range.start, range.end, material.text),
          maxTokens: REPORT_MAX_TOKENS,
          signal,
        });
        if (deps.reports.isCancelRequested(run.id)) {
          // 模型在取消按钮按下前就返回了：不写入半成品，按取消收尾。
          deps.reports.markCancelled(reportId, deps.clock.now());
          this.finishCancelled(run.id);
          return;
        }
        const settings = deps.settings.current();
        deps.reports.markReady(reportId, {
          content: content.trim(),
          sourceCount: material.count,
          model: settings.llmModel ?? 'unknown',
          mode: settings.llmMode,
          now: deps.clock.now(),
        });
        completed += 1;
        deps.reports.updateRunProgress(run.id, period, completed);
      } catch (error) {
        if (deps.reports.isCancelRequested(run.id)) {
          deps.reports.markCancelled(reportId, deps.clock.now());
          this.finishCancelled(run.id);
          return;
        }
        const reason = errorText(error);
        deps.reports.markFailed(reportId, reason, deps.clock.now());
        deps.reports.finishRun(run.id, 'failed', reason, deps.clock.now());
        deps.audit.record(systemCtx(run.id), 'report.update', 'error', 'report_run', run.id, {
          period,
          error: reason,
        });
        return;
      }
    }

    deps.reports.finishRun(run.id, 'done', null, deps.clock.now());
    deps.audit.record(systemCtx(run.id), 'report.update', 'ok', 'report_run', run.id, {
      completed,
      total: REPORT_PERIODS.length,
    });
    this.notifyRunDone(run.id);
  }

  private async executeTopic(
    run: ReportRunRow,
    targets: Array<{ row: ReportRow; instruction: string }>,
    instruction: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deps = this.deps;
    let completed = 0;

    for (const target of targets) {
      if (deps.reports.isCancelRequested(run.id)) {
        this.finishCancelled(run.id);
        return;
      }
      const current = deps.reports.get(target.row.id) ?? target.row;
      deps.reports.updateRunProgress(run.id, current.period, completed);
      // 逐条进入“生成中”而不是启动时批量预标记：这一条失败/被取消时，
      // 后面的目标仍保持原状态，可以单独再提交。本次要求也在这里落库，
      // 与状态写入同一条 UPDATE，避免出现“状态没变但要求已改”的中间态。
      deps.reports.beginExisting(current.id, {
        runId: run.id,
        now: deps.clock.now(),
        instruction: target.instruction,
      });

      try {
        // 更新周期汇报时用那一期的窗口；新建专题/更新专题用最近 30 天。
        const range =
          current.kind === 'period' && current.period !== 'topic'
            ? periodRangeFromKey(current.period, current.period_key, run.started_at)
            : {
                start: run.started_at - TOPIC_WINDOW_DAYS * DAY_MS,
                end: run.started_at,
              };
        const material = this.collectMaterial(range.start, range.end);
        const content = await deps.llm.chat({
          system: deps.llm.prompt('report'),
          user: buildTopicPrompt(instruction, current, range.start, range.end, material.text),
          maxTokens: REPORT_MAX_TOKENS,
          signal,
        });
        if (deps.reports.isCancelRequested(run.id)) {
          deps.reports.markCancelled(current.id, deps.clock.now());
          this.finishCancelled(run.id);
          return;
        }
        const settings = deps.settings.current();
        deps.reports.markReady(current.id, {
          content: content.trim(),
          sourceCount: material.count,
          model: settings.llmModel ?? 'unknown',
          mode: settings.llmMode,
          now: deps.clock.now(),
        });
        completed += 1;
        deps.reports.updateRunProgress(run.id, current.period, completed);
      } catch (error) {
        if (deps.reports.isCancelRequested(run.id)) {
          deps.reports.markCancelled(current.id, deps.clock.now());
          this.finishCancelled(run.id);
          return;
        }
        const reason = errorText(error);
        deps.reports.markFailed(current.id, reason, deps.clock.now());
        deps.reports.finishRun(run.id, 'failed', reason, deps.clock.now());
        deps.audit.record(systemCtx(run.id), 'report.topic', 'error', 'report_run', run.id, {
          report_id: current.id,
          error: reason,
        });
        return;
      }
    }

    deps.reports.finishRun(run.id, 'done', null, deps.clock.now());
    deps.audit.record(systemCtx(run.id), 'report.topic', 'ok', 'report_run', run.id, {
      completed,
      total: targets.length,
      instruction_chars: instruction.length,
    });
    this.notifyRunDone(run.id);
  }

  /**
   * 通知“批次已完成”的旁路订阅者。
   *
   * 放在 finishRun 之后：此时批次已经落库为 done，学习器即使立刻查库也能看到
   * 本批次的汇报。回调本身同步返回（内部通常是 `void learner.learn(...)`），
   * 不阻塞批次收尾——学习要等一次模型调用，让用户多等几秒去换一条记忆不值得。
   */
  private notifyRunDone(runId: string): void {
    try {
      this.deps.onRunDone?.(runId);
    } catch {
      // 订阅者同步抛错也不能影响已经完成的批次；学习器自己的失败由它自己记审计。
    }
  }

  private finishCancelled(runId: string): void {
    const now = this.deps.clock.now();
    this.deps.reports.markRunCancelled(runId, now);
    this.deps.reports.finishRun(runId, 'cancelled', null, now);
    this.deps.audit.record(systemCtx(runId), 'report.cancel', 'ok', 'report_run', runId, {
      stage: 'finished',
    });
  }

  /**
   * 兜底收尾：仓储异常时也不能让批次永远停在 running。
   *
   * 取消与失败必须分开标：把 failed 的汇报标成 cancelled 会清掉 error_message，
   * 等于把真实故障伪装成用户主动取消，复盘时根本查不到原因。
   */
  private finishSafely(
    runId: string,
    status: 'failed' | 'cancelled',
    message: string | null,
  ): void {
    try {
      const now = this.deps.clock.now();
      if (status === 'failed') {
        this.deps.reports.markRunFailed(runId, message ?? 'report_internal_error', now);
      } else {
        this.deps.reports.markRunCancelled(runId, now);
      }
      this.deps.reports.finishRun(runId, status, message, now);
    } catch {
      // 数据库都写不进去时，日志由调用层的 request_failed 兜底；这里再抛只会掩盖原错误。
    }
  }

  /**
   * 汇总一个窗口内的系统事实。
   *
   * 只取“人写得出来”的摘要：标题、状态、原因、简短描述。不把完整描述
   * （可能内嵌 base64 截图）塞进提示词，否则一个任务就能吃光上下文。
   */
  private collectMaterial(start: number, end: number): Material {
    const db = this.deps.db;
    const lines: string[] = [];

    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS created,
           SUM(CASE WHEN completed_at >= ? AND completed_at < ? THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN failed_at >= ? AND failed_at < ? THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN cancelled_at >= ? AND cancelled_at < ? THEN 1 ELSE 0 END) AS cancelled,
           SUM(CASE WHEN blocked_at >= ? AND blocked_at < ? THEN 1 ELSE 0 END) AS blocked
         FROM task`,
      )
      .get(start, end, start, end, start, end, start, end, start, end) as {
      created: number | null;
      completed: number | null;
      failed: number | null;
      cancelled: number | null;
      blocked: number | null;
    };
    lines.push(
      '## 本周期任务统计',
      `新登记 ${counts.created ?? 0}；完成 ${counts.completed ?? 0}；失败 ${counts.failed ?? 0}；` +
        `取消 ${counts.cancelled ?? 0}；进入阻塞 ${counts.blocked ?? 0}`,
      '',
    );

    const eventCounts = db
      .prepare(
        `SELECT event, COUNT(*) AS n FROM task_event
          WHERE created_at >= ? AND created_at < ?
          GROUP BY event ORDER BY n DESC`,
      )
      .all(start, end) as Array<{ event: string; n: number }>;
    if (eventCounts.length > 0) {
      lines.push(
        '## 状态事件',
        eventCounts.map((row) => `${row.event}: ${row.n}`).join('；'),
        '',
      );
    }

    // 长周期（季/半/年）的更新次数远多于 80 条；只取“最近 80 条”会让前半段
    // 完全缺席。这里按行号等距抽样：同样的提示词预算下覆盖整个窗口，
    // 而不是把半年报写成“最近两个月小结”。
    const tasks = db
      .prepare(
        `WITH scoped AS (
           SELECT t.title, t.status, t.kind, t.priority, t.assignee, t.claimed_by,
                  t.blocked_reason, t.fail_reason, t.cancel_reason, t.defer_reason,
                  t.risk_note, t.risk_resolved_at, t.risk_resolution,
                  t.completed_at, t.updated_at, ch.channel_key, ch.project,
                  ROW_NUMBER() OVER (ORDER BY t.updated_at DESC) AS rn,
                  COUNT(*) OVER () AS total
             FROM task t JOIN channel ch ON ch.id = t.channel_id
            WHERE t.updated_at >= ? AND t.updated_at < ?
         )
         SELECT title, status, kind, priority, assignee, claimed_by,
                blocked_reason, fail_reason, cancel_reason, defer_reason,
                risk_note, risk_resolved_at, risk_resolution,
                completed_at, updated_at, channel_key, project, total
           FROM scoped
          WHERE rn % MAX(1, (total + ? - 1) / ?) = 1
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(start, end, MAX_SOURCE_TASKS, MAX_SOURCE_TASKS, MAX_SOURCE_TASKS) as Array<{
      title: string;
      status: string;
      kind: string;
      priority: string;
      assignee: string | null;
      claimed_by: string | null;
      blocked_reason: string | null;
      fail_reason: string | null;
      cancel_reason: string | null;
      defer_reason: string | null;
      risk_note: string | null;
      risk_resolved_at: number | null;
      risk_resolution: string | null;
      completed_at: number | null;
      updated_at: number;
      channel_key: string;
      project: string | null;
      total: number;
    }>;
    if (tasks.length > 0) {
      const taskTotal = tasks[0]?.total ?? tasks.length;
      lines.push(
        taskTotal > tasks.length
          ? `## 本周期有更新的任务（共 ${taskTotal} 条，按时间均匀抽样 ${tasks.length} 条）`
          : '## 本周期有更新的任务',
      );
      for (const task of tasks) {
        const reason =
          clip(task.blocked_reason, 240) ||
          clip(task.fail_reason, 240) ||
          clip(task.cancel_reason, 240) ||
          clip(task.defer_reason, 240);
        const owner = task.claimed_by || task.assignee || '未指派';
        // 隐患单列出来：老板复盘时要判断“带病完成”的取舍，混在普通原因里会被忽略。
        const risk = task.risk_note
          ? `；隐患：${clip(task.risk_note, 240)}${
              task.risk_resolved_at
                ? `（已解除${task.risk_resolution ? `：${clip(task.risk_resolution, 120)}` : ''}）`
                : '（未解除）'
            }`
          : '';
        lines.push(
          `- [${task.status}/${task.priority}${task.kind === 'suggestion' ? '/建议' : ''}] ` +
            `${clip(task.title, 200)}（${clip(task.project ?? task.channel_key, 80)}，负责人：${clip(owner, 60)}` +
            `${task.completed_at ? `，完成于 ${formatTs(task.completed_at)}` : ''}）` +
            `${reason ? `；原因：${reason}` : ''}${risk}`,
        );
      }
      lines.push('');
    }

    const cards = db
      .prepare(
        `WITH scoped AS (
           SELECT c.type, c.status, c.title, c.summary, c.body_md, c.detail_md, c.result,
                  c.severity, c.created_at, ch.channel_key, ch.project,
                  ROW_NUMBER() OVER (ORDER BY c.created_at DESC) AS rn,
                  COUNT(*) OVER () AS total
             FROM card c JOIN channel ch ON ch.id = c.channel_id
            WHERE c.created_at >= ? AND c.created_at < ?
         )
         SELECT type, status, title, summary, body_md, detail_md, result,
                severity, created_at, channel_key, project, total
           FROM scoped
          WHERE rn % MAX(1, (total + ? - 1) / ?) = 1
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(start, end, MAX_SOURCE_CARDS, MAX_SOURCE_CARDS, MAX_SOURCE_CARDS) as Array<{
      type: string;
      status: string;
      title: string | null;
      summary: string | null;
      body_md: string | null;
      detail_md: string | null;
      result: string | null;
      severity: string | null;
      created_at: number;
      channel_key: string;
      project: string | null;
      total: number;
    }>;
    if (cards.length > 0) {
      const cardTotal = cards[0]?.total ?? cards.length;
      lines.push(
        cardTotal > cards.length
          ? `## 本周期卡片（共 ${cardTotal} 条，按时间均匀抽样 ${cards.length} 条）`
          : '## 本周期卡片',
      );
      for (const card of cards) {
        const text =
          clip(card.summary, MAX_SOURCE_CHARS) ||
          clip(card.detail_md, MAX_SOURCE_CHARS) ||
          clip(card.body_md, MAX_SOURCE_CHARS);
        if (!text) continue;
        const result = card.result ? `/${card.result}` : '';
        const severity = card.severity ? `/${card.severity}` : '';
        lines.push(
          `- [${card.type}/${card.status}${result}${severity}] ${clip(card.title, 160) || '（无标题）'}：` +
            `${text}（${clip(card.project ?? card.channel_key, 80)}，${formatTs(card.created_at)}）`,
        );
      }
      lines.push('');
    }

    // 未结束任务与运行环境是“生成时”事实，不属于某个历史周期。
    // 重写 6 月月报时把它们写进去，会把 10 月的阻塞误报成 6 月的风险；
    // 因此只在“刚结束不到一天”的窗口（当前周期、最近 30 天专题）里附加。
    const now = this.deps.clock.now();
    const isRecent = end > now - DAY_MS;
    if (isRecent) {
      const backlog = db
        .prepare(
          `SELECT t.title, t.status, t.kind, t.priority, t.assignee, t.claimed_by,
                  t.blocked_reason, t.defer_reason, t.risk_note, t.risk_resolved_at,
                  t.updated_at, ch.channel_key, ch.project
             FROM task t JOIN channel ch ON ch.id = t.channel_id
            WHERE t.status IN ('draft','pending','claimed','in_progress','blocked')
            ORDER BY CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
                     t.updated_at DESC
            LIMIT ?`,
        )
        .all(MAX_BACKLOG_TASKS) as Array<{
        title: string;
        status: string;
        kind: string;
        priority: string;
        assignee: string | null;
        claimed_by: string | null;
        blocked_reason: string | null;
        defer_reason: string | null;
        risk_note: string | null;
        risk_resolved_at: number | null;
        updated_at: number;
        channel_key: string;
        project: string | null;
      }>;
      const openCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM task
              WHERE status IN ('draft','pending','claimed','in_progress','blocked')`,
          )
          .get() as { n: number }
      ).n;
      lines.push(`## 生成时未结束任务（共 ${openCount} 条，列出前 ${backlog.length} 条）`);
      if (backlog.length === 0) {
        lines.push('- 无');
      } else {
        for (const task of backlog) {
          const owner = task.claimed_by || task.assignee || '未指派';
          const flag = task.defer_reason ? '（已暂缓）' : task.blocked_reason ? '（阻塞）' : '';
          const reason = clip(task.blocked_reason, 200) || clip(task.defer_reason, 200);
          // 未解除的隐患要在“还开着的活”里显式提示：它比普通任务更容易被遗忘。
          const risk =
            task.risk_note && task.risk_resolved_at === null
              ? `（带隐患：${clip(task.risk_note, 160)}）`
              : '';
          lines.push(
            `- [${task.status}/${task.priority}${task.kind === 'suggestion' ? '/建议' : ''}] ` +
              `${clip(task.title, 200)}（${clip(task.project ?? task.channel_key, 80)}，负责人：${clip(owner, 60)}）` +
              `${flag}${risk}${reason ? `：${reason}` : ''}`,
          );
        }
      }
      lines.push('');

      const harnesses = db
        .prepare(`SELECT status, COUNT(*) AS n FROM harness GROUP BY status`)
        .all() as Array<{ status: string; n: number }>;
      const activeChannels = (
        db.prepare(`SELECT COUNT(*) AS n FROM channel WHERE status = 'active'`).get() as {
          n: number;
        }
      ).n;
      const onlineChannels = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM channel
              WHERE status = 'active' AND last_mcp_at IS NOT NULL AND last_mcp_at >= ?`,
          )
          .get(now - this.deps.offlineThresholdMs) as { n: number }
      ).n;
      lines.push(
        '## 生成时运行环境',
        `活跃通道 ${activeChannels}，其中最近有 MCP 活动 ${onlineChannels}；` +
          `harness：${
            harnesses.length === 0
              ? '无记录'
              : harnesses.map((row) => `${row.status} ${row.n}`).join('，')
          }`,
      );
    } else {
      lines.push(
        '## 说明',
        '本次重写的是历史周期；未结束任务与运行环境属于生成时状态，未纳入本期素材，避免把当前事实写成历史。',
        '',
      );
    }

    const text =
      lines.join('\n').length > MAX_PROMPT_CHARS
        ? `${lines.join('\n').slice(0, MAX_PROMPT_CHARS)}\n…（素材过长，已截断）`
        : lines.join('\n');
    const count =
      (counts.created ?? 0) +
      (counts.completed ?? 0) +
      (counts.failed ?? 0) +
      (counts.cancelled ?? 0) +
      tasks.length +
      cards.length;
    return { text, count };
  }
}

function buildPeriodPrompt(
  label: string,
  key: string,
  start: number,
  end: number,
  material: string,
): string {
  return [
    `汇报类型：${label}`,
    `周期：${key}（${formatTs(start)} ~ ${formatTs(end)}）`,
    '',
    '素材（全部来自 AIDash 系统记录；没记录的内容写“本期无记录”，不要编造）：',
    material || '（本周期没有任何记录）',
  ].join('\n');
}

function buildTopicPrompt(
  instruction: string,
  target: ReportRow,
  start: number,
  end: number,
  material: string,
): string {
  const parts = [
    '汇报类型：专题报',
    `时间范围：${formatTs(start)} ~ ${formatTs(end)}`,
    '',
    '用户要求（必须按这段话组织内容）：',
    instruction,
  ];
  if (target.kind === 'topic') {
    parts.push('', '已有专题汇报（在此基础上改写）：', `标题：${target.title}`);
    if (target.content_md) {
      parts.push('当前内容：', clip(target.content_md, 12_000));
    }
  } else {
    parts.push(
      '',
      `要更新的已有汇报：${target.title}（${target.period_key}）`,
      target.content_md ? `当前内容：\n${clip(target.content_md, 12_000)}` : '当前内容：（尚未生成）',
    );
  }
  parts.push('', '素材（全部来自 AIDash 系统记录；没记录的内容不要编造）：', material || '（无记录）');
  return parts.join('\n');
}

function toReportView(row: ReportRow): ReportView {
  return {
    id: row.id,
    kind: row.kind,
    period: row.period,
    period_key: row.period_key,
    title: row.title,
    content_md: row.content_md,
    status: row.status,
    run_id: row.run_id,
    error_message: row.error_message,
    source_count: row.source_count,
    instruction_md: row.instruction_md,
    model: row.model,
    mode: row.mode as LlmMode | null,
    generated_at: row.generated_at === null ? null : new Date(row.generated_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function toRunView(row: ReportRunRow): ReportRunView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    current_period: row.current_period,
    total: row.total,
    completed: row.completed,
    cancel_requested: row.cancel_requested === 1,
    error_message: row.error_message,
    target_report_id: row.target_report_id,
    instruction_md: row.instruction_md,
    started_at: new Date(row.started_at).toISOString(),
    finished_at: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
  };
}

function systemCtx(runId: string): Ctx {
  return { actorLabel: 'report', requestId: `report_${runId}`, isOwner: false };
}

/** 错误只留收敛后的错误码/短句，不把上游响应或堆栈写进用户可见字段。 */
function errorText(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return 'report_generation_failed';
}

function normalizeTopic(topic: string | null | undefined, instruction: string): string {
  const raw = (topic ?? '').trim();
  const fallback = instruction.split(/\r?\n/, 1)[0] ?? '';
  const text = raw || fallback || '未命名专题';
  return text.length > MAX_TOPIC_TITLE_CHARS
    ? `${text.slice(0, MAX_TOPIC_TITLE_CHARS)}…`
    : text;
}

function dateKey(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时区的短时间：老板看的是本地日历，ISO/UTC 会差 8 小时。 */
function formatTs(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function clip(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
