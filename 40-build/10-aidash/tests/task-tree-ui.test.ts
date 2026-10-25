import { describe, expect, it } from 'vitest';
import {
  buildParentOptions,
  canMoveTask,
  isSelfOrDescendant,
  lastActivityAt,
  matchesTaskKeyword,
  sortTree,
  taskDepth,
} from '../src/web/src/lib/task-tree.js';
import type { TaskStatus } from '../src/web/src/types.js';

/** 构造只含层级所需字段的任务；避免每个用例重复写完整 TaskView。 */
function node(id: string, path: string, title = id) {
  return { id, path, title };
}

describe('任务树层级工具', () => {
  it('物化路径换算层级：根为 0，子节点依次加一', () => {
    expect(taskDepth('/tk_root/')).toBe(0);
    expect(taskDepth('/tk_root/tk_child/')).toBe(1);
    expect(taskDepth('/tk_root/tk_child/tk_grand/')).toBe(2);
  });

  it('前缀即子树：自己与所有后代都算命中', () => {
    expect(isSelfOrDescendant('/tk_a/', '/tk_a/')).toBe(true);
    expect(isSelfOrDescendant('/tk_a/tk_b/', '/tk_a/')).toBe(true);
    expect(isSelfOrDescendant('/tk_a/tk_b/tk_c/', '/tk_a/')).toBe(true);
    // ID 前缀相似但不是层级关系，不能被 startsWith 误伤。
    expect(isSelfOrDescendant('/tk_ab/', '/tk_a/')).toBe(false);
  });

  it('拖拽校验拒绝自己与后代，允许祖先和兄弟', () => {
    const source = node('a', '/tk_a/');
    expect(canMoveTask(source, node('a', '/tk_a/'))).toBe(false);
    expect(canMoveTask(source, node('b', '/tk_a/tk_b/'))).toBe(false);
    expect(canMoveTask(source, node('b', '/tk_a/tk_b/tk_c/'))).toBe(false);

    const child = node('b', '/tk_a/tk_b/');
    // 子任务可以拖回父任务（虽然层级没变），也可以拖到兄弟下。
    expect(canMoveTask(child, node('a', '/tk_a/'))).toBe(true);
    expect(canMoveTask(child, node('c', '/tk_a/tk_c/'))).toBe(true);
    expect(canMoveTask(child, node('x', '/tk_x/'))).toBe(true);
  });

  it('父任务下拉排除自身和后代，并保留层级缩进', () => {
    const tasks = [
      node('root', '/tk_root/', '根任务'),
      node('child', '/tk_root/tk_child/', '子任务'),
      node('grand', '/tk_root/tk_child/tk_grand/', '孙任务'),
      node('other', '/tk_other/', '另一棵树'),
    ];

    const options = buildParentOptions(tasks, 'child');
    expect(options.map((option) => option.id)).toEqual(['root', 'other']);
    expect(options[0]).toMatchObject({ depth: 0, label: '根任务' });
    expect(options[1]).toMatchObject({ depth: 0, label: '另一棵树' });

    // 根任务同样要排除全部后代：把根挂到自己的子节点下会形成环，
    // 移动和复制都不允许，所以选项里只剩另一棵树。
    const rootOptions = buildParentOptions(tasks, 'root');
    expect(rootOptions.map((option) => option.id)).toEqual(['other']);
    expect(rootOptions[0]?.label).toBe('另一棵树');
  });

  it('任务不在列表中时返回空选项，不抛错', () => {
    expect(buildParentOptions([node('root', '/tk_root/')], 'missing')).toEqual([]);
  });
});

/** 构造排序所需的最小节点；时间字段默认相同，用例只覆盖自己关心的维度。 */
interface SortNode {
  id: string;
  status: TaskStatus;
  end_notice_pending: boolean;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  started_at: string | null;
  blocked_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  children: SortNode[];
}

function sortNode(
  id: string,
  overrides: Partial<Omit<SortNode, 'id' | 'children'>> = {},
): SortNode {
  return {
    id,
    status: 'pending',
    end_notice_pending: false,
    created_at: '2026-10-24T10:00:00.000Z',
    updated_at: '2026-10-24T10:00:00.000Z',
    claimed_at: null,
    started_at: null,
    blocked_at: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    children: [],
    ...overrides,
  };
}

describe('任务树排序', () => {
  it('最近活动时间取状态时间线里的最大值，而不是只看 updated_at', () => {
    const task = sortNode('a', {
      updated_at: '2026-10-24T10:00:00.000Z',
      started_at: '2026-10-24T12:00:00.000Z',
      completed_at: '2026-10-24T11:00:00.000Z',
    });
    expect(lastActivityAt(task)).toBe('2026-10-24T12:00:00.000Z');
  });

  it('结束通知排最前，即使它的活动时间更早', () => {
    const notice = sortNode('notice', {
      status: 'done',
      end_notice_pending: true,
      completed_at: '2026-10-24T09:00:00.000Z',
      updated_at: '2026-10-24T09:00:00.000Z',
    });
    const recent = sortNode('recent', { updated_at: '2026-10-24T12:00:00.000Z' });

    expect(sortTree([recent, notice]).map((task) => task.id)).toEqual([
      'notice',
      'recent',
    ]);
  });

  it('活动时间优先于“未结束靠前”：刚完成的排在很久没动的待认领之前', () => {
    const stalePending = sortNode('stale', {
      status: 'pending',
      updated_at: '2026-10-24T09:00:00.000Z',
    });
    const justDone = sortNode('done-now', {
      status: 'done',
      completed_at: '2026-10-24T12:00:00.000Z',
      updated_at: '2026-10-24T12:00:00.000Z',
    });

    expect(sortTree([stalePending, justDone]).map((task) => task.id)).toEqual([
      'done-now',
      'stale',
    ]);
  });

  it('活动时间相同才退回“未结束优先”，再按创建时间倒序', () => {
    const closed = sortNode('closed', { status: 'cancelled' });
    const openOld = sortNode('open-old', {
      created_at: '2026-10-24T08:00:00.000Z',
    });
    const openNew = sortNode('open-new', {
      created_at: '2026-10-24T09:00:00.000Z',
    });

    expect(sortTree([closed, openOld, openNew]).map((task) => task.id)).toEqual([
      'open-new',
      'open-old',
      'closed',
    ]);
  });

  it('排序递归到子节点；父节点原有字段不被原地修改', () => {
    const oldChild = sortNode('child-old', {
      created_at: '2026-10-24T08:00:00.000Z',
    });
    const newChild = sortNode('child-new', {
      created_at: '2026-10-24T09:00:00.000Z',
    });
    const parent = sortNode('parent', { children: [oldChild, newChild] });
    const original = [parent];

    const sorted = sortTree(original);
    expect(sorted[0]?.children.map((task) => task.id)).toEqual([
      'child-new',
      'child-old',
    ]);
    // 不可变：返回新数组/新父节点，原数据顺序保持不变。
    expect(original[0]?.children.map((task) => task.id)).toEqual([
      'child-old',
      'child-new',
    ]);
  });
});

/** 搜索只需要这几列；TreeNode 结构上也满足，测试不必构造完整 TaskView。 */
function searchNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tk_01ABC',
    title: '修复登录白名单',
    category: '认证',
    assignee: '运维同学',
    tags: ['线上', 'P1'],
    ...overrides,
  };
}

describe('任务列表搜索关键字', () => {
  it('空关键字视为不筛选', () => {
    expect(matchesTaskKeyword(searchNode(), '')).toBe(true);
    expect(matchesTaskKeyword(searchNode(), '   ')).toBe(true);
  });

  it('标题、分类、ID、负责人、标签都能命中', () => {
    const task = searchNode();
    expect(matchesTaskKeyword(task, '白名单')).toBe(true);
    expect(matchesTaskKeyword(task, '认证')).toBe(true);
    expect(matchesTaskKeyword(task, 'tk_01abc')).toBe(true);
    expect(matchesTaskKeyword(task, '运维同学')).toBe(true);
    expect(matchesTaskKeyword(task, '线上')).toBe(true);
  });

  it('大小写不敏感，前后空格不影响结果', () => {
    expect(matchesTaskKeyword(searchNode(), '  TK_01ABC  ')).toBe(true);
  });

  it('多个关键字按“同时包含”匹配，而不是任意命中', () => {
    const task = searchNode();
    expect(matchesTaskKeyword(task, '认证 运维同学')).toBe(true);
    // 两个词分别来自不同任务时不应命中这条。
    expect(matchesTaskKeyword(task, '认证 张工')).toBe(false);
  });

  it('空分类/空负责人/无标签不会拼出虚假命中', () => {
    const bare = searchNode({
      category: null,
      assignee: null,
      tags: [],
    });
    expect(matchesTaskKeyword(bare, 'null')).toBe(false);
    expect(matchesTaskKeyword(bare, 'undefined')).toBe(false);
    expect(matchesTaskKeyword(bare, '白名单')).toBe(true);
  });
});
