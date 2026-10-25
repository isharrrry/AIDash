import type { Db } from '../db/connection.js';

const DAY_MS = 86_400_000;
const MAX_SOURCE_TASKS = 80;
const MAX_SOURCE_CARDS = 60;
const MAX_BACKLOG_TASKS = 30;
const MAX_SOURCE_CHARS = 400;
const MAX_PROMPT_CHARS = 40_000;

export interface ReportMaterial {
  text: string;
  count: number;
}

export interface MaterialCollectOptions {
  /** 生成时事实只用于近期窗口；调用方传入同一批次使用的时钟。 */
  now: number;
  /** 通道在线阈值必须与设置页/通道树共用同一口径。 */
  offlineThresholdMs: number;
}

interface TaskCounts {
  created: number;
  completed: number;
  failed: number;
  cancelled: number;
}

interface TaskSample {
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
}

interface CardSample {
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
}

interface BacklogTask {
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
  channel_key: string;
  project: string | null;
}

/**
 * 汇报素材的持久化访问。
 *
 * 素材不是单独一张快照表，而是生成时从 task/card/channel/harness 这些
 * 真正持久化的业务记录里取一个有界摘要。这样报告正文与任务状态不会出现
 * “快照说完成、库里还在阻塞”的两套真相；仓储只负责查询与确定性格式化，
 * 不做“该不该生成”的判断（并发闸门与周期边界仍在 ReportService）。
 */
export class MaterialRepo {
  constructor(private readonly db: Db) {}

  collect(start: number, end: number, options: MaterialCollectOptions): ReportMaterial {
    const lines: string[] = [];
    const counts = this.appendStats(lines, start, end);
    const taskCount = this.appendTasks(lines, start, end);
    const cardCount = this.appendCards(lines, start, end);
    this.appendOpenWork(lines, end, options);
    this.appendEnvironment(lines, end, options);

    const full = lines.join('\n');
    const text =
      full.length > MAX_PROMPT_CHARS
        ? `${full.slice(0, MAX_PROMPT_CHARS)}\n…（素材过长，已截断）`
        : full;
    return {
      text,
      count:
        counts.created +
        counts.completed +
        counts.failed +
        counts.cancelled +
        taskCount +
        cardCount,
    };
  }

  private appendStats(lines: string[], start: number, end: number): TaskCounts {
    const row = this.db
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
    const counts: TaskCounts = {
      created: row.created ?? 0,
      completed: row.completed ?? 0,
      failed: row.failed ?? 0,
      cancelled: row.cancelled ?? 0,
    };
    lines.push(
      '## 本周期任务统计',
      `新登记 ${counts.created}；完成 ${counts.completed}；失败 ${counts.failed}；` +
        `取消 ${counts.cancelled}；进入阻塞 ${row.blocked ?? 0}`,
      '',
    );

    const events = this.db
      .prepare(
        `SELECT event, COUNT(*) AS n FROM task_event
          WHERE created_at >= ? AND created_at < ?
          GROUP BY event ORDER BY n DESC`,
      )
      .all(start, end) as Array<{ event: string; n: number }>;
    if (events.length > 0) {
      lines.push('## 状态事件', events.map((item) => `${item.event}: ${item.n}`).join('；'), '');
    }
    return counts;
  }

  private appendTasks(lines: string[], start: number, end: number): number {
    // 长周期（季/半/年）的更新次数远多于 80 条，只取最近 80 条会让前半段缺席；
    // 按行号等距抽样，才能用同样的提示词预算覆盖整个窗口。
    // 谓词必须是 (rn-1) % stride = 0：stride=1 时等价于全选。
    const tasks = this.db
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
          WHERE (rn - 1) % MAX(1, (total + ? - 1) / ?) = 0
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(start, end, MAX_SOURCE_TASKS, MAX_SOURCE_TASKS, MAX_SOURCE_TASKS) as TaskSample[];
    if (tasks.length === 0) return 0;

    const total = tasks[0]?.total ?? tasks.length;
    lines.push(
      total > tasks.length
        ? `## 本周期有更新的任务（共 ${total} 条，按时间均匀抽样 ${tasks.length} 条）`
        : '## 本周期有更新的任务',
    );
    for (const task of tasks) lines.push(formatTaskSample(task));
    lines.push('');
    return tasks.length;
  }

  private appendCards(lines: string[], start: number, end: number): number {
    const cards = this.db
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
          WHERE (rn - 1) % MAX(1, (total + ? - 1) / ?) = 0
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(start, end, MAX_SOURCE_CARDS, MAX_SOURCE_CARDS, MAX_SOURCE_CARDS) as CardSample[];
    if (cards.length === 0) return 0;

    const total = cards[0]?.total ?? cards.length;
    lines.push(
      total > cards.length
        ? `## 本周期卡片（共 ${total} 条，按时间均匀抽样 ${cards.length} 条）`
        : '## 本周期卡片',
    );
    for (const card of cards) {
      const text =
        clipReportText(card.summary, MAX_SOURCE_CHARS) ||
        clipReportText(card.detail_md, MAX_SOURCE_CHARS) ||
        clipReportText(card.body_md, MAX_SOURCE_CHARS);
      if (!text) continue;
      const result = card.result ? `/${card.result}` : '';
      const severity = card.severity ? `/${card.severity}` : '';
      lines.push(
        `- [${card.type}/${card.status}${result}${severity}] ${clipReportText(card.title, 160) || '（无标题）'}：` +
          `${text}（${clipReportText(card.project ?? card.channel_key, 80)}，${formatReportTime(card.created_at)}）`,
      );
    }
    lines.push('');
    return cards.length;
  }

  /**
   * 未结束任务与运行环境是“生成时”事实，不属于某个历史周期。
   * 重写历史周期时不能把当前的阻塞误报成那一期的风险，因此只在近期窗口附加。
   */
  private appendOpenWork(lines: string[], end: number, options: MaterialCollectOptions): void {
    if (!isRecentWindow(end, options.now)) {
      lines.push(
        '## 说明',
        '本次重写的是历史周期；未结束任务与运行环境属于生成时状态，未纳入本期素材，避免把当前事实写成历史。',
        '',
      );
      return;
    }

    const backlog = this.db
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
      .all(MAX_BACKLOG_TASKS) as BacklogTask[];
    const openCount = (
      this.db
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
      for (const task of backlog) lines.push(formatBacklogTask(task));
    }
    lines.push('');
  }

  private appendEnvironment(lines: string[], end: number, options: MaterialCollectOptions): void {
    if (!isRecentWindow(end, options.now)) return;

    const harnesses = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM harness GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    const activeChannels = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM channel WHERE status = 'active'`).get() as {
        n: number;
      }
    ).n;
    const onlineChannels = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM channel
            WHERE status = 'active' AND last_mcp_at IS NOT NULL AND last_mcp_at >= ?`,
        )
        .get(options.now - options.offlineThresholdMs) as { n: number }
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
  }
}

function formatTaskSample(task: TaskSample): string {
  const reason =
    clipReportText(task.blocked_reason, 240) ||
    clipReportText(task.fail_reason, 240) ||
    clipReportText(task.cancel_reason, 240) ||
    clipReportText(task.defer_reason, 240);
  const owner = task.claimed_by || task.assignee || '未指派';
  // 隐患单列：老板复盘时要判断“带病完成”的取舍，混在普通原因里会被忽略。
  const risk = task.risk_note
    ? `；隐患：${clipReportText(task.risk_note, 240)}${
        task.risk_resolved_at
          ? `（已解除${task.risk_resolution ? `：${clipReportText(task.risk_resolution, 120)}` : ''}）`
          : '（未解除）'
      }`
    : '';
  return (
    `- [${task.status}/${task.priority}${task.kind === 'suggestion' ? '/建议' : ''}] ` +
    `${clipReportText(task.title, 200)}（${clipReportText(task.project ?? task.channel_key, 80)}，负责人：${clipReportText(owner, 60)}` +
    `${task.completed_at ? `，完成于 ${formatReportTime(task.completed_at)}` : ''}）` +
    `${reason ? `；原因：${reason}` : ''}${risk}`
  );
}

function formatBacklogTask(task: BacklogTask): string {
  const owner = task.claimed_by || task.assignee || '未指派';
  const flag = task.defer_reason ? '（已暂缓）' : task.blocked_reason ? '（阻塞）' : '';
  const reason =
    clipReportText(task.blocked_reason, 200) || clipReportText(task.defer_reason, 200);
  // 未解除的隐患要在“还开着的活”里显式提示：它比普通任务更容易被遗忘。
  const risk =
    task.risk_note && task.risk_resolved_at === null
      ? `（带隐患：${clipReportText(task.risk_note, 160)}）`
      : '';
  return (
    `- [${task.status}/${task.priority}${task.kind === 'suggestion' ? '/建议' : ''}] ` +
    `${clipReportText(task.title, 200)}（${clipReportText(task.project ?? task.channel_key, 80)}，负责人：${clipReportText(owner, 60)}）` +
    `${flag}${risk}${reason ? `：${reason}` : ''}`
  );
}

function isRecentWindow(end: number, now: number): boolean {
  return end > now - DAY_MS;
}

/** 只留收敛后的单行短文本；提示词里不需要换行与多余空白。 */
export function clipReportText(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 本地时区的短时间：老板看的是本地日历，ISO/UTC 会差 8 小时。 */
export function formatReportTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
