/**
 * 把 SVG 内容包围盒换算成 viewBox。
 *
 * 为什么需要这一步：mermaid 在部分浏览器/版本上会在最终布局前调用 getBBox()，
 * 把这个“临时尺寸”写进 viewBox，真实图形只占画布左上角一小块或缩成小点。
 * 渲染完成后用真实包围盒重算，比修改 mermaid 内部实现更小、更可控。
 */
export function viewBoxFromBounds(
  bounds: { x: number; y: number; width: number; height: number },
  padding = 8,
): string | null {
  const { x, y, width, height } = bounds;
  const values = [x, y, width, height];
  // 非有限值或空尺寸说明 SVG 还没完成布局（例如在隐藏标签页里），此时不要覆盖原 viewBox。
  if (!values.every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return `${x - padding} ${y - padding} ${width + padding * 2} ${height + padding * 2}`;
}
