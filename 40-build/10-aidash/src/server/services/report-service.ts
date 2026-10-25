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
import {
  MaterialRepo,
  clipReportText,
  formatReportTime,
  type ReportMaterial,
} from '../repos/material-repo.js';
import type { ReportRepo, ReportRow, ReportRunRow } from '../repos/report-repo.js';
import type { AuditService } from './audit-service.js';
import { BatchRunner, runBatch } from './batch-runner.js';
import type { LlmService } from './llm-service.js';
import type { SettingsService } from './settings-service.js';
import {
  REPORT_PERIODS,
  periodRange,
  periodRangeFromKey,
  periodTitle,
  type PeriodRange,
} from './report-period.js';

const DAY_MS = 86_400_000;
/** 专题新建时默认回看 30 天；更新某期周期汇报时改用那一期的自然窗口。 */
const TOPIC_WINDOW_DAYS = 30;
const MAX_TOPIC_INSTRUCTION_CHARS = 4_000;
const MAX_TOPIC_TITLE_CHARS = 200;
const MAX_TOPIC_TARGETS = 10;
const REPORT_MAX_TOKENS = 4_096;
const RECENT_RUNS = 10;
export const REPORT_PAGE_SIZE_MAX = 50;

export interface ReportServiceDeps {
  db: Db;
  reports: ReportRepo;
  /**
   * 素材仓储由服务容器装配；保留可选是为了不破坏已有直接构造点，
   * 生产路径一律显式注入，避免出现两份不同的素材口径。
   */
  materials?: MaterialRepo;
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

interface PeriodBatchContext {
  period: PeriodRange['period'];
  range: PeriodRange;
  reportId: string;
}

interface TopicBatchContext {
  current: ReportRow;
}

interface GeneratedReport {
  content: string;
  sourceCount: number;
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
  /** 后台批次的启停与 abort 统一交给共享 runner；服务层只负责业务状态落库。 */
  private readonly batches = new BatchRunner();
  private readonly materials: MaterialRepo;

  constructor(private readonly deps: ReportServiceDeps) {
    this.materials = deps.materials ?? new MaterialRepo(deps.db);
  }

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

    if (!this.batches.abort(runId)) {
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

  /** 注册批次并启动后台任务；异常兜底收尾，保证闸门不会永远停在 running。 */
  private kick(run: ReportRunRow, task: (signal: AbortSignal) => Promise<void>): void {
    this.batches.spawn(run.id, task, () => {
      // execute* 内部已把失败写进库；这里只兜底“连收尾都失败”的情况，
      // 不能把未处理的 rejection 留给进程。
      this.finishSafely(run.id, 'failed', 'report_internal_error');
    });
  }

  /**
   * 关机：中断所有在途批次并等它们收尾。
   *
   * 只 stop 定时器不够——汇报生成是独立的 async 任务，abort 后 catch 分支
   * 还要写 report.status 与 report_run.finished_at；db.close() 抢先执行会让这些更新失败。
   */
  async shutdown(): Promise<void> {
    this.batches.abortAll();
    await this.batches.waitForIdle();
  }

  private async executePeriod(run: ReportRunRow, signal: AbortSignal): Promise<void> {
    const deps = this.deps;
    // 以批次开始时刻定六个周期的边界：一次更新若跨过午夜，
    // 不能出现日报算今天、周报算下周的错位。
    const base = run.started_at;

    await runBatch<PeriodRange['period'], PeriodBatchContext, GeneratedReport>(
      REPORT_PERIODS,
      signal,
      {
        isCancelled: () => deps.reports.isCancelRequested(run.id),
        begin: (period, completed) => {
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
          return { kind: 'continue', context: { period, range, reportId } };
        },
        execute: async (_period, context, taskSignal) => {
          const material = this.collectMaterial(context.range.start, context.range.end);
          const content = await deps.llm.chat({
            system: deps.llm.prompt('report'),
            user: buildPeriodPrompt(
              context.range.label,
              context.range.key,
              context.range.start,
              context.range.end,
              material.text,
            ),
            maxTokens: REPORT_MAX_TOKENS,
            // 汇报一次要读完整窗口素材，失败后用户得整批重来；
            // 上游偶发空响应时多试一次，代价远低于让整批停在 failed。
            retryOnEmpty: 1,
            signal: taskSignal,
          });
          return { content, sourceCount: material.count };
        },
        complete: (_period, context, result, completed) => {
          const settings = deps.settings.current();
          deps.reports.markReady(context.reportId, {
            content: result.content.trim(),
            sourceCount: result.sourceCount,
            model: settings.llmModel ?? 'unknown',
            mode: settings.llmMode,
            now: deps.clock.now(),
          });
          deps.reports.updateRunProgress(run.id, context.period, completed);
        },
        cancelled: (context) => {
          // 模型在取消按钮按下前就返回了：不写入半成品，按取消收尾。
          if (context) deps.reports.markCancelled(context.reportId, deps.clock.now());
          this.finishCancelled(run.id);
        },
        halted: (_period, reason) => {
          // 周期批次不会主动中止；保留兜底，避免未来新增周期时静默卡住。
          deps.reports.finishRun(run.id, 'failed', reason, deps.clock.now());
        },
        failed: (_period, context, _error, reason) => {
          deps.reports.markFailed(context.reportId, reason, deps.clock.now());
          deps.reports.finishRun(run.id, 'failed', reason, deps.clock.now());
          deps.audit.record(systemCtx(run.id), 'report.update', 'error', 'report_run', run.id, {
            period: context.period,
            error: reason,
          });
        },
        done: (completed) => {
          deps.reports.finishRun(run.id, 'done', null, deps.clock.now());
          deps.audit.record(systemCtx(run.id), 'report.update', 'ok', 'report_run', run.id, {
            completed,
            total: REPORT_PERIODS.length,
          });
          this.notifyRunDone(run.id);
        },
        reasonForError: errorText,
      },
    );
  }

  private async executeTopic(
    run: ReportRunRow,
    targets: Array<{ row: ReportRow; instruction: string }>,
    instruction: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deps = this.deps;

    await runBatch<
      { row: ReportRow; instruction: string },
      TopicBatchContext,
      GeneratedReport
    >(targets, signal, {
      isCancelled: () => deps.reports.isCancelRequested(run.id),
      begin: (target, completed) => {
        // 目标可能在批次启动后被删除：启动时校验过 404，但后台执行是异步的。
        // 这里若退回启动时的快照，beginExisting/markReady 会更新 0 行，
        // 批次却按 completed 递增收尾为 done——用户看到的是一次“静默成功”。
        const current = deps.reports.get(target.row.id);
        if (!current) {
          return { kind: 'halt', reason: `report_not_found:${target.row.id}` };
        }

        deps.reports.updateRunProgress(run.id, current.period, completed);
        // 逐条进入“生成中”而不是启动时批量预标记：这一条失败/被取消时，
        // 后面的目标仍保持原状态，可以单独再提交。本次要求也在这里落库，
        // 与状态写入同一条 UPDATE，避免出现“状态没变但要求已改”的中间态。
        deps.reports.beginExisting(current.id, {
          runId: run.id,
          now: deps.clock.now(),
          instruction: target.instruction,
        });
        return { kind: 'continue', context: { current } };
      },
      execute: async (_target, context, taskSignal) => {
        // 更新周期汇报时用那一期的窗口；新建专题/更新专题用最近 30 天。
        const range =
          context.current.kind === 'period' && context.current.period !== 'topic'
            ? periodRangeFromKey(
                context.current.period,
                context.current.period_key,
                run.started_at,
              )
            : {
                start: run.started_at - TOPIC_WINDOW_DAYS * DAY_MS,
                end: run.started_at,
              };
        const material = this.collectMaterial(range.start, range.end);
        const content = await deps.llm.chat({
          system: deps.llm.prompt('report'),
          user: buildTopicPrompt(
            instruction,
            context.current,
            range.start,
            range.end,
            material.text,
          ),
          maxTokens: REPORT_MAX_TOKENS,
          retryOnEmpty: 1,
          signal: taskSignal,
        });
        return { content, sourceCount: material.count };
      },
      complete: (_target, context, result, completed) => {
        const settings = deps.settings.current();
        deps.reports.markReady(context.current.id, {
          content: result.content.trim(),
          sourceCount: result.sourceCount,
          model: settings.llmModel ?? 'unknown',
          mode: settings.llmMode,
          now: deps.clock.now(),
        });
        deps.reports.updateRunProgress(run.id, context.current.period, completed);
      },
      cancelled: (context) => {
        if (context) deps.reports.markCancelled(context.current.id, deps.clock.now());
        this.finishCancelled(run.id);
      },
      halted: (target, reason, completed) => {
        deps.reports.finishRun(run.id, 'failed', reason, deps.clock.now());
        deps.audit.record(systemCtx(run.id), 'report.topic', 'error', 'report_run', run.id, {
          report_id: target.row.id,
          error: 'report_not_found',
          completed,
          total: targets.length,
        });
      },
      failed: (_target, context, _error, reason) => {
        deps.reports.markFailed(context.current.id, reason, deps.clock.now());
        deps.reports.finishRun(run.id, 'failed', reason, deps.clock.now());
        deps.audit.record(systemCtx(run.id), 'report.topic', 'error', 'report_run', run.id, {
          report_id: context.current.id,
          error: reason,
        });
      },
      done: (completed) => {
        deps.reports.finishRun(run.id, 'done', null, deps.clock.now());
        deps.audit.record(systemCtx(run.id), 'report.topic', 'ok', 'report_run', run.id, {
          completed,
          total: targets.length,
          instruction_chars: instruction.length,
        });
        this.notifyRunDone(run.id);
      },
      reasonForError: errorText,
    });
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
   * 汇总窗口素材。
   *
   * SQL 与格式化已移到 MaterialRepo（直接查询 task/card/channel/harness 的持久化记录），
   * 服务层只负责把“生成时刻”和在线阈值传进去，保证提示词口径仍由 ReportService 决定。
   */
  private collectMaterial(start: number, end: number): ReportMaterial {
    return this.materials.collect(start, end, {
      now: this.deps.clock.now(),
      offlineThresholdMs: this.deps.offlineThresholdMs,
    });
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
    `周期：${key}（${formatReportTime(start)} ~ ${formatReportTime(end)}）`,
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
    `时间范围：${formatReportTime(start)} ~ ${formatReportTime(end)}`,
    '',
    '用户要求（必须按这段话组织内容）：',
    instruction,
  ];
  if (target.kind === 'topic') {
    parts.push('', '已有专题汇报（在此基础上改写）：', `标题：${target.title}`);
    if (target.content_md) {
      parts.push('当前内容：', clipReportText(target.content_md, 12_000));
    }
  } else {
    parts.push(
      '',
      `要更新的已有汇报：${target.title}（${target.period_key}）`,
      target.content_md ? `当前内容：\n${clipReportText(target.content_md, 12_000)}` : '当前内容：（尚未生成）',
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
