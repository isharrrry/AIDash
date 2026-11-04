import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { ChannelMeta, ChannelView, ItemStage, Priority, TaskView } from '../types';
import { ApiError, describeError } from '../api/client';
import {
  generateChannelSuggestion,
  listAllReports,
  listAllTasks,
  updateChannelAlias,
  updateChannelMeta,
} from '../api/endpoints';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import { usePolling } from '../hooks/usePolling';
import { pickGroupAlias } from '../lib/channel-group';
import { DEFAULT_POLL_MS } from '../lib/polling';
import {
  OPEN_STAGE_FILTER,
  PERIOD_OPTIONS,
  buildPeriodWindows,
  itemMeta,
  matchesStageFilter,
  parentKey,
  resolveOwner,
  resolveParticipants,
  resolvePriority,
  resolveStage,
  resolveTags,
  taskStats,
} from '../lib/item-period';
import type { MatrixPeriod } from '../lib/item-period';
import { ErrorBox, Loading } from '../components/Feedback';
import { ItemPeriodDetail } from '../components/ItemPeriodDetail';
import { ItemsMatrix, DEFAULT_LEFT_WIDTH, MIN_LEFT_WIDTH } from '../components/ItemsMatrix';
import type {
  ItemGroup,
  ItemRow,
  ItemSortKey,
  SelectedCell,
  SuggestionInfo,
} from '../components/ItemsMatrix';
import { ItemsToolbar } from '../components/ItemsToolbar';
import type { ItemCellMode, ItemFilterState } from '../components/ItemsToolbar';
import { useToast } from '../components/Toast';

const LEFT_WIDTH_STORAGE_KEY = 'aidash.items.left_width';
const BASE_PERIOD_COUNT = 6;
const LOAD_PERIOD_STEP = 4;

/** 默认只看未关闭事项；切到“全部”才会带出已关闭的历史事项。 */
const EMPTY_FILTERS: ItemFilterState = {
  keyword: '',
  project: '',
  stage: OPEN_STAGE_FILTER,
  priority: '',
  owner: '',
};

interface SortState {
  key: ItemSortKey;
  direction: 'asc' | 'desc';
}

/**
 * SCR 事项页：任务树的“按事项 × 周期”视图。
 *
 * 和任务树的分工：
 *  - 任务树回答“这条通道里的活做到哪了”，按父子层级展开；
 *  - 事项页回答“每件事在这些周/月里发生了什么”，行是子通道，列是周期。
 * 两者共用同一批任务事实，不复制数据；区别只在聚合维度。
 */
export function ItemsPage(): ReactElement {
  const { channels, channelsLoading, reloadChannels, refreshNonce } = useApp();
  const notify = useToast().notify;

  const [period, setPeriod] = useState<MatrixPeriod>('week');
  const [windowCount, setWindowCount] = useState(BASE_PERIOD_COUNT);
  const [mode, setMode] = useState<ItemCellMode>('summary');
  const [filters, setFilters] = useState<ItemFilterState>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortState>({ key: 'name', direction: 'asc' });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<SelectedCell | null>(null);
  const [scrollRightToken, setScrollRightToken] = useState(0);
  const [leftWidth, setLeftWidth] = useState(() => readLeftWidth());
  const [metaOverrides, setMetaOverrides] = useState<Record<string, Partial<ChannelMeta>>>({});
  const [aliasOverrides, setAliasOverrides] = useState<Record<string, string | null>>({});
  const [suggestionBusy, setSuggestionBusy] = useState<Set<string>>(() => new Set());
  const [suggestionInfo, setSuggestionInfo] = useState<Record<string, SuggestionInfo>>({});

  const tasksState = useAsync(() => listAllTasks(), [refreshNonce]);
  const reportsState = useAsync(() => listAllReports(), [refreshNonce]);

  const refresh = useCallback((): void => {
    void tasksState.reload();
    void reportsState.reload();
    void reloadChannels();
  }, [tasksState.reload, reportsState.reload, reloadChannels]);

  // 事项页按“任务 × 周期”聚合，任务/汇报变化要跟着刷新；通道树由 App 统一轮询。
  usePolling(async () => {
    await Promise.all([tasksState.reload(), reportsState.reload()]);
  }, DEFAULT_POLL_MS);

  const tasks = tasksState.data?.items ?? [];
  const reports = reportsState.data?.items ?? [];

  const tasksByChannel = useMemo(() => {
    const map = new Map<string, TaskView[]>();
    for (const task of tasks) {
      const list = map.get(task.channel_key) ?? [];
      list.push(task);
      map.set(task.channel_key, list);
    }
    return map;
  }, [tasks]);

  const effectiveMeta = useCallback(
    (channel: ChannelView): ChannelMeta => {
      const base = itemMeta(channel);
      const patch = metaOverrides[channel.id];
      return patch ? { ...base, ...patch } : base;
    },
    [metaOverrides],
  );

  const effectiveAlias = useCallback(
    (channel: ChannelView): string | null =>
      Object.prototype.hasOwnProperty.call(aliasOverrides, channel.id)
        ? (aliasOverrides[channel.id] ?? null)
        : channel.alias,
    [aliasOverrides],
  );

  const rows = useMemo<ItemRow[]>(() => {
    return channels.map((channel) => {
      const channelTasks = tasksByChannel.get(channel.channel_key) ?? [];
      const meta = effectiveMeta(channel);
      const alias = effectiveAlias(channel);
      const name =
        alias?.trim() ||
        channel.topic?.trim() ||
        channel.title?.trim() ||
        channel.name?.trim() ||
        channel.channel_key;
      return {
        channel,
        tasks: channelTasks,
        stats: taskStats(channelTasks),
        name,
        meta,
        owner: resolveOwner(meta, channelTasks),
        priority: resolvePriority(meta, channelTasks),
        stage: resolveStage(meta, channel, channelTasks),
        participants: resolveParticipants(meta, channelTasks),
        tags: resolveTags(meta, channelTasks),
      };
    });
  }, [channels, tasksByChannel, effectiveMeta, effectiveAlias]);

  const projectOptions = useMemo(() => {
    const values = new Set(rows.map((row) => parentKey(row.channel)));
    return Array.from(values).sort((left, right) =>
      left.localeCompare(right, 'zh-Hans-CN'),
    );
  }, [rows]);

  const ownerOptions = useMemo(() => {
    const values = new Set<string>();
    for (const row of rows) {
      if (row.owner.value) values.add(row.owner.value);
    }
    return Array.from(values).sort((left, right) =>
      left.localeCompare(right, 'zh-Hans-CN'),
    );
  }, [rows]);

  const visibleRows = useMemo(() => {
    const keyword = filters.keyword.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (filters.project && parentKey(row.channel) !== filters.project) return false;
      if (!matchesStageFilter(row.stage.value, filters.stage)) return false;
      if (filters.priority && row.priority.value !== filters.priority) return false;
      if (filters.owner && row.owner.value !== filters.owner) return false;
      if (!keyword) return true;
      return searchText(row).includes(keyword);
    });
    return [...filtered].sort((left, right) => compareRows(left, right, sort));
  }, [rows, filters, sort]);

  const groups = useMemo<ItemGroup[]>(() => {
    const map = new Map<string, ItemRow[]>();
    for (const row of visibleRows) {
      const project = parentKey(row.channel);
      const list = map.get(project) ?? [];
      list.push(row);
      map.set(project, list);
    }
    return Array.from(map.entries())
      .map(([project, items]) => ({
        project,
        alias: pickGroupAlias(items.map((item) => item.channel)),
        items,
      }))
      .sort((left, right) => {
        if (left.project === '未分组') return 1;
        if (right.project === '未分组') return -1;
        return left.project.localeCompare(right.project, 'zh-Hans-CN');
      });
  }, [visibleRows]);

  const periods = useMemo(
    () => buildPeriodWindows(period, windowCount),
    [period, windowCount],
  );

  const selectedChannel = selected
    ? channels.find((channel) => channel.channel_key === selected.channelKey) ?? null
    : null;
  const selectedRange = selected
    ? periods.find((range) => range.key === selected.periodKey) ?? null
    : null;

  const changeFilters = (patch: Partial<ItemFilterState>): void => {
    setFilters((prev) => ({ ...prev, ...patch }));
  };

  const changePeriod = (next: MatrixPeriod): void => {
    setPeriod(next);
    setWindowCount(BASE_PERIOD_COUNT);
    setSelected(null);
    setScrollRightToken(0);
  };

  const loadOlder = (): void => {
    setWindowCount((count) => count + LOAD_PERIOD_STEP);
    setScrollRightToken((token) => token + 1);
  };

  const toggleGroup = (project: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  };

  const changeSort = (key: ItemSortKey): void => {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  };

  const saveMeta = async (
    channel: ChannelView,
    patch: Partial<ChannelMeta>,
  ): Promise<void> => {
    const previous = metaOverrides[channel.id];
    setMetaOverrides((prev) => ({
      ...prev,
      [channel.id]: { ...(prev[channel.id] ?? {}), ...patch },
    }));
    try {
      const updated = await updateChannelMeta(channel.id, patch);
      setMetaOverrides((prev) => ({ ...prev, [channel.id]: updated.meta }));
    } catch (cause) {
      setMetaOverrides((prev) => {
        const next = { ...prev };
        if (previous === undefined) delete next[channel.id];
        else next[channel.id] = previous;
        return next;
      });
      notify('error', `保存事项属性失败：${describeError(cause)}`);
    }
  };

  const saveAlias = async (channel: ChannelView, alias: string | null): Promise<void> => {
    const previous = Object.prototype.hasOwnProperty.call(aliasOverrides, channel.id)
      ? aliasOverrides[channel.id] ?? null
      : channel.alias;
    setAliasOverrides((prev) => ({ ...prev, [channel.id]: alias }));
    try {
      const updated = await updateChannelAlias(channel.id, alias);
      setAliasOverrides((prev) => ({ ...prev, [channel.id]: updated.alias }));
    } catch (cause) {
      setAliasOverrides((prev) => ({ ...prev, [channel.id]: previous }));
      notify('error', `保存事项别名失败：${describeError(cause)}`);
    }
  };

  /**
   * 生成事项 AI 建议。
   *
   * 一次生成可能包含多轮 grep 与 LLM 调用，按钮期间必须锁住：
   * 用户连点会在服务端并发跑两套检索，且后到的结果可能覆盖先到的建议。
   */
  const generateSuggestion = async (channel: ChannelView): Promise<void> => {
    if (suggestionBusy.has(channel.id)) return;
    setSuggestionBusy((prev) => new Set(prev).add(channel.id));
    try {
      const result = await generateChannelSuggestion(channel.id);
      setMetaOverrides((prev) => ({
        ...prev,
        [channel.id]: { ...(prev[channel.id] ?? {}), ...result.channel.meta },
      }));
      setSuggestionInfo((prev) => ({
        ...prev,
        [channel.id]: {
          generated_at: result.generated_at,
          greps: result.greps,
          evidence_count: result.evidence_count,
        },
      }));
      notify(
        'success',
        `已生成 AI 建议（检索 ${result.greps} 次，命中 ${result.evidence_count} 条证据）`,
      );
    } catch (cause) {
      const message =
        cause instanceof ApiError && cause.message === 'LLM_NOT_CONFIGURED'
          ? 'LLM 未配置，请到「设置」页填写模型地址与密钥后再试'
          : describeError(cause);
      notify('error', `生成 AI 建议失败：${message}`);
    } finally {
      setSuggestionBusy((prev) => {
        const next = new Set(prev);
        next.delete(channel.id);
        return next;
      });
    }
  };

  const updateLeftWidth = useCallback((width: number): void => {
    const max = Math.max(MIN_LEFT_WIDTH, window.innerWidth - 280);
    const clamped = Math.min(max, Math.max(MIN_LEFT_WIDTH, Math.round(width)));
    setLeftWidth(clamped);
    window.localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, String(clamped));
  }, []);

  const detailChannel = selectedChannel
    ? { ...selectedChannel, alias: effectiveAlias(selectedChannel) }
    : null;

  return (
    <div className="page items-page">
      <header className="page-header">
        <div>
          <h1>事项</h1>
          <p className="muted">
            任务树的另一种视图：每行是一条子通道（事项），左栏维护事项属性，
            右侧按{PERIOD_OPTIONS.find((option) => option.value === period)?.label ?? '周期'}
            回看每个周期的任务记录与汇报。点格子打开右侧详情。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-small"
          onClick={refresh}
          disabled={tasksState.loading || reportsState.loading}
        >
          {tasksState.loading ? '刷新中…' : '刷新'}
        </button>
      </header>

      <ItemsToolbar
        period={period}
        onPeriodChange={changePeriod}
        mode={mode}
        onModeChange={setMode}
        filters={filters}
        onFiltersChange={changeFilters}
        projects={projectOptions}
        owners={ownerOptions}
        periodsLoaded={periods.length}
        loading={tasksState.loading || reportsState.loading}
        itemCount={visibleRows.length}
        taskCount={tasks.length}
        onLoadOlder={loadOlder}
        onRefresh={refresh}
      />

      {tasksState.error ? (
        <ErrorBox message={`任务加载失败：${tasksState.error}`} onRetry={() => void tasksState.reload()} />
      ) : null}
      {reportsState.error ? (
        <p className="warn-text">汇报加载失败（格子仍显示任务摘要）：{reportsState.error}</p>
      ) : null}
      {tasksState.data?.truncated ? (
        <p className="warn-text">
          任务共 {tasksState.data.total} 条，本次只加载了前 {tasksState.data.items.length} 条；
          时间轴可能缺少更早任务，请刷新或调大服务端分页上限。
        </p>
      ) : null}

      {channelsLoading && channels.length === 0 ? (
        <Loading label="加载通道…" />
      ) : tasksState.loading && !tasksState.data ? (
        <Loading label="加载任务与汇报…" />
      ) : (
        <ItemsMatrix
          groups={groups}
          periods={periods}
          period={period}
          mode={mode}
          sortKey={sort.key}
          sortDirection={sort.direction}
          onSort={changeSort}
          collapsedGroups={collapsedGroups}
          onToggleGroup={toggleGroup}
          selected={selected}
          onSelect={setSelected}
          leftWidth={leftWidth}
          onLeftWidthChange={updateLeftWidth}
          onLoadOlder={loadOlder}
          scrollRightToken={scrollRightToken}
          onSaveMeta={(channel, patch) => void saveMeta(channel, patch)}
          onSaveAlias={(channel, alias) => void saveAlias(channel, alias)}
          onGenerateSuggestion={(channel) => void generateSuggestion(channel)}
          suggestionBusy={suggestionBusy}
          suggestionInfo={suggestionInfo}
        />
      )}

      {detailChannel && selectedRange ? (
        <ItemPeriodDetail
          channel={detailChannel}
          range={selectedRange}
          tasks={tasksByChannel.get(detailChannel.channel_key) ?? []}
          reports={reports}
          onClose={() => setSelected(null)}
          onRefresh={refresh}
        />
      ) : null}
    </div>
  );
}

function readLeftWidth(): number {
  const raw = window.localStorage.getItem(LEFT_WIDTH_STORAGE_KEY);
  const value = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_LEFT_WIDTH;
  // 历史版本可能把视口外的巨大值写进 localStorage（如 1000000）；
  // 只做最小值保护会让右栏宽度变成 0，所以这里必须同时按视口封顶。
  const max = Math.max(MIN_LEFT_WIDTH, window.innerWidth - 280);
  return Math.min(max, Math.max(MIN_LEFT_WIDTH, Math.round(value)));
}

function searchText(row: ItemRow): string {
  return [
    row.name,
    row.channel.channel_key,
    row.channel.project,
    row.channel.topic,
    row.channel.title,
    row.owner.value,
    row.priority.value,
    row.stage.value,
    row.meta.group,
    row.meta.iteration,
    row.meta.product,
    row.meta.category,
    row.meta.remark,
    row.meta.ai_suggestion,
    row.tags.value.join(' '),
    row.participants.value.join(' '),
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(' ')
    .toLowerCase();
}

function compareRows(left: ItemRow, right: ItemRow, sort: SortState): number {
  const direction = sort.direction === 'asc' ? 1 : -1;
  switch (sort.key) {
    case 'priority': {
      const leftValue = left.priority.value;
      const rightValue = right.priority.value;
      if (!leftValue && !rightValue) return compareText(left.name, right.name);
      if (!leftValue) return 1;
      if (!rightValue) return -1;
      return direction * (PRIORITY_RANK[leftValue] - PRIORITY_RANK[rightValue]);
    }
    case 'stage': {
      const leftValue = left.stage.value;
      const rightValue = right.stage.value;
      if (!leftValue && !rightValue) return compareText(left.name, right.name);
      if (!leftValue) return 1;
      if (!rightValue) return -1;
      return direction * (STAGE_RANK[leftValue] - STAGE_RANK[rightValue]);
    }
    case 'progress':
      return direction * (left.stats.progress - right.stats.progress);
    case 'owner':
      return compareOptionalText(left.owner.value, right.owner.value, direction, left.name, right.name);
    case 'group':
      return compareOptionalText(left.meta.group, right.meta.group, direction, left.name, right.name);
    case 'tags':
      return compareOptionalText(
        left.tags.value.join('、'),
        right.tags.value.join('、'),
        direction,
        left.name,
        right.name,
      );
    case 'participants':
      return compareOptionalText(
        left.participants.value.join('、'),
        right.participants.value.join('、'),
        direction,
        left.name,
        right.name,
      );
    case 'iteration':
      return compareOptionalText(
        left.meta.iteration,
        right.meta.iteration,
        direction,
        left.name,
        right.name,
      );
    case 'remark':
      return compareOptionalText(left.meta.remark, right.meta.remark, direction, left.name, right.name);
    case 'suggestion':
      return compareOptionalText(
        left.meta.ai_suggestion,
        right.meta.ai_suggestion,
        direction,
        left.name,
        right.name,
      );
    case 'name':
    default:
      return direction * compareText(left.name, right.name);
  }
}

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const STAGE_RANK: Record<ItemStage, number> = {
  planned: 0,
  in_progress: 1,
  waiting: 2,
  done: 3,
  closed: 4,
};

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'zh-Hans-CN');
}

/** 空值永远排最后，不随排序方向翻转；空值之间用名称保持稳定顺序。 */
function compareOptionalText(
  left: string | null,
  right: string | null,
  direction: number,
  leftName: string,
  rightName: string,
): number {
  const leftValue = left?.trim() ?? '';
  const rightValue = right?.trim() ?? '';
  if (!leftValue && !rightValue) return compareText(leftName, rightName);
  if (!leftValue) return 1;
  if (!rightValue) return -1;
  return direction * compareText(leftValue, rightValue);
}
