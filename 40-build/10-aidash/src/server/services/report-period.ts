import type { ReportPeriod } from '../../shared/types.js';

/** 周期汇报的固定顺序：点一次“更新汇报”就按这个顺序依次生成/覆盖。 */
export const REPORT_PERIODS = ['day', 'week', 'month', 'quarter', 'half', 'year'] as const;

export type PeriodOnly = (typeof REPORT_PERIODS)[number];

export interface PeriodRange {
  period: PeriodOnly;
  /** 自然周期键：2026-10-24 / 2026-W43 / 2026-10 / 2026-Q4 / 2026-H2 / 2026。 */
  key: string;
  /** 中文标签：日报/周报/…。 */
  label: string;
  /** 左闭右开 [start, end)，毫秒时间戳，按服务器本地时区计算。 */
  start: number;
  end: number;
}

const LABELS: Record<ReportPeriod, string> = {
  day: '日报',
  week: '周报',
  month: '月报',
  quarter: '季度报',
  half: '半年报',
  year: '年报',
  topic: '专题报',
};

export function periodLabel(period: ReportPeriod): string {
  return LABELS[period];
}

/**
 * 计算某个自然周期的边界与 key。
 *
 * 为什么全部用本地时区的 `new Date(y, m, d)`：
 * 用户说“今天的日报”，指的是他所在时区的今天；用 UTC 会在晚上 8 点后
 * 把日期算到明天（东八区）。服务器和用户同机时，本地时区就是对的。
 *
 * 周按 ISO 习惯从周一开始；跨年周用“该周周四所在的年份”命名，
 * 避免 2025-12-29 被叫成 2026-W01 却按 2025 年统计的歧义。
 */
export function periodRange(period: PeriodOnly, now: number): PeriodRange {
  const date = new Date(now);
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();

  switch (period) {
    case 'day': {
      const start = new Date(y, m, d).getTime();
      const end = new Date(y, m, d + 1).getTime();
      return { period, key: `${y}-${pad(m + 1)}-${pad(d)}`, label: LABELS[period], start, end };
    }
    case 'week': {
      // getDay(): 周日=0；把周一映射为 0，得到本周已经过去的天数。
      const offset = (date.getDay() + 6) % 7;
      const monday = new Date(y, m, d - offset);
      const nextMonday = new Date(y, m, d - offset + 7);
      const thursday = new Date(y, m, d - offset + 3);
      const week = isoWeekNumber(thursday);
      const weekYear = thursday.getFullYear();
      return {
        period,
        key: `${weekYear}-W${pad(week)}`,
        label: LABELS[period],
        start: monday.getTime(),
        end: nextMonday.getTime(),
      };
    }
    case 'month': {
      const start = new Date(y, m, 1).getTime();
      const end = new Date(y, m + 1, 1).getTime();
      return { period, key: `${y}-${pad(m + 1)}`, label: LABELS[period], start, end };
    }
    case 'quarter': {
      const q = Math.floor(m / 3) + 1;
      const start = new Date(y, (q - 1) * 3, 1).getTime();
      const end = new Date(y, q * 3, 1).getTime();
      return { period, key: `${y}-Q${q}`, label: LABELS[period], start, end };
    }
    case 'half': {
      const h = m < 6 ? 1 : 2;
      const start = new Date(y, (h - 1) * 6, 1).getTime();
      const end = new Date(y, h * 6, 1).getTime();
      return { period, key: `${y}-H${h}`, label: LABELS[period], start, end };
    }
    case 'year': {
      const start = new Date(y, 0, 1).getTime();
      const end = new Date(y + 1, 0, 1).getTime();
      return { period, key: `${y}`, label: LABELS[period], start, end };
    }
  }
}

/**
 * 由周期 key 反推自然窗口，用于“专题更新某一期汇报”。
 *
 * 为什么需要它：更新三个月前的月报时，素材窗口应该是那个月，而不是当前 30 天；
 * 否则模型会拿最近的事实去改历史报表，读起来自相矛盾。
 * key 解析失败时退回 `periodRange(period, fallbackNow)`，保证总能给出一个窗口。
 */
export function periodRangeFromKey(
  period: PeriodOnly,
  key: string,
  fallbackNow: number,
): PeriodRange {
  const fallback = (): PeriodRange => periodRange(period, fallbackNow);
  switch (period) {
    case 'day': {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
      if (!match) return fallback();
      const y = Number(match[1]);
      const m = Number(match[2]) - 1;
      const d = Number(match[3]);
      return { period, key, label: LABELS[period], start: new Date(y, m, d).getTime(), end: new Date(y, m, d + 1).getTime() };
    }
    case 'week': {
      const match = /^(\d{4})-W(\d{2})$/.exec(key);
      if (!match) return fallback();
      const y = Number(match[1]);
      const week = Number(match[2]);
      if (week < 1 || week > 53) return fallback();
      // ISO 周的第 1 周 = 含 1 月 4 日的那一周；先找该周周一，再平移 (week-1) 周。
      const jan4 = new Date(y, 0, 4);
      const offset = (jan4.getDay() + 6) % 7;
      const start = new Date(y, 0, 4 - offset + (week - 1) * 7).getTime();
      const end = new Date(y, 0, 4 - offset + week * 7).getTime();
      return { period, key, label: LABELS[period], start, end };
    }
    case 'month': {
      const match = /^(\d{4})-(\d{2})$/.exec(key);
      if (!match) return fallback();
      const y = Number(match[1]);
      const m = Number(match[2]) - 1;
      return { period, key, label: LABELS[period], start: new Date(y, m, 1).getTime(), end: new Date(y, m + 1, 1).getTime() };
    }
    case 'quarter': {
      const match = /^(\d{4})-Q([1-4])$/.exec(key);
      if (!match) return fallback();
      const y = Number(match[1]);
      const q = Number(match[2]);
      return { period, key, label: LABELS[period], start: new Date(y, (q - 1) * 3, 1).getTime(), end: new Date(y, q * 3, 1).getTime() };
    }
    case 'half': {
      const match = /^(\d{4})-H([12])$/.exec(key);
      if (!match) return fallback();
      const y = Number(match[1]);
      const h = Number(match[2]);
      return { period, key, label: LABELS[period], start: new Date(y, (h - 1) * 6, 1).getTime(), end: new Date(y, h * 6, 1).getTime() };
    }
    case 'year': {
      const match = /^(\d{4})$/.exec(key);
      if (!match) return fallback();
      const y = Number(match[1]);
      return { period, key, label: LABELS[period], start: new Date(y, 0, 1).getTime(), end: new Date(y + 1, 0, 1).getTime() };
    }
  }
}

/** ISO 周序号：该周周四所在的“第几周”。 */
function isoWeekNumber(thursday: Date): number {
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const firstOffset = (firstThursday.getDay() + 6) % 7;
  const firstMonday = new Date(
    firstThursday.getFullYear(),
    firstThursday.getMonth(),
    firstThursday.getDate() - firstOffset,
  );
  // 用四舍五入吸收夏令时造成的 23/25 小时偏差；中国无夏令时，这里只是通用防御。
  return Math.round((thursday.getTime() - firstMonday.getTime()) / (7 * 86_400_000)) + 1;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 周期标题：`日报 · 2026-10-24`。 */
export function periodTitle(period: PeriodOnly, key: string): string {
  return `${LABELS[period]} · ${key}`;
}
