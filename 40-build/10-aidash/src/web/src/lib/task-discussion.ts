/**
 * 讨论任务批量拆分的纯逻辑。
 *
 * 单独放在 lib 而不是组件里：解析规则（忽略空行、剥离 Markdown 列表前缀）
 * 和上限校验都可以单测，不需要 jsdom 或网络桩。
 */

export const MAX_CHILD_TITLE = 200;
/** 一次最多拆多少条：再多就不是“随手拆问题”，而是在批量导入，容易误操作。 */
export const MAX_CHILD_LINES = 50;

/** 去掉空行与常见 Markdown 列表前缀；标题长度仍由服务端做最终校验。 */
export function parseChildTitles(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0);
}

/** 返回第一条超长标题；全部合法时返回 null。 */
export function findOversizedTitle(titles: readonly string[]): string | null {
  return titles.find((title) => title.length > MAX_CHILD_TITLE) ?? null;
}
