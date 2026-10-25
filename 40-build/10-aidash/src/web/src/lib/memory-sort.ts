/**
 * 记忆列表排序。
 *
 * 为什么在前端排序：
 * `/memory/projects` 一次返回全部主对话（通常只有几十个），再让服务端加一组
 * sort 查询参数会把同一套排序规则复制到后端；列表本来就要在浏览器里渲染，
 * 前端排序更直接，也便于测试。
 */

import type { MemoryProjectView } from '../types';

export type MemorySortKey = 'updated' | 'name' | 'lines';

/** 排序只需要这几个字段；MemoryProjectView 结构上满足它，测试也不必造完整对象。 */
export type SortableMemoryProject = Pick<
  MemoryProjectView,
  'project' | 'alias' | 'updated_at' | 'line_count'
>;

/** 名称排序优先用用户能认出的别名；没有别名时退回原始 project。 */
export function memoryDisplayName(project: SortableMemoryProject): string {
  return project.alias?.trim() || project.project;
}

function compareName(left: SortableMemoryProject, right: SortableMemoryProject): number {
  return memoryDisplayName(left).localeCompare(memoryDisplayName(right), 'zh-Hans-CN');
}

/**
 * 返回排好序的新数组，不原地修改输入。
 *
 * - `updated`（默认）：修改时间倒序，未写记忆（updated_at 为 null）排最后；
 * - `name`：按展示名升序；
 * - `lines`：按行数倒序，行数相同再按名称稳定排序。
 */
export function sortMemoryProjects<T extends SortableMemoryProject>(
  projects: readonly T[],
  sort: MemorySortKey,
): T[] {
  const copy = [...projects];

  if (sort === 'name') return copy.sort(compareName);

  if (sort === 'lines') {
    return copy.sort((left, right) => right.line_count - left.line_count || compareName(left, right));
  }

  return copy.sort((left, right) => {
    const leftAt = left.updated_at ?? '';
    const rightAt = right.updated_at ?? '';
    // 空值排最后：还没写过记忆的项目不应该压在“刚更新”的项目前面。
    if (!leftAt && !rightAt) return compareName(left, right);
    if (!leftAt) return 1;
    if (!rightAt) return -1;
    // ISO 8601 字符串可直接比较，避免每次排序都 Date.parse。
    return rightAt.localeCompare(leftAt) || compareName(left, right);
  });
}
