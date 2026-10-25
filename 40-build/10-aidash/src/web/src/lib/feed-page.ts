/**
 * 信息流“倒序取窗 + 正序渲染”的纯函数。
 *
 * 为什么服务端要倒序、前端再反转：
 * 分页接口只能从一端切窗口。若按正序取前 N 条，拿到的是最旧的 N 条，
 * 任务卡超过 N 张之后，新消息永远进不了这个窗口，信息流会静默停在某个时间点。
 * 倒序取最近 N 条保证窗口始终覆盖“最近发生的事”；反转只影响显示方向
 * （越往下越新），与“滚到下方逐条消除未读”的操作方向一致。
 */

/** 信息流一次取最近多少条。改这里即可同时改请求与提示文案，避免两处数字漂移。 */
export const FEED_PAGE_SIZE = 200;

export interface AscendingPage<T> {
  /** 时间正序的条目；新数组，不修改调用方传入的数组。 */
  items: T[];
  /** 服务端返回的符合条件的总数；缺失/非法时回退为实际条数。 */
  total: number;
  /** 实际窗口大小（服务端返回的 page_size），用于提示“仅显示最近 N 条”。 */
  limit: number;
  /** 总数超过实际拿到的条数：当前界面只覆盖一部分数据。 */
  truncated: boolean;
}

/**
 * 把服务端倒序返回的一页条目反转成正序，并算出是否发生截断。
 *
 * 截断判断用 `total > items.length` 而不是 `items.length === limit`：
 * 后者在“恰好 N 条”时也会误报；而 total 是服务端 COUNT(*) 的结果，
 * 能区分“刚好取满”与“后面还有”。
 *
 * 若服务端给了异常 total（缺失、NaN、负数），回退到实际条数：
 * 宁可不提示，也不能制造假的“数据被截断”恐慌。
 */
export function toAscendingPage<T>(
  items: readonly T[],
  total: number,
  limit: number,
): AscendingPage<T> {
  const safeTotal = Number.isFinite(total) && total >= 0 ? total : items.length;
  return {
    items: [...items].reverse(),
    total: safeTotal,
    limit,
    truncated: safeTotal > items.length,
  };
}
