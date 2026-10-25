import type {
  LlmMode,
  ReportKind,
  ReportPeriod,
  ReportRunStatus,
  ReportStatus,
} from '../../shared/types.js';
import type { Db } from '../db/connection.js';

export interface ReportRow {
  id: string;
  kind: ReportKind;
  period: ReportPeriod;
  period_key: string;
  title: string;
  content_md: string | null;
  status: ReportStatus;
  run_id: string | null;
  error_message: string | null;
  source_count: number;
  instruction_md: string | null;
  model: string | null;
  mode: LlmMode | null;
  generated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ReportRunRow {
  id: string;
  kind: ReportKind;
  status: ReportRunStatus;
  current_period: ReportPeriod | null;
  total: number;
  completed: number;
  cancel_requested: number;
  error_message: string | null;
  target_report_id: string | null;
  instruction_md: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface ReportListFilter {
  period?: ReportPeriod;
  kind?: ReportKind;
  limit: number;
  offset: number;
}

/**
 * 汇报数据访问。
 *
 * 这里刻意不写“该不该生成”的判断：并发闸门、周期边界、提示词拼装都在
 * ReportService；仓储只负责把状态写对，保证同一周期只有一行。
 */
export class ReportRepo {
  constructor(private readonly db: Db) {}

  findPeriod(period: ReportPeriod, periodKey: string): ReportRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM report
          WHERE kind = 'period' AND period = ? AND period_key = ?`,
      )
      .get(period, periodKey) as ReportRow | undefined;
  }

  get(id: string): ReportRow | undefined {
    return this.db.prepare(`SELECT * FROM report WHERE id = ?`).get(id) as
      | ReportRow
      | undefined;
  }

  /**
   * 删除一条汇报。
   *
   * 返回受影响行数，调用方先用 `get()` 判断存在性并给出 404；
   * 这里不把“删不到”当成错误，避免并发重复删除时把正常幂等请求报成 500。
   */
  delete(id: string): number {
    return this.db.prepare('DELETE FROM report WHERE id = ?').run(id).changes;
  }

  list(filter: ReportListFilter): { items: ReportRow[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.period) {
      where.push('period = ?');
      params.push(filter.period);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM report ${clause}`).get(...params) as {
        n: number;
      }
    ).n;
    const items = this.db
      .prepare(
        `SELECT * FROM report ${clause}
          ORDER BY updated_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset) as ReportRow[];
    return { items, total };
  }

  /**
   * 取某个批次产出的、已成功生成的汇报。
   *
   * 学习器只该看 ready 的正文：失败/取消的行没有内容，正在生成的行是上一版旧稿，
   * 把它们喂给模型会把“上次汇报”当成“本次经验”，提炼出过时结论。
   */
  listReadyByRun(runId: string): ReportRow[] {
    return this.db
      .prepare(
        `SELECT * FROM report
          WHERE run_id = ? AND status = 'ready'
            AND content_md IS NOT NULL AND trim(content_md) <> ''
          ORDER BY generated_at ASC, id ASC`,
      )
      .all(runId) as ReportRow[];
  }

  /**
   * 开始生成某周期汇报：存在则复用同一行（覆盖更新），不存在才插入。
   *
   * 不在这里清空 content_md：重新生成期间继续显示上一版，比让用户看到空白更稳；
   * 页面用 status='generating' 提示“正在更新”。
   *
   * 覆盖时清空 instruction_md：那是上一次“专题要求”留下的，而本次用的是
   * 标准周期提示词。留着会让详情页把旧要求显示成“本次要求”，老板会误以为
   * “只保留风险”这类约束仍然生效。
   */
  beginPeriod(input: {
    id: string;
    period: ReportPeriod;
    periodKey: string;
    title: string;
    runId: string;
    now: number;
  }): ReportRow {
    const existing = this.findPeriod(input.period, input.periodKey);
    if (existing) {
      this.db
        .prepare(
          `UPDATE report
              SET title = ?, status = 'generating', run_id = ?,
                  error_message = NULL, instruction_md = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.title, input.runId, input.now, existing.id);
      return this.get(existing.id)!;
    }
    this.db
      .prepare(
        `INSERT INTO report
         (id, kind, period, period_key, title, content_md, status, run_id,
          error_message, source_count, instruction_md, model, mode,
          generated_at, created_at, updated_at)
         VALUES (?, 'period', ?, ?, ?, NULL, 'generating', ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.period,
        input.periodKey,
        input.title,
        input.runId,
        input.now,
        input.now,
      );
    return this.get(input.id)!;
  }

  createTopic(input: {
    id: string;
    periodKey: string;
    title: string;
    instruction: string;
    runId: string;
    now: number;
  }): ReportRow {
    this.db
      .prepare(
        `INSERT INTO report
         (id, kind, period, period_key, title, content_md, status, run_id,
          error_message, source_count, instruction_md, model, mode,
          generated_at, created_at, updated_at)
         VALUES (?, 'topic', 'topic', ?, ?, NULL, 'generating', ?, NULL, 0, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.periodKey,
        input.title,
        input.runId,
        input.instruction,
        input.now,
        input.now,
      );
    return this.get(input.id)!;
  }

  /**
   * 专题更新已有汇报。
   *
   * 只动状态与本次要求，不改标题：标题属于这条汇报的身份（月报还是某专题），
   * 一次“按这段话重写”不应该让它从周期列表里消失。instruction 用 COALESCE，
   * 调用方没传就保留上一次的要求，避免误清空。
   */
  beginExisting(
    id: string,
    input: { runId: string; now: number; instruction?: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE report
            SET status = 'generating', run_id = ?, error_message = NULL, updated_at = ?,
                instruction_md = COALESCE(?, instruction_md)
          WHERE id = ?`,
      )
      .run(input.runId, input.now, input.instruction ?? null, id);
  }

  markReady(
    id: string,
    input: {
      content: string;
      sourceCount: number;
      model: string;
      mode: LlmMode;
      now: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE report
            SET content_md = ?, source_count = ?, model = ?, mode = ?,
                status = 'ready', error_message = NULL,
                generated_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.content,
        input.sourceCount,
        input.model,
        input.mode,
        input.now,
        input.now,
        id,
      );
  }

  markFailed(id: string, message: string, now: number): void {
    this.db
      .prepare(
        `UPDATE report
            SET status = 'failed', error_message = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(message, now, id);
  }

  markCancelled(id: string, now: number): void {
    this.db
      .prepare(
        `UPDATE report
            SET status = 'cancelled', error_message = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, id);
  }

  createRun(input: {
    id: string;
    kind: ReportKind;
    total: number;
    targetReportId: string | null;
    instruction: string | null;
    now: number;
  }): ReportRunRow {
    this.db
      .prepare(
        `INSERT INTO report_run
         (id, kind, status, current_period, total, completed, cancel_requested,
          error_message, target_report_id, instruction_md, started_at, finished_at)
         VALUES (?, ?, 'running', NULL, ?, 0, 0, NULL, ?, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.kind,
        input.total,
        input.targetReportId,
        input.instruction,
        input.now,
      );
    return this.getRun(input.id)!;
  }

  getRun(id: string): ReportRunRow | undefined {
    return this.db.prepare(`SELECT * FROM report_run WHERE id = ?`).get(id) as
      | ReportRunRow
      | undefined;
  }

  findRunning(): ReportRunRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM report_run WHERE status = 'running'
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as ReportRunRow | undefined;
  }

  updateRunProgress(id: string, currentPeriod: ReportPeriod, completed: number): void {
    this.db
      .prepare(
        `UPDATE report_run
            SET current_period = ?, completed = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(currentPeriod, completed, id);
  }

  requestCancel(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE report_run SET cancel_requested = 1
          WHERE id = ? AND status = 'running'`,
      )
      .run(id);
    return result.changes > 0;
  }

  isCancelRequested(id: string): boolean {
    const row = this.db
      .prepare(`SELECT cancel_requested FROM report_run WHERE id = ?`)
      .get(id) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  /**
   * 把本轮中“正在生成”的汇报标为已取消。
   *
   * 只动 status='generating' 的行：同一次专题批次里排在后面、还没开始的汇报
   * 不该被误标；它们保持原样，下次还能单独更新。
   */
  markRunCancelled(runId: string, now: number): void {
    this.db
      .prepare(
        `UPDATE report
            SET status = 'cancelled', error_message = NULL, updated_at = ?
          WHERE run_id = ? AND status = 'generating'`,
      )
      .run(now, runId);
  }

  /**
   * 把本轮中“正在生成”的汇报标为失败。
   *
   * 与 markRunCancelled 分开：取消是用户动作，失败是系统问题。混用会把
   * “模型网关 500”显示成“已取消”，复盘时找不到真实原因。
   */
  markRunFailed(runId: string, message: string, now: number): void {
    this.db
      .prepare(
        `UPDATE report
            SET status = 'failed', error_message = ?, updated_at = ?
          WHERE run_id = ? AND status = 'generating'`,
      )
      .run(message, now, runId);
  }

  /**
   * 批次收尾。
   *
   * 只允许 running → 终态：兜底收尾（kick 的 catch）可能在批次已经 done
   * 之后才执行，没有守卫会把成功批次改判失败，用户看到六条汇报都是
   * “已就绪”、批次却是“失败”，无法解释。
   */
  finishRun(
    id: string,
    status: Exclude<ReportRunStatus, 'running'>,
    errorMessage: string | null,
    now: number,
  ): void {
    this.db
      .prepare(
        `UPDATE report_run
            SET status = ?, error_message = ?, finished_at = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(status, errorMessage, now, id);
  }

  listRuns(limit: number): ReportRunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM report_run
          ORDER BY started_at DESC, id DESC
          LIMIT ?`,
      )
      .all(limit) as ReportRunRow[];
  }

  /**
   * 进程重启后，上一轮“running”批次不会再有人推进；留在库里会让新进程
   * 永远以为“已有任务在跑”，所以启动时统一收尸，并把未完成的汇报标失败。
   */
  recoverRunning(now: number): number {
    const running = this.findRunning();
    if (!running) return 0;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE report
              SET status = 'failed', error_message = 'server_restart', updated_at = ?
            WHERE run_id = ? AND status = 'generating'`,
        )
        .run(now, running.id);
      this.db
        .prepare(
          `UPDATE report_run
              SET status = 'failed', error_message = 'server_restart', finished_at = ?
            WHERE id = ?`,
        )
        .run(now, running.id);
    });
    tx();
    return 1;
  }
}
