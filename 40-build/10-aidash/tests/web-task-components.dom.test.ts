// @vitest-environment jsdom
/**
 * Web 任务组件的 DOM 交互测试。
 *
 * 为什么单独写一个 DOM 测试文件：
 * 现有的 task-tree-ui / task-board-utils 测试只覆盖纯函数，组件里的“点击行打开详情、
 * 方向键切换、移动前确认、未读红点消除”这些真正依赖浏览器事件的行为没有被验证。
 *
 * 约束：
 * - 不引入测试框架依赖，只用 react-dom/client + jsdom + React 自带的 act；
 * - 只 mock endpoints 模块，不发真实网络请求；
 * - 断言用户可见文本（详情标题、未读 aria-label、Toast）和回调参数，而不是断言 class。
 *
 * 环境通过文件顶部的 `@vitest-environment jsdom` 指定，不改全局 vitest.config。
 */
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/web/src/AppContext.js';
import type { AppContextValue } from '../src/web/src/AppContext.js';
import { TaskBoard } from '../src/web/src/components/TaskBoard.js';
import { TaskDetail } from '../src/web/src/components/TaskDetail.js';
import { TaskTree } from '../src/web/src/components/TaskTree.js';
import { ToastProvider } from '../src/web/src/components/Toast.js';
import * as endpoints from '../src/web/src/api/endpoints.js';
import type { CardView, Page, TaskView, TreeNode } from '../src/web/src/types.js';

vi.mock('../src/web/src/api/endpoints.js', () => ({
  ackEndNotice: vi.fn(),
  claimTask: vi.fn(),
  copyTask: vi.fn(),
  createTask: vi.fn(),
  getTask: vi.fn(),
  getTaskTree: vi.fn(),
  listCards: vi.fn(),
  listHarnesses: vi.fn(),
  markCardRead: vi.fn(),
  moveTask: vi.fn(),
  releaseTask: vi.fn(),
  updateTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// jsdom 缺失的浏览器能力
// ---------------------------------------------------------------------------

/**
 * jsdom 不实现 IntersectionObserver；TaskFeed 在挂载时一定会 new 一个。
 * 这里让被观察的元素立刻“进入视口”，从而真实走一遍“滚到卡片 → 标记已读”的路径。
 */
class ImmediateIntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0.6];
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.callback(
      [
        {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }

  unobserve(): void {}

  disconnect(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

beforeAll(() => {
  // React 19 的 act 需要这个开关，否则会打印“环境未配置 act”的告警。
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver);
  // jsdom 没有布局，scrollIntoView 默认不存在；TaskBoard 选中行时会调用它。
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => undefined;
  }
  // TaskBoard 用 CSS.escape 拼选择器；jsdom 没有 CSS.escape。
  if (typeof CSS === 'undefined' || typeof CSS.escape !== 'function') {
    vi.stubGlobal('CSS', {
      escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`),
    });
  }
});

// ---------------------------------------------------------------------------
// 渲染 / 事件 / 等待辅助
// ---------------------------------------------------------------------------

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

async function flush(): Promise<void> {
  // act 内部等一个宏任务：useAsync 的 Promise 链、TaskFeed 的异步已读回调都在这之后结算。
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(element);
  });
  await flush();
  return container;
}

async function waitFor<T>(
  probe: () => T | null | undefined | false,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = probe();
    if (value) return value;
    await flush();
  }
  throw new Error(`等待超时：${label}`);
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error('要点击的元素不存在');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

/** 绕过 React 的 value tracker，模拟用户在原生 select 里选择一项。 */
async function selectValue(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

async function pressKey(key: string): Promise<void> {
  await act(async () => {
    // 在 body 上派发，才能让 event.target 像真实键盘事件一样有 closest()；
    // 直接派发到 window 会让 TaskBoard 里的 target.closest(...) 抛错。
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

function findSection(container: ParentNode, heading: string): HTMLElement | null {
  return (
    Array.from(container.querySelectorAll('section')).find(
      (section) => section.querySelector('h4')?.textContent?.trim() === heading,
    ) ?? null
  );
}

function findButton(container: ParentNode, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(label),
    ) ?? null
  );
}

function detailTitle(container: ParentNode): string {
  return container.querySelector('aside[aria-label="任务详情"] h2')?.textContent?.trim() ?? '';
}

afterEach(async () => {
  // 先卸载再清 mock：避免轮询/信息流在卸载前继续写状态，污染下一个用例。
  for (const entry of mounted.splice(0)) {
    await act(async () => {
      entry.root.unmount();
    });
    entry.container.remove();
  }
  vi.restoreAllMocks();
  vi.resetAllMocks();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

/** 构造组件实际读取的完整 TaskView/TreeNode 字段。 */
function task(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: 'tk_1',
    channel_id: 'ch_1',
    channel_key: 'host/proj/topic',
    parent_id: null,
    path: '/tk_1/',
    title: '任务',
    description_md: null,
    kind: 'task',
    category: null,
    status: 'pending',
    priority: 'P2',
    assignee: null,
    tags: [],
    due_at: null,
    claimed_by: null,
    claim_expires_at: null,
    claimed_at: null,
    started_at: null,
    blocked_at: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    blocked_reason: null,
    fail_reason: null,
    cancel_reason: null,
    end_notice_read_at: null,
    end_notice_pending: false,
    defer_reason: null,
    deferred_at: null,
    deferred_until: null,
    risk_note: null,
    risk_flagged_at: null,
    risk_resolved_at: null,
    risk_resolution: null,
    evidence_ids: [],
    unread_count: 0,
    created_at: '2026-10-24T10:00:00.000Z',
    updated_at: '2026-10-24T10:00:00.000Z',
    children: [],
    ...overrides,
  };
}

function page(items: CardView[]): Page<CardView> {
  return { items, page: 1, page_size: 200, total: items.length, has_more: false };
}

function unreadCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'cd_1',
    type: 'info',
    priority: 'P2',
    title: '进度更新',
    summary: '任务已开始',
    body_md: null,
    decision_md: null,
    detail_md: null,
    message_md: null,
    read_at: null,
    task_id: 'tk_alpha',
    created_at: '2026-10-24T12:00:00.000Z',
    ...overrides,
  } as unknown as CardView;
}

function appContext(): AppContextValue {
  return {
    refreshNonce: 0,
    refreshAll: vi.fn(),
    channels: [],
    channelsLoading: false,
    reloadChannels: async () => undefined,
    currentChannelKey: 'host/proj/topic',
    setCurrentChannelKey: vi.fn(),
    currentProject: '',
    setCurrentProject: vi.fn(),
  };
}

function withProviders(child: ReactElement): ReactElement {
  return createElement(
    AppContext.Provider,
    { value: appContext() },
    createElement(ToastProvider, null, child),
  );
}

function boardTasks(): TreeNode[] {
  return [
    task({
      id: 'tk_alpha',
      title: 'Alpha 任务',
      status: 'in_progress',
      unread_count: 1,
      created_at: '2026-10-24T12:00:00.000Z',
      updated_at: '2026-10-24T12:00:00.000Z',
    }),
    task({
      id: 'tk_beta',
      title: 'Beta 任务',
      status: 'pending',
      created_at: '2026-10-24T11:00:00.000Z',
      updated_at: '2026-10-24T11:00:00.000Z',
    }),
  ];
}

async function mountBoard(tasks: TreeNode[]): Promise<HTMLElement> {
  vi.mocked(endpoints.getTaskTree).mockResolvedValue(tasks);
  vi.mocked(endpoints.getTask).mockImplementation(async (id) => {
    const found = tasks.find((item) => item.id === id);
    if (!found) throw new Error(`未知任务：${id}`);
    return found;
  });
  const container = await mount(
    withProviders(createElement(TaskBoard, { channelKey: 'host/proj/topic' })),
  );
  await waitFor(
    () => container.querySelector('[data-task-id="tk_alpha"]'),
    '任务树首行渲染',
  );
  return container;
}

beforeEach(() => {
  vi.mocked(endpoints.getTaskTree).mockReset().mockResolvedValue([]);
  vi.mocked(endpoints.listCards).mockReset().mockResolvedValue(page([]));
  vi.mocked(endpoints.listHarnesses).mockReset().mockResolvedValue([]);
  vi.mocked(endpoints.getTask).mockReset().mockResolvedValue(task());
  vi.mocked(endpoints.moveTask).mockReset().mockResolvedValue(task());
  vi.mocked(endpoints.copyTask).mockReset().mockResolvedValue({ task: task(), copied: 1 });
  vi.mocked(endpoints.updateTask).mockReset().mockResolvedValue(task());
  vi.mocked(endpoints.markCardRead).mockReset().mockResolvedValue(unreadCard({ read_at: '2026-10-24T12:05:00.000Z' }));
  vi.mocked(endpoints.claimTask).mockReset().mockResolvedValue({ task: task(), claim_token: 'tok' });
  vi.mocked(endpoints.releaseTask).mockReset().mockResolvedValue(task());
  vi.mocked(endpoints.createTask).mockReset().mockResolvedValue({ task: task(), created: true });
  vi.mocked(endpoints.ackEndNotice).mockReset().mockResolvedValue(task());

  // 让每个用例明确“这些函数都没被调用过”；具体用例再按需覆盖实现。
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('TaskTree', () => {
  it('渲染父子层级与未读标记，点击子任务行回传 id，收起父节点后子行消失', async () => {
    const child = task({
      id: 'tk_child',
      title: '子任务',
      parent_id: 'tk_parent',
      path: '/tk_parent/tk_child/',
      status: 'in_progress',
    });
    const parent = task({
      id: 'tk_parent',
      title: '父任务',
      unread_count: 3,
      children: [child],
    });
    const onOpen = vi.fn();
    const container = await mount(
      createElement(TaskTree, {
        nodes: [parent],
        tokens: {},
        busyId: null,
        harnessId: '',
        activeTaskId: null,
        questionsByTask: {},
        onOpen,
        onOpenCard: vi.fn(),
        onClaim: vi.fn(),
        onRelease: vi.fn(),
        onAddChild: async () => true,
        onMove: async () => true,
      }),
    );

    expect(container.textContent).toContain('父任务');
    expect(container.textContent).toContain('子任务');
    // 未读是用户可见的“3 条未读信息”，不是只检查 class。
    expect(container.querySelector('[aria-label="3 条未读信息"]')?.textContent).toBe('3');

    await click(container.querySelector('[data-task-id="tk_child"]'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('tk_child');

    await click(container.querySelector('button[aria-label="收起子任务"]'));
    expect(container.querySelector('[data-task-id="tk_child"]')).toBeNull();
    // 收起按钮自己 stopPropagation，不应该把父任务也当成一次“打开”。
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('TaskBoard', () => {
  it('点击任务行打开详情并标记为当前行，同时显示未读红点', async () => {
    const container = await mountBoard(boardTasks());

    expect(container.querySelector('[aria-label="1 条未读信息"]')?.textContent).toBe('1');
    await click(container.querySelector('[data-task-id="tk_alpha"]'));

    await waitFor(() => detailTitle(container) === 'Alpha 任务', '详情显示 Alpha 任务');
    expect(endpoints.getTask).toHaveBeenCalledWith('tk_alpha');
    expect(
      container.querySelector('[data-task-id="tk_alpha"]')?.getAttribute('aria-current'),
    ).toBe('true');
  });

  it('方向键按可视顺序切换任务：→ 进入第一条、再 → 到第二条、← 返回第一条', async () => {
    const container = await mountBoard(boardTasks());

    // 组件实际实现是左右键（TaskBoard 的 window keydown），不是任务描述里的上下键。
    await pressKey('ArrowRight');
    await waitFor(() => detailTitle(container) === 'Alpha 任务', '右方向键选中第一条');
    expect(endpoints.getTask).toHaveBeenLastCalledWith('tk_alpha');

    await pressKey('ArrowRight');
    await waitFor(() => detailTitle(container) === 'Beta 任务', '右方向键选中第二条');
    expect(endpoints.getTask).toHaveBeenLastCalledWith('tk_beta');

    await pressKey('ArrowLeft');
    await waitFor(() => detailTitle(container) === 'Alpha 任务', '左方向键返回第一条');
    expect(endpoints.getTask).toHaveBeenLastCalledWith('tk_alpha');
  });

  it('展开任务后标记信息流已读，任务树上的未读红点随之消失', async () => {
    const card = unreadCard();
    vi.mocked(endpoints.listCards).mockImplementation(async (query = {}) =>
      query.task_id === 'tk_alpha' ? page([card]) : page([]),
    );
    vi.mocked(endpoints.markCardRead).mockResolvedValue(
      unreadCard({ read_at: '2026-10-24T12:05:00.000Z' }),
    );

    const container = await mountBoard(boardTasks());
    expect(container.querySelector('[aria-label="1 条未读信息"]')).not.toBeNull();

    await click(container.querySelector('[data-task-id="tk_alpha"]'));
    await waitFor(
      () => vi.mocked(endpoints.markCardRead).mock.calls.length > 0,
      '信息流可见后调用标记已读',
    );
    expect(endpoints.markCardRead).toHaveBeenCalledWith('cd_1');
    // 回传给任务树的未读数变为 0，红点（含其 aria-label）必须消失。
    await waitFor(
      () => container.querySelector('[aria-label="1 条未读信息"]') === null,
      '未读红点消失',
    );
  });
});

describe('TaskDetail', () => {
  it('选择新父节点并确认移动后，用正确的 taskId/newParentId 调接口并提示用户', async () => {
    const root = task({
      id: 'tk_root',
      title: '根任务',
      path: '/tk_root/',
      created_at: '2026-10-24T09:00:00.000Z',
    });
    const child = task({
      id: 'tk_child',
      title: '子任务',
      path: '/tk_child/',
      parent_id: null,
      created_at: '2026-10-24T10:00:00.000Z',
    });
    vi.mocked(endpoints.getTask).mockImplementation(async (id) =>
      id === 'tk_child' ? child : root,
    );
    vi.mocked(endpoints.moveTask).mockResolvedValue(
      task({ ...child, parent_id: 'tk_root' }),
    );

    const onChanged = vi.fn();
    const container = await mount(
      withProviders(
        createElement(TaskDetail, {
          taskId: 'tk_child',
          tasks: [root, child] as TaskView[],
          claimToken: null,
          reloadNonce: 0,
          onChanged,
          onClose: vi.fn(),
        }),
      ),
    );

    const moveSection = await waitFor(
      () => findSection(container, '移动 / 复制'),
      '移动/复制区渲染',
    );
    const select = moveSection.querySelector('select');
    expect(select).not.toBeNull();
    await selectValue(select as HTMLSelectElement, 'tk_root');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const moveButton = findButton(moveSection, '移动到所选父节点');
    await click(moveButton);

    expect(confirmSpy).toHaveBeenCalledWith(
      '确认把任务移动到 「根任务」？所有子任务会一起移动。',
    );
    expect(endpoints.moveTask).toHaveBeenCalledWith('tk_child', 'tk_root');
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(
      () => container.textContent?.includes('任务层级已移动') ?? false,
      '移动成功提示',
    );
  });
});
