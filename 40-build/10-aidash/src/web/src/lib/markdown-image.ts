/**
 * 把粘贴图片生成的 Markdown 片段插到光标处。
 *
 * 为什么单独抽成纯函数：光标位置、选区替换、行首行尾补空行这些边界
 * 放在 React 事件里很难测。这里只处理字符串，textarea 只负责把 selectionStart/End 传进来。
 */
export interface InsertResult {
  value: string;
  /** 插入完成后的光标位置：放在片段末尾，用户可以继续打字。 */
  cursor: number;
}

export function insertAtSelection(
  value: string,
  snippet: string,
  start: number,
  end: number,
): InsertResult {
  // 防御异常选区：selectionStart 可能大于 value.length（例如值刚被外部清空）。
  const safeStart = Math.max(0, Math.min(start, value.length));
  const safeEnd = Math.max(safeStart, Math.min(end, value.length));
  const prefix = value.slice(0, safeStart);
  const suffix = value.slice(safeEnd);

  // 图片是块级内容：如果前后紧贴文字，Markdown 会把它当段落里的行内元素。
  // 只在缺换行时补，已经有空行就不重复追加。
  const before = prefix.length > 0 && !prefix.endsWith('\n') ? '\n\n' : '';
  const after = suffix.length > 0 && !suffix.startsWith('\n') ? '\n\n' : '';
  const inserted = `${before}${snippet}${after}`;

  return {
    value: `${prefix}${inserted}${suffix}`,
    cursor: safeStart + inserted.length,
  };
}
