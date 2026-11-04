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
import { TasksPage } from '../src/web/src/pages/TasksPage.js';
import * as endpoints from '../src/web/src/api/endpoints.js';
import type {
  CardView,
  ChannelView,
  Page,
  TaskView,
  TreeNode,
} from '../src/web/src/types.js';

vi.mock('../src/web/src/api/endpoints.js', () => ({
  ackEndNotice: vi.fn(),
  answerCard: vi.fn(),
  archiveCard: vi.fn(),
  claimTask: vi.fn(),
  copyTask: vi.fn(),
  createTask: vi.fn(),
  dismissCard: vi.fn(),
  getCard: vi.fn(),
  getTask: vi.fn(),
  getTaskTree: vi.fn(),
  listCards: vi.fn(),
  listHarnesses: vi.fn(),
  markCardRead: vi.fn(),
  moveTask: vi.fn(),
  releaseTask: vi.fn(),
  setHandoffState: vi.fn(),
  updateCard: vi.fn(),
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
  window.sessionStorage.clear();
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

/** 完整 CardView：内联展开会读取正文、徽标、链接、增强等字段，不能只给最小子集。 */
function cardView(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'cd_status',
    channel_id: 'ch_1',
    channel_key: 'host/proj/topic',
    type: 'status',
    status: 'open',
    priority: 'P2',
    title: '任务执行成功',
    body_md: null,
    background_md: null,
    goal_md: null,
    research_md: null,
    decision_md: null,
    message_md: null,
    preview_md: null,
    summary: '任务执行成功',
    detail_md: '**证据**：服务已启动，/api/health 返回 ok。',
    severity: null,
    recipient: null,
    channel_kind: null,
    reason: null,
    handoff_state: null,
    options: [],
    allow_free_text: false,
    default_action: null,
    due_at: null,
    answer: null,
    answered_at: null,
    url: null,
    kind: null,
    size_bytes: null,
    result: 'success',
    suggestions: [],
    kb_refs: [],
    links: [],
    blocking: false,
    task_id: 'tk_alpha',
    read_at: null,
    enrichment: { status: 'skipped' },
    created_at: '2026-10-24T12:00:00.000Z',
    updated_at: '2026-10-24T12:00:00.000Z',
    archived_at: null,
    ...overrides,
  };
}

/** 构造通道列表项；只填 TaskBoard 会读取的字段，其余给安全默认值。 */
function channel(overrides: Partial<ChannelView> = {}): ChannelView {
  return {
    id: 'ch_1',
    channel_key: 'host/proj/topic',
    title: null,
    alias: null,
    name: null,
    project: null,
    topic: null,
    workdir: null,
    status: 'active',
    card_count: 0,
    task_count: 1,
    open_task_count: 1,
    last_mcp_at: null,
    agent_online: false,
    agent_busy: false,
    last_active_at: null,
    meta: {
      owner: null,
      priority: null,
      stage: null,
      group: null,
      participants: [],
      tags: [],
      iteration: null,
      product: null,
      category: null,
      remark: null,
      ai_suggestion: null,
      ai_suggestion_at: null,
    },
    created_at: '2026-10-24T10:00:00.000Z',
    updated_at: '2026-10-24T10:00:00.000Z',
    ...overrides,
  };
}

function appContext(overrides: Partial<AppContextValue> = {}): AppContextValue {
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
    ...overrides,
  };
}

function withProviders(
  child: ReactElement,
  context: AppContextValue = appContext(),
): ReactElement {
  return createElement(
    AppContext.Provider,
    { value: context },
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
  vi.mocked(endpoints.getCard).mockReset().mockResolvedValue(cardView());
  vi.mocked(endpoints.answerCard).mockReset().mockResolvedValue(cardView());
  vi.mocked(endpoints.setHandoffState).mockReset().mockResolvedValue(cardView());
  vi.mocked(endpoints.updateCard).mockReset().mockResolvedValue(cardView());
  vi.mocked(endpoints.archiveCard).mockReset().mockResolvedValue(cardView({ status: 'archived' }));
  vi.mocked(endpoints.dismissCard).mockReset().mockResolvedValue(cardView({ status: 'dismissed' }));

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

  it('详情卡可在窄侧边和宽侧边之间一键切换，翻到下一条也不丢宽度', async () => {
    const container = await mountBoard(boardTasks());
    await click(container.querySelector('[data-task-id="tk_alpha"]'));
    await waitFor(() => detailTitle(container) === 'Alpha 任务', '详情显示 Alpha 任务');

    const detail = container.querySelector<HTMLElement>('aside[aria-label="任务详情"]');
    expect(detail?.classList.contains('detail-wide')).toBe(false);

    await click(findButton(container, '宽侧边'));
    expect(container.querySelector<HTMLElement>('aside[aria-label="任务详情"]')?.classList.contains('detail-wide')).toBe(true);
    const narrowButton = findButton(container, '窄侧边');
    expect(narrowButton?.getAttribute('aria-pressed')).toBe('true');

    // 翻任务会按 taskId 重挂载详情；宽度偏好必须留在 TaskBoard 层，不能跳回窄侧边。
    await pressKey('ArrowRight');
    await waitFor(() => detailTitle(container) === 'Beta 任务', '右方向键选中第二条');
    expect(container.querySelector<HTMLElement>('aside[aria-label="任务详情"]')?.classList.contains('detail-wide')).toBe(true);

    await click(findButton(container, '窄侧边'));
    expect(container.querySelector<HTMLElement>('aside[aria-label="任务详情"]')?.classList.contains('detail-wide')).toBe(false);
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

describe('TasksPage 多通道看板', () => {
  it('全部通道视图为每条有任务的通道渲染一块“本次通道任务”看板', async () => {
    const channels = [
      channel({ id: 'ch_a', channel_key: 'host/a', task_count: 2 }),
      channel({ id: 'ch_b', channel_key: 'host/b', task_count: 1 }),
      // 没有任务的通道不渲染空看板，也不该发取树请求：task_count=0 必然返回空树。
      channel({ id: 'ch_empty', channel_key: 'host/empty', task_count: 0 }),
    ];
    const aChild = task({
      id: 'tk_a_child',
      title: 'A 子任务',
      channel_id: 'ch_a',
      channel_key: 'host/a',
      parent_id: 'tk_a',
      path: '/tk_a/tk_a_child/',
    });
    const aRoot = task({
      id: 'tk_a',
      title: 'A 根任务',
      channel_id: 'ch_a',
      channel_key: 'host/a',
      children: [aChild],
    });
    const bRoot = task({
      id: 'tk_b',
      title: 'B 根任务',
      channel_id: 'ch_b',
      channel_key: 'host/b',
    });
    vi.mocked(endpoints.getTaskTree).mockImplementation(async (key) => {
      if (key === 'host/a') return [aRoot];
      if (key === 'host/b') return [bRoot];
      throw new Error(`不应请求无任务通道：${key}`);
    });

    const container = await mount(
      withProviders(
        createElement(TasksPage),
        appContext({ channels, currentChannelKey: '', currentProject: '' }),
      ),
    );

    await waitFor(
      () =>
        (container.textContent?.includes('A 根任务') ?? false) &&
        (container.textContent?.includes('B 根任务') ?? false),
      '两个通道的看板同时渲染',
    );

    // 全部通道视图不再把所有通道塞进一个看板：一条通道一块独立看板。
    const boards = Array.from(container.querySelectorAll('.task-channel-group'));
    expect(boards).toHaveLength(2);
    expect(container.querySelector('.task-board:not(.compact)')).toBeNull();
    expect(container.textContent).not.toContain('全部通道任务');
    for (const board of boards) {
      // 每块内部都是独立 compact 看板，标题统一为“本次通道任务”。
      expect(
        board.querySelector('.task-board.compact .task-board-header h2')?.textContent,
      ).toBe('本次通道任务');
    }
    expect(boards[0]?.textContent).toContain('host/a');
    expect(boards[0]?.querySelector('[data-task-id="tk_a"]')).not.toBeNull();
    expect(boards[0]?.querySelector('[data-task-id="tk_b"]')).toBeNull();
    expect(boards[1]?.textContent).toContain('host/b');
    expect(boards[1]?.querySelector('[data-task-id="tk_b"]')).not.toBeNull();
    expect(endpoints.getTaskTree).toHaveBeenCalledWith('host/a', 20);
    expect(endpoints.getTaskTree).toHaveBeenCalledWith('host/b', 20);
    expect(endpoints.getTaskTree).not.toHaveBeenCalledWith('host/empty', 20);
    // 每块只看自己通道的决策卡，不能跨通道混挂。
    expect(endpoints.listCards).toHaveBeenCalledWith({
      channel_key: 'host/a',
      types: ['question'],
      page_size: 200,
    });
    expect(endpoints.listCards).toHaveBeenCalledWith({
      channel_key: 'host/b',
      types: ['question'],
      page_size: 200,
    });
  });

  it('主对话聚焦时每条子通道一块看板，且不混入其他主对话的通道', async () => {
    const channels = [
      channel({ id: 'ch_a', channel_key: 'host/a', project: 'proj', task_count: 1 }),
      channel({ id: 'ch_b', channel_key: 'host/b', project: 'proj', task_count: 1 }),
      channel({ id: 'ch_c', channel_key: 'host/c', project: 'other', task_count: 1 }),
    ];
    vi.mocked(endpoints.getTaskTree).mockImplementation(async (key) => [
      task({ title: `${key} 的任务`, channel_key: key }),
    ]);

    const container = await mount(
      withProviders(
        createElement(TasksPage),
        appContext({ channels, currentChannelKey: '', currentProject: 'proj' }),
      ),
    );

    await waitFor(
      () => (container.textContent?.includes('host/a 的任务') ?? false) &&
        (container.textContent?.includes('host/b 的任务') ?? false),
      '主对话下两条通道的看板渲染',
    );
    expect(container.querySelectorAll('.task-channel-group')).toHaveLength(2);
    expect(container.textContent).not.toContain('host/c 的任务');
    expect(endpoints.getTaskTree).toHaveBeenCalledWith('host/a', 20);
    expect(endpoints.getTaskTree).toHaveBeenCalledWith('host/b', 20);
    expect(endpoints.getTaskTree).not.toHaveBeenCalledWith('host/c', 20);
  });

  it('单个通道取树失败只影响该块，其他通道看板照常渲染', async () => {
    const channels = [
      channel({ id: 'ch_a', channel_key: 'host/a', task_count: 1 }),
      channel({ id: 'ch_b', channel_key: 'host/b', task_count: 1 }),
    ];
    vi.mocked(endpoints.getTaskTree).mockImplementation(async (key) => {
      if (key === 'host/a') {
        return [
          task({
            id: 'tk_a',
            title: '可用任务',
            channel_id: 'ch_a',
            channel_key: 'host/a',
          }),
        ];
      }
      throw new Error('通道 404');
    });

    const container = await mount(
      withProviders(
        createElement(TasksPage),
        appContext({ channels, currentChannelKey: '', currentProject: '' }),
      ),
    );

    await waitFor(
      () => container.textContent?.includes('可用任务') ?? false,
      '成功通道的任务渲染',
    );
    expect(container.querySelector('[data-task-id="tk_a"]')).not.toBeNull();
    expect(container.textContent).toContain('通道 404');
    // 两条通道仍然各有一块看板：失败块显示错误，不拖垮整页。
    expect(container.querySelectorAll('.task-channel-group')).toHaveLength(2);
  });

  it('没有任何带任务的通道时显示“还没有任何通道任务”', async () => {
    const context = appContext({
      channels: [channel({ id: 'ch_empty', channel_key: 'host/empty', task_count: 0 })],
      currentChannelKey: '',
      currentProject: '',
    });
    const container = await mount(
      withProviders(createElement(TasksPage), context),
    );

    await waitFor(
      () => container.textContent?.includes('还没有任何通道任务') ?? false,
      '全部通道空状态',
    );
    expect(container.querySelector('.task-channel-group')).toBeNull();
    expect(endpoints.getTaskTree).not.toHaveBeenCalled();
  });

  it('新建任务表单固定落在所属通道，不再提供跨通道选择器', async () => {
    const channels = [
      channel({ id: 'ch_a', channel_key: 'host/a', task_count: 1 }),
      channel({ id: 'ch_b', channel_key: 'host/b', task_count: 1 }),
    ];
    vi.mocked(endpoints.getTaskTree).mockImplementation(async (key) =>
      key === 'host/a'
        ? [task({ id: 'tk_a', title: 'A 根任务', channel_id: 'ch_a', channel_key: 'host/a' })]
        : [task({ id: 'tk_b', title: 'B 根任务', channel_id: 'ch_b', channel_key: 'host/b' })],
    );

    const container = await mount(
      withProviders(
        createElement(TasksPage),
        appContext({ channels, currentChannelKey: '', currentProject: '' }),
      ),
    );
    await waitFor(
      () => (container.textContent?.includes('A 根任务') ?? false) &&
        (container.textContent?.includes('B 根任务') ?? false),
      '两个通道的看板同时渲染',
    );

    const boards = Array.from(container.querySelectorAll('.task-channel-group'));
    await click(findButton(boards[0] as HTMLElement, '新建任务'));
    const form = await waitFor(
      () => boards[0]?.querySelector<HTMLFormElement>('form.create-task'),
      '新建任务表单渲染',
    );
    // 通道由外层看板固定，表单不再暴露通道选择器。
    expect(form.textContent).toContain('通道 host/a');
    expect(form.querySelector('select[aria-label="任务通道"]')).toBeNull();
    // 父任务下拉只列本通道任务，避免提交跨通道父子关系。
    const parentLabels = Array.from(
      form.querySelectorAll('select[aria-label="父任务"] option'),
    ).map((option) => option.textContent ?? '');
    expect(parentLabels.some((label) => label.includes('A 根任务'))).toBe(true);
    expect(parentLabels.some((label) => label.includes('B 根任务'))).toBe(false);
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

  it('信息流条目点击后原位展开完整卡片详情，再次点击收起，不打开抽屉', async () => {
    const detail = '**证据**：服务已启动，/api/health 返回 ok。';
    const card = cardView({ detail_md: detail });
    vi.mocked(endpoints.getTask).mockResolvedValue(task({ id: 'tk_alpha' }));
    vi.mocked(endpoints.listCards).mockResolvedValue(page([card]));

    const container = await mount(
      withProviders(
        createElement(TaskDetail, {
          taskId: 'tk_alpha',
          tasks: [task({ id: 'tk_alpha' })] as TaskView[],
          claimToken: null,
          reloadNonce: 0,
          onChanged: vi.fn(),
          onClose: vi.fn(),
        }),
      ),
    );

    const toggle = await waitFor(
      () => container.querySelector<HTMLButtonElement>('.task-feed-main'),
      '信息流条目渲染',
    );
    // 收起状态只有摘要，没有正文。
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('服务已启动');

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const expanded = await waitFor(
      () => container.querySelector('.task-feed-detail .card-inline-detail'),
      '内联卡片详情展开',
    );
    expect(expanded.textContent).toContain('服务已启动');
    // 信息流内联展开不应把页面导航到卡片抽屉（?card=cd_...）。
    expect(window.location.hash).not.toContain('card=');

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.task-feed-detail')).toBeNull();
  });

  it('完成证据卡片按需加载并原位展开，同样不跳转到抽屉', async () => {
    const evidence = cardView({
      id: 'cd_ev',
      title: '构建通过',
      detail_md: '证据：构建 231 通过，产物已上传。',
    });
    vi.mocked(endpoints.getTask).mockResolvedValue(
      task({ id: 'tk_alpha', evidence_ids: ['cd_ev'] }),
    );
    vi.mocked(endpoints.listCards).mockResolvedValue(page([]));
    vi.mocked(endpoints.getCard).mockResolvedValue(evidence);

    const container = await mount(
      withProviders(
        createElement(TaskDetail, {
          taskId: 'tk_alpha',
          tasks: [task({ id: 'tk_alpha' })] as TaskView[],
          claimToken: null,
          reloadNonce: 0,
          onChanged: vi.fn(),
          onClose: vi.fn(),
        }),
      ),
    );

    const evidenceSection = await waitFor(
      () => findSection(container, '完成证据'),
      '完成证据区渲染',
    );
    // 收起时不请求卡片详情，只显示卡片 ID。
    expect(endpoints.getCard).not.toHaveBeenCalled();
    const toggle = findButton(evidenceSection, '卡片 cd_ev');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    await click(toggle);
    expect(endpoints.getCard).toHaveBeenCalledWith('cd_ev');
    const expanded = await waitFor(
      () => evidenceSection.querySelector('.card-expander-body .card-inline-detail'),
      '证据卡片内联展开',
    );
    expect(expanded.textContent).toContain('构建 231 通过');
    expect(window.location.hash).not.toContain('card=');

    await click(toggle);
    expect(evidenceSection.querySelector('.card-expander-body')).toBeNull();
  });

  it('信息流里展开的决策卡可以直接在原位作答，不必打开抽屉', async () => {
    const question = cardView({
      id: 'cd_q',
      type: 'question',
      status: 'open',
      title: '先回滚还是先修白名单？',
      summary: null,
      detail_md: null,
      options: [
        {
          id: 'rollback',
          label: '立即回滚',
          pros_md: '恢复最快',
          cons_md: '根因仍在',
          recommendation_role: 'primary',
        },
        {
          id: 'fix',
          label: '等白名单修复',
          pros_md: '消除根因',
          cons_md: '耗时更长',
          recommendation_role: 'backup',
        },
      ],
      allow_free_text: false,
    });
    vi.mocked(endpoints.getTask).mockResolvedValue(task({ id: 'tk_alpha' }));
    vi.mocked(endpoints.listCards).mockResolvedValue(page([question]));
    vi.mocked(endpoints.answerCard).mockResolvedValue(
      cardView({ ...question, status: 'answered' }),
    );

    const container = await mount(
      withProviders(
        createElement(TaskDetail, {
          taskId: 'tk_alpha',
          tasks: [task({ id: 'tk_alpha' })] as TaskView[],
          claimToken: null,
          reloadNonce: 0,
          onChanged: vi.fn(),
          onClose: vi.fn(),
        }),
      ),
    );

    const toggle = await waitFor(
      () => container.querySelector<HTMLButtonElement>('.task-feed-main'),
      '决策卡条目渲染',
    );
    await click(toggle);
    const option = await waitFor(
      () => container.querySelector<HTMLInputElement>('input[value="rollback"]'),
      '原位展开后的选项',
    );
    await click(option);
    await click(findButton(container, '提交回答'));

    expect(endpoints.answerCard).toHaveBeenCalledWith('cd_q', {
      option_id: 'rollback',
      free_text: null,
      note: null,
    });
    // 作答后重新拉取信息流，条目仍留在原位，不跳到抽屉。
    await waitFor(
      () => vi.mocked(endpoints.listCards).mock.calls.length >= 2,
      '作答后刷新信息流',
    );
    expect(window.location.hash).not.toContain('card=');
  });
});
