import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { CardView, TaskStatus, TaskView, TreeNode } from '../types';
import { ApiError, describeError } from '../api/client';
import {
  ackEndNotice,
  claimTask,
  createTask,
  getTaskTree,
  listCards,
  listHarnesses,
  moveTask,
  releaseTask,
} from '../api/endpoints';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import { useDebounced } from '../hooks/useDebounced';
import { usePolling } from '../hooks/usePolling';
import { TASK_STATUS_LABELS } from '../lib/format';
import { openCard } from '../lib/router';
import { stepTaskId } from '../lib/task-nav';
import { matchesTaskKeyword } from '../lib/task-tree';
import { EmptyState, ErrorBox, Loading } from './Feedback';
import { TaskCreateForm } from './TaskCreateForm';
import { TaskDetail } from './TaskDetail';
import { sortTree, TaskTree } from './TaskTree';
import { useToast } from './Toast';

const HARNESS_STORAGE_KEY = 'aidash.harness_id';
const ALL_STATUSES: TaskStatus[] = [
  'draft',
  'pending',
  'claimed',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
];

/**
 * SCR-03 任务树看板。
 *
 * claim_token 只存内存（Record<taskId, token>）：服务端只在认领响应中返回一次，
 * 前端不把它写 localStorage——令牌是操作凭据，不是可长期展示的数据。
 */
export function TaskBoard({
  channelKey,
  compact = false,
}: {
  channelKey: string;
  compact?: boolean;
}): ReactElement {
  const { refreshNonce } = useApp();
  const notify = useToast().notify;

  const [harnessId, setHarnessId] = useState(
    () => window.sessionStorage.getItem(HARNESS_STORAGE_KEY) ?? '',
  );
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const [statuses, setStatuses] = useState<TaskStatus[]>([]);
  const [assignee, setAssignee] = useState('');
  /**
   * 搜索关键字：标题、分类、ID、负责人、标签都在匹配范围内。
   *
   * 与状态/负责人筛选是“并且”关系：搜索负责在已聚焦的范围里找具体条目，
   * 两套筛选取交集比互相覆盖更符合直觉。
   */
  const [keyword, setKeyword] = useState('');
  /**
   * 默认只看“待处理”：未结束，或已结束但结束通知还没确认。
   *
   * 用户打开任务树最先要回答的是“现在还有什么要处理”，而不是翻历史。
   * 带未确认结束通知的终态节点必须保留——它们正是用户需要看到的变化；
   * 点“全部”才切到含已结束任务的完整列表。
   */
  const [hideClosed, setHideClosed] = useState(true);
  /**
   * 信息流逐条已读后的未读数覆盖。
   *
   * 为什么不直接整树 reload：用户滚动信息流时每读一条就重拉一次树，
   * 几十条消息会产生几十次请求，还会让任务树闪烁。这里只在本地把对应节点的
   * 数字改成详情里算出的剩余值；30 秒轮询/手动刷新时再用服务端数据校准。
   */
  const [unreadOverrides, setUnreadOverrides] = useState<Record<string, number>>({});
  /**
   * 结束通知的本地已读覆盖。
   *
   * 点击任务行时先把高亮抹掉，再发请求：等服务端往返会让用户以为“点了没反应”。
   * 请求失败时清掉覆盖并 reload，让服务端事实重新接管（提醒会回来）。
   */
  const [endNoticeAcked, setEndNoticeAcked] = useState<Record<string, true>>({});
  const debouncedAssignee = useDebounced(assignee, 300);
  // 搜索防抖稍短：本地过滤没有网络成本，200ms 足以避免长树每敲一个字就重排。
  const debouncedKeyword = useDebounced(keyword, 200);

  const tree = useAsync<TreeNode[]>(
    () => (channelKey ? getTaskTree(channelKey, 10) : Promise.resolve([])),
    [channelKey, refreshNonce],
    Boolean(channelKey),
  );
  /**
   * 当前通道的决策卡。
   *
   * 任务树用来看“活做到哪了”，决策卡用来看“卡在哪个拍板上”。
   * 两者以前分在两个界面，用户要在脑子里按标题做关联；
   * 这里按 task_id 归组后直接挂到任务行下面，归属关系不用再猜。
   *
   * 只取 question：info/status/artifact 是任务的证据流，塞进树里会淹掉决策。
   */
  const questions = useAsync<CardView[]>(
    () =>
      channelKey
        ? listCards({
            channel_key: channelKey,
            types: ['question'],
            page_size: 200,
          }).then((page) => page.items)
        : Promise.resolve([]),
    [channelKey, refreshNonce],
    Boolean(channelKey),
  );
  const harnesses = useAsync(
    () => listHarnesses(),
    [refreshNonce],
  );

  useEffect(() => {
    // 切通道时清空会话令牌与选中项，避免把 A 通道的令牌误用到 B 通道。
    setTokens({});
    setSelectedTaskId(null);
    setCreating(false);
    // 未读覆盖只对当前通道的任务 id 有意义，跨通道保留会污染同 id（理论上不会重）的显示。
    setUnreadOverrides({});
    setEndNoticeAcked({});
  }, [channelKey]);

  usePolling(
    () => {
      tree.reload();
      questions.reload();
    },
    30000,
    Boolean(channelKey),
  );

  useEffect(() => {
    // 树数据每次刷新都代表服务端的最新事实（已读已落库）。
    // 如果继续保留本地 unreadOverrides，就会出现“读过一次之后，
    // 该任务下新到的信息被本地 0 覆盖、红点永不重现”的问题。
    // 丢掉覆盖值后，服务端未读数（含新卡）立即重新接管显示。
    setUnreadOverrides((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    // 结束通知同理：服务端已读时间落库后才刷新树，本地覆盖必须让位给服务端事实。
    // 若 ack 失败后 reload，服务端仍返回 pending=true，提醒会自动重现。
    setEndNoticeAcked((prev) => (Object.keys(prev).length === 0 ? prev : {}));
  }, [tree.data]);

  const flatTasks = useMemo(() => flattenTree(tree.data ?? []), [tree.data]);
  // 头部统计按整棵树算，不受状态/负责人筛选影响：
  // 筛选是“临时聚焦”，统计是“这条通道还有多少活”，两者口径混在一起会误导认领。
  const stats = useMemo(() => {
    let open = 0;
    let active = 0;
    let pending = 0;
    let draft = 0;
    let blocked = 0;
    let done = 0;
    let cancelled = 0;
    let deferred = 0;
    let riskOpen = 0;
    for (const task of flatTasks) {
      // “进行中”= 已被认领且正在做。claimed 也是有人接了，只差还没点开始，
      // 对用户来说都属于“正在处理”，所以和 in_progress 一起算，不让进度条空转。
      if (task.status === 'claimed' || task.status === 'in_progress') active += 1;
      if (task.status === 'pending') pending += 1;
      if (task.status === 'draft') draft += 1;
      if (task.status === 'blocked') blocked += 1;
      if (task.status === 'done') done += 1;
      if (task.status === 'cancelled') cancelled += 1;
      // 暂缓是独立维度：任务可能同时是 pending 且已暂缓，两个统计都要计入。
      if (task.defer_reason) deferred += 1;
      // 隐患同样是独立维度：它可能挂在已完成的任务上，只统计仍未解除的。
      if (task.risk_note && !task.risk_resolved_at) riskOpen += 1;
      // 口径必须与服务端 channel.open_task_count 完全一致：pending/claimed/in_progress/blocked。
      // draft 还没提交（不可认领），不计“有活待干”；
      // 两边定义不同会让通道 chip 的“未结束”和看板头部的“未结束”对不上。
      if (
        task.status === 'pending' ||
        task.status === 'claimed' ||
        task.status === 'in_progress' ||
        task.status === 'blocked'
      ) {
        open += 1;
      }
    }
    return {
      total: flatTasks.length,
      open,
      active,
      pending,
      draft,
      blocked,
      done,
      cancelled,
      deferred,
      riskOpen,
    };
  }, [flatTasks]);
  /**
   * 进度条分母去掉“已取消”。
   *
   * 取消代表“这件事决定不做了”，它不应拉低完成率；
   * 失败保留在分母里——失败仍需处理，把它从分母拿掉会让进度条虚高。
   */
  const progressBase = Math.max(stats.total - stats.cancelled, 0);
  const donePct = progressBase > 0 ? Math.round((stats.done / progressBase) * 100) : 0;
  const activePct = progressBase > 0 ? Math.round((stats.active / progressBase) * 100) : 0;
  const questionsByTask = useMemo(() => {
    const grouped: Record<string, CardView[]> = {};
    for (const card of questions.data ?? []) {
      if (!card.task_id) continue;
      const list = grouped[card.task_id];
      if (list) list.push(card);
      else grouped[card.task_id] = [card];
    }
    return grouped;
  }, [questions.data]);
  const statusKey = statuses.join(',');
  const visibleTree = useMemo(() => {
    const filtered = filterTree(
      tree.data ?? [],
      new Set(statuses),
      debouncedAssignee.trim().toLowerCase(),
      debouncedKeyword,
    );
    // 显式勾选了“完成/取消”状态 chip 时，用户已经表达了要看这些状态，
    // 不能让默认的“待处理”筛选把它们再藏一遍（否则勾完列表是空的）。
    const closedFiltered = hideClosed ? withoutClosed(filtered, new Set(statuses)) : filtered;
    return applyEndNoticeOverrides(
      applyUnreadOverrides(closedFiltered, unreadOverrides),
      endNoticeAcked,
    );
  }, [
    tree.data,
    statusKey,
    debouncedAssignee,
    debouncedKeyword,
    hideClosed,
    unreadOverrides,
    endNoticeAcked,
  ]);
  // 方向键必须按“屏幕上实际看到的顺序”翻阅：TaskTree 渲染前还会排序，
  // 这里先做同一份排序再拍平，否则左右键会跳到视觉顺序之外的节点。
  const visibleFlat = useMemo(() => flattenTree(sortTree(visibleTree)), [visibleTree]);
  const visibleIds = useMemo(() => visibleFlat.map((task) => task.id), [visibleFlat]);
  const selectedIndex = selectedTaskId ? visibleIds.indexOf(selectedTaskId) : -1;

  useEffect(() => {
    if (!channelKey) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      // 带修饰键的组合留给浏览器/系统快捷键（例如 Alt+← 后退）。
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      // 光标在输入框里时，左右键是移动光标，不能被任务翻阅抢走。
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      // 拍板模态框自己用左右键切换卡片；任务看板在它下面，不参与。
      if (document.querySelector('.question-modal')) return;
      if (visibleIds.length === 0) return;
      event.preventDefault();
      setSelectedTaskId((current) =>
        stepTaskId(visibleIds, current, event.key === 'ArrowRight' ? 'next' : 'prev'),
      );
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [channelKey, visibleIds]);

  // 键盘翻阅后把高亮行滚进可视区；block:'nearest' 在已经可见时不会额外跳动。
  useEffect(() => {
    if (!selectedTaskId) return;
    const row = document.querySelector<HTMLElement>(
      `[data-task-id="${CSS.escape(selectedTaskId)}"]`,
    );
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedTaskId]);

  const stepSelection = (direction: 'prev' | 'next'): void => {
    setSelectedTaskId((current) => stepTaskId(visibleIds, current, direction));
  };

  /**
   * 详情信息流上报的未读数。
   *
   * 用“值相同就返回原对象”的写法，避免 TaskFeed 每次加载/滚动都触发任务树整棵重渲染。
   */
  const handleUnreadChange = useCallback((taskId: string, unreadCount: number): void => {
    setUnreadOverrides((prev) =>
      prev[taskId] === unreadCount ? prev : { ...prev, [taskId]: unreadCount },
    );
  }, []);

  /**
   * 打开任务详情；若这条任务带“未确认的结束通知”，顺手确认掉。
   *
   * 用户点任务行的主要意图是“看看这条结束了没/结果是什么”，
   * 因此点击本身就是确认动作，不再额外要求点一个小叉。
   */
  const openTask = (taskId: string): void => {
    setSelectedTaskId(taskId);
    const task = flatTasks.find((item) => item.id === taskId);
    if (!task?.end_notice_pending || endNoticeAcked[taskId]) return;
    setEndNoticeAcked((prev) => ({ ...prev, [taskId]: true }));
    void ackEndNotice(taskId)
      .then(() => tree.reload())
      .catch((cause) => {
        // 失败就撤掉乐观覆盖并重拉：提醒必须回来，不能让它悄悄消失。
        setEndNoticeAcked((prev) => {
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
        notify('error', `结束通知确认失败：${describeError(cause)}`);
        tree.reload();
      });
  };

  const changeHarnessId = (value: string): void => {
    setHarnessId(value);
    window.sessionStorage.setItem(HARNESS_STORAGE_KEY, value);
  };

  const claim = async (task: TreeNode): Promise<void> => {
    const harness = harnessId.trim();
    if (!harness) {
      notify('warn', '请先在工具栏填写 harness_id；任务不会被自动派发。');
      return;
    }
    setBusyId(task.id);
    try {
      const result = await claimTask(task.id, harness);
      setTokens((prev) => ({ ...prev, [task.id]: result.claim_token }));
      notify(
        'success',
        result.renewed
          ? `已续租并取回令牌：${task.title}`
          : `已认领：${task.title}`,
      );
      tree.reload();
      setDetailNonce((value) => value + 1);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'ALREADY_CLAIMED') {
        notify('warn', '该任务已被其他 harness 认领，请刷新后换一个任务。');
        tree.reload();
      } else {
        notify('error', `认领失败：${describeError(cause)}`);
      }
    } finally {
      setBusyId(null);
    }
  };

  const release = async (task: TreeNode, token: string): Promise<void> => {
    if (!token) {
      notify('warn', '当前会话没有该任务的 claim_token，无法释放。');
      return;
    }
    const reason = window.prompt('释放原因（可留空）', 'web release');
    if (reason === null) return;
    setBusyId(task.id);
    try {
      await releaseTask(task.id, token, reason.trim() || undefined);
      setTokens((prev) => {
        const next = { ...prev };
        delete next[task.id];
        return next;
      });
      notify('success', `已释放：${task.title}`);
      tree.reload();
      setDetailNonce((value) => value + 1);
    } catch (cause) {
      notify('error', `释放失败：${describeError(cause)}`);
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 任务行上的“+”只做一件事：在当前节点下建一条草稿子任务。
   *
   * 默认 submit=false，任务停在 draft：用户只是随手记一句“这里还要做 X”，
   * 不应该立刻变成可认领的 pending 把别人引过来；要派发再在详情里“提交待认领”。
   */
  const createChild = async (parent: TreeNode, title: string): Promise<boolean> => {
    setBusyId(parent.id);
    try {
      await createTask({
        channel_key: channelKey,
        title,
        parent_id: parent.id,
        submit: false,
      });
      notify('success', `已添加草稿子任务：${title}`);
      tree.reload();
      return true;
    } catch (cause) {
      notify('error', `新增子任务失败：${describeError(cause)}`);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 拖拽移动任务：挂到目标任务下，或拖到根节点投放区。
   *
   * 服务端是最终校验方（环、跨通道、深度）；前端只负责给出即时反馈。
   * 成功后重拉整棵树而不是本地挪节点：父子路径、深度、排序都变了，
   * 本地拼接容易和下一次轮询结果打架。
   */
  const moveTo = async (taskId: string, newParentId: string | null): Promise<boolean> => {
    setBusyId(taskId);
    try {
      await moveTask(taskId, newParentId);
      const target = newParentId ? flatTasks.find((item) => item.id === newParentId) : null;
      notify(
        'success',
        target ? `已移动为「${target.title}」的子任务` : '已移动到根节点',
      );
      tree.reload();
      setDetailNonce((value) => value + 1);
      return true;
    } catch (cause) {
      notify('error', `移动失败：${describeError(cause)}`);
      // 失败后也重拉：本地树可能已经过期（目标任务刚被别人移走/删除）。
      tree.reload();
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const refreshAll = (): void => {
    tree.reload();
    questions.reload();
    harnesses.reload();
  };

  return (
    <section className={compact ? 'panel task-board compact' : 'panel task-board'} aria-label="任务树">
      <header className="panel-header task-board-header">
        <div className="task-board-heading">
          <div className="task-board-titleline">
            <h2>{compact ? '本次通道任务' : '任务树'}</h2>
            <div className="task-stats" aria-label="任务统计">
              <span className="task-stat">总节点 <strong>{stats.total}</strong></span>
              <span className="task-stat task-stat-active">
                进行中 <strong>{stats.active}</strong>
              </span>
              <span className="task-stat" title="还没人接的任务；已暂缓的也在这里，但会带“已暂缓”标">
                待认领 <strong>{stats.pending}</strong>
              </span>
              <span className="task-stat" title="还没提交、不可认领的草稿">
                草稿 <strong>{stats.draft}</strong>
              </span>
              <span className="task-stat" title="已明确决定先不做、并写了原因的任务">
                已暂缓 <strong>{stats.deferred}</strong>
              </span>
              <span className="task-stat task-stat-blocked">阻塞 <strong>{stats.blocked}</strong></span>
              <span
                className={stats.riskOpen > 0 ? 'task-stat task-stat-risk' : 'task-stat'}
                title="带着未解除隐患收口的任务；已解除的不计入，但可在复盘筛选里查到"
              >
                带隐患 <strong>{stats.riskOpen}</strong>
              </span>
              <span className="task-stat task-stat-done">完成 <strong>{stats.done}</strong></span>
              <span className="task-stat">取消 <strong>{stats.cancelled}</strong></span>
            </div>
          </div>
          {/*
            进度条回答一个统计数字回答不了的问题：这条通道离收口还有多远。
            分段而不是单一完成度：进行中的量也在动，用户能看出“活有人在干”
            还是“全堆在待认领”。分母去掉取消（取消是决定不做，不是落后）。
          */}
          <div
            className="task-progress"
            role="progressbar"
            aria-label="任务完成进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={donePct}
            title={`完成 ${stats.done} / 有效 ${progressBase}（不含取消 ${stats.cancelled}）；进行中 ${stats.active}，待认领 ${stats.pending}，草稿 ${stats.draft}`}
          >
            <div className="task-progress-track" aria-hidden="true">
              <span className="task-progress-done" style={{ width: `${donePct}%` }} />
              <span className="task-progress-active" style={{ width: `${Math.min(activePct, 100 - donePct)}%` }} />
            </div>
            <span className="task-progress-text">
              完成 <strong>{donePct}%</strong>
              <span className="muted">
                {' '}· 进行中 {stats.active} · 未开始 {stats.pending + stats.draft}
                {stats.cancelled > 0 ? ` · 已取消 ${stats.cancelled}` : ''}
              </span>
            </span>
          </div>
        </div>
        <div className="inline">
          <button
            type="button"
            className={hideClosed ? 'btn btn-small' : 'btn btn-small btn-ghost'}
            aria-pressed={hideClosed}
            title={
              hideClosed
                ? '当前只显示未结束或带结束通知的任务；点一下显示全部'
                : '当前显示全部任务；点一下只看待处理'
            }
            onClick={() => setHideClosed((value) => !value)}
          >
            {hideClosed ? `全部（含已结束 ${stats.done + stats.cancelled}）` : '只看待处理'}
          </button>
          <button type="button" className="btn btn-small" onClick={() => setCreating((value) => !value)}>
            {creating ? '收起新建' : '新建任务'}
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={refreshAll}>
            刷新
          </button>
        </div>
      </header>

      {!channelKey ? (
        <EmptyState
          title="先选择一个通道"
          hint="任务必须挂在通道下；点右上角「通道」展开通道树后选择。"
        />
      ) : (
        <>
          <div className="task-toolbar">
            <label className="field task-search-field">
              <span>搜索任务</span>
              <input
                type="search"
                value={keyword}
                placeholder="标题 / 分类 / ID / 负责人 / 标签"
                aria-label="按关键字搜索任务"
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  // Esc 清空而不是退出搜索：用户常见的动作是“搜错了重来”。
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setKeyword('');
                  }
                }}
              />
            </label>

            <label className="field">
              <span>harness_id（认领用）</span>
              <input
                value={harnessId}
                list="task-harness-options"
                placeholder="例如 win-dev-01"
                onChange={(event) => changeHarnessId(event.target.value)}
              />
              <datalist id="task-harness-options">
                {(harnesses.data ?? []).map((harness) => (
                  <option key={harness.harness_id} value={harness.harness_id}>
                    {harness.name}
                  </option>
                ))}
              </datalist>
            </label>

            <label className="field">
              <span>负责人筛选</span>
              <input
                value={assignee}
                placeholder="模糊匹配"
                onChange={(event) => setAssignee(event.target.value)}
              />
            </label>

            <div className="filter-block grow">
              <span className="filter-label">状态</span>
              <div className="chip-group" role="group">
                {ALL_STATUSES.map((status) => {
                  const active = statuses.includes(status);
                  return (
                    <button
                      key={status}
                      type="button"
                      className={active ? 'chip active' : 'chip'}
                      aria-pressed={active}
                      onClick={() =>
                        setStatuses((prev) =>
                          prev.includes(status)
                            ? prev.filter((item) => item !== status)
                            : [...prev, status],
                        )
                      }
                    >
                      {TASK_STATUS_LABELS[status]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {harnesses.error ? (
            <p className="warn-text">
              harness 名单加载失败（仍可手填 harness_id）：{harnesses.error}
            </p>
          ) : null}

          {creating ? (
            <TaskCreateForm
              channelKey={channelKey}
              parents={flatTasks}
              onCreated={(task: TaskView) => {
                setCreating(false);
                setSelectedTaskId(task.id);
                setDetailNonce((value) => value + 1);
                tree.reload();
              }}
              onCancel={() => setCreating(false)}
            />
          ) : null}

          {/*
            详情打开时给列表让出右侧宽度：详情卡是 fixed 到视口的，
            它已经不在这一行的文档流里，仅靠 grid 分列不会自动留白。
          */}
          <p className="muted small task-detail-hint">
            点任务行打开页面级右侧详情卡；按 <kbd>←</kbd> / <kbd>→</kbd>{' '}
            按当前树顺序翻阅上一条/下一条。认领需要先填 harness_id。
          </p>

          <div className={selectedTaskId ? 'task-board-grid detail-open' : 'task-board-grid'}>
            <div className="task-tree-wrap">
              {tree.loading && !tree.data ? <Loading label="加载任务树…" /> : null}
              {tree.error ? <ErrorBox message={tree.error} onRetry={tree.reload} /> : null}

              {!tree.loading && !tree.error && flatTasks.length === 0 ? (
                <EmptyState
                  title="该通道还没有任务"
                  hint="点“新建任务”创建第一个；任务默认是草稿或直接提交为待认领。"
                />
              ) : (
                <TaskTree
                  nodes={visibleTree}
                  tokens={tokens}
                  busyId={busyId}
                  harnessId={harnessId.trim()}
                  activeTaskId={selectedTaskId}
                  questionsByTask={questionsByTask}
                  onOpen={openTask}
                  onOpenCard={openCard}
                  onClaim={(task) => void claim(task)}
                  onRelease={(task, token) => void release(task, token)}
                  onAddChild={createChild}
                  onMove={moveTo}
                />
              )}
            </div>

            {selectedTaskId ? (
              <TaskDetail
                key={selectedTaskId}
                taskId={selectedTaskId}
                tasks={flatTasks}
                claimToken={tokens[selectedTaskId] ?? null}
                reloadNonce={detailNonce}
                onChanged={tree.reload}
                onOpenTask={setSelectedTaskId}
                onPrev={() => stepSelection('prev')}
                onNext={() => stepSelection('next')}
                position={selectedIndex >= 0 ? selectedIndex + 1 : undefined}
                total={visibleIds.length}
                onClose={() => setSelectedTaskId(null)}
                onUnreadChange={handleUnreadChange}
              />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * 用详情信息流算出的未读数覆盖节点上的服务端值。
 *
 * 只覆盖显式出现过的任务 id；没有覆盖的节点继续用 tree 接口返回的值。
 * 递归时保持不可变：返回新节点/新 children，不原地改 useAsync 缓存的数据。
 */
function applyUnreadOverrides(
  nodes: TreeNode[],
  overrides: Record<string, number>,
): TreeNode[] {
  return nodes.map((node) => {
    const overridden = overrides[node.id];
    const next =
      overridden === undefined ? node : { ...node, unread_count: overridden };
    return next.children.length > 0
      ? { ...next, children: applyUnreadOverrides(next.children, overrides) }
      : next;
  });
}

/** 把本地已确认的结束通知标成已读；不改服务端返回的原始树。 */
function applyEndNoticeOverrides(
  nodes: TreeNode[],
  acked: Record<string, true>,
): TreeNode[] {
  return nodes.map((node) => {
    const next = acked[node.id] ? { ...node, end_notice_pending: false } : node;
    return next.children.length > 0
      ? { ...next, children: applyEndNoticeOverrides(next.children, acked) }
      : next;
  });
}

function flattenTree(nodes: TreeNode[]): TaskView[] {
  const result: TaskView[] = [];
  const walk = (items: TreeNode[]): void => {
    for (const node of items) {
      result.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return result;
}

/**
 * 保留“命中节点及其祖先/后代”，避免筛选把树拆得看不出层级。
 *
 * 三个条件取交集：状态、负责人、搜索关键字。任一条件为空表示不限制。
 * 关键字命中父节点时保留整棵子树——用户搜的是“这条线”，
 * 而不是只要一条光秃秃的父节点；命中子节点时保留路径祖先，层级才不会断。
 */
function filterTree(
  nodes: TreeNode[],
  statuses: Set<TaskStatus>,
  assignee: string,
  keyword: string,
): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    const matches =
      (statuses.size === 0 || statuses.has(node.status)) &&
      (!assignee || (node.assignee ?? '').toLowerCase().includes(assignee)) &&
      matchesTaskKeyword(node, keyword);
    // 命中节点保留整棵子树；未命中但有命中后代的节点作为“路径祖先”保留。
    const children = matches
      ? node.children
      : filterTree(node.children, statuses, assignee, keyword);
    if (matches || children.length > 0) {
      result.push({ ...node, children });
    }
  }
  return result;
}

/**
 * 默认筛选：只保留“未结束”或“带未确认结束通知”的节点。
 *
 * 不能简单地把 done 节点连子树整段删掉：常见情况是“父任务已完成，验收时又拆出一条
 * 待办子任务”，整段删会把仍然活跃的子任务一起藏没。这里把已结束节点的子代提升一级，
 * 让活着的后代继续出现在树上；层级缩进会少一层，但仍能顺着标题找到源头。
 *
 * keepStatuses 是用户显式勾选的状态 chip：勾了“完成”就保持完成节点可见，
 * 否则默认筛选会让状态筛选看起来失效（勾完一条都没有）。
 */
function withoutClosed(nodes: TreeNode[], keepStatuses: Set<TaskStatus>): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    const children = withoutClosed(node.children, keepStatuses);
    const isClosed = node.status === 'done' || node.status === 'cancelled';
    // 带未确认结束通知的节点即使已完成也保留：用户正是要看到“它结束了”。
    // 先确认再隐藏，提醒不会被默认筛选吞掉。
    if (isClosed && !node.end_notice_pending && !keepStatuses.has(node.status)) {
      result.push(...children);
      continue;
    }
    result.push({ ...node, children });
  }
  return result;
}
