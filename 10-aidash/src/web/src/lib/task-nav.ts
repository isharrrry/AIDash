/**
 * 任务详情的方向键导航（纯函数，便于单测）。
 *
 * 为什么单独抽出来：
 * “当前选中项”和“可视树的顺序”分别由 React 状态与筛选结果决定，
 * 把下标计算埋在组件事件里很难验证边界（第一项、最后一项、选中项被筛掉）。
 * 这里只做列表层面的前后跳转，不碰 DOM，也不依赖 React。
 *
 * 语义：
 * - 没有选中项时，向右选第一项、向左选最后一项（等同于从列表头/尾进入）；
 * - 到头后循环，避免用户按到边界还要再反向按很多次；
 * - 当前选中项已不在可视列表（例如被筛选隐藏）时，同样按“从边界进入”处理。
 */
export function stepTaskId(
  ids: readonly string[],
  currentId: string | null,
  direction: 'prev' | 'next',
): string | null {
  if (ids.length === 0) return null;

  const index = currentId ? ids.indexOf(currentId) : -1;
  if (index === -1) {
    return direction === 'next' ? (ids[0] ?? null) : (ids[ids.length - 1] ?? null);
  }

  const delta = direction === 'next' ? 1 : -1;
  // 取模前先加长度：JavaScript 的 % 对负数返回负值，直接使用会得到 -1 下标。
  const nextIndex = (index + delta + ids.length) % ids.length;
  return ids[nextIndex] ?? null;
}
