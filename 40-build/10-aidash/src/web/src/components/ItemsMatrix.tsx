import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ChannelMeta, ChannelView, ItemStage, Priority, TaskView } from '../types';
import { formatStamp } from '../lib/format';
import { PriorityBadge, TaskStatusBadge } from './Badge';
import {
  STAGE_LABELS,
  STAGE_OPTIONS,
  eventTone,
  parseListInput,
  summarizePeriod,
  tasksInPeriod,
} from '../lib/item-period';
import type {
  ItemTaskStats,
  MatrixPeriod,
  PeriodRange,
  ResolvedField,
} from '../lib/item-period';
import type { ItemCellMode } from './ItemsToolbar';

/** 左侧属性列的定义；宽度的和会按用户拖拽比例缩放。 */
export const ITEM_COLUMNS: Array<{
  key: ItemSortKey;
  label: string;
  width: number;
  title: string;
}> = [
  { key: 'name', label: '事项', width: 190, title: '子通道别名；点击可改别名，清空后回退到 topic/key' },
  { key: 'owner', label: '负责人', width: 86, title: '人工维护的负责人；未填写时按任务负责人推导' },
  { key: 'priority', label: '优先级', width: 70, title: '人工标注的优先级；未填写时按未结束任务的最高优先级推导' },
  { key: 'stage', label: '阶段', width: 82, title: '人工标注的阶段；未填写时按任务状态推导' },
  { key: 'group', label: '分组', width: 82, title: '同一父通道下的小组' },
  { key: 'tags', label: '标签', width: 108, title: '人工标签；未填写时取任务标签' },
  { key: 'participants', label: '参与人', width: 108, title: '参与人；未填写时取任务负责人' },
  { key: 'iteration', label: '迭代', width: 82, title: '迭代/版本' },
  { key: 'progress', label: '进度', width: 70, title: '已完成 /（全部 - 已取消）' },
  { key: 'remark', label: '备注', width: 160, title: '自由备注' },
  { key: 'suggestion', label: 'AI建议', width: 180, title: 'AIDash 基于事项数据与记忆检索后生成的下一步建议；默认空白' },
];

export type ItemSortKey =
  | 'name'
  | 'owner'
  | 'priority'
  | 'stage'
  | 'group'
  | 'tags'
  | 'participants'
  | 'iteration'
  | 'progress'
  | 'remark'
  | 'suggestion';

const BASE_LEFT_WIDTH = ITEM_COLUMNS.reduce((sum, column) => sum + column.width, 0);
export const MIN_LEFT_WIDTH = 720;
/**
 * 默认左栏宽度：1920 屏仍能留出约 4 个周期列。
 *
 * 加 AI 建议列后列数变多，继续用 900 会把「事项」「备注」压得读不清；
 * 左栏可拖拽，需要看更多周期时用户随时能收窄。
 */
export const DEFAULT_LEFT_WIDTH = 1040;
const PERIOD_COL_WIDTH = 196;
const LOAD_COL_WIDTH = 96;
const ROW_HEIGHT = 104;
/**
 * 行内可裁剪内容高度 = 行高 - 上下 padding 12 - 底边框 1。
 *
 * 左右是两张独立的表，表行高度取“内容最小值”。JSX 里的 height 只是最小值，
 * 只要某个单元格文字换行变高，那一行就会把整张表撑高，左右行高从此不再一一对应，
 * 纵向滚动同步了也对不齐。所以两侧内容都套在一层固定高度的容器里裁剪。
 */
const CELL_BODY_HEIGHT = ROW_HEIGHT - 13;
/** 分组行两侧必须同高，否则左右两张表在纵向滚动时会错位。 */
const GROUP_ROW_HEIGHT = 34;

export interface ItemRow {
  channel: ChannelView;
  tasks: TaskView[];
  stats: ItemTaskStats;
  name: string;
  meta: ChannelMeta;
  owner: ResolvedField<string | null>;
  priority: ResolvedField<Priority | null>;
  stage: ResolvedField<ItemStage | null>;
  participants: ResolvedField<string[]>;
  tags: ResolvedField<string[]>;
}

export interface ItemGroup {
  project: string;
  alias: string | null;
  items: ItemRow[];
}

export interface SelectedCell {
  channelKey: string;
  periodKey: string;
}

/** 生成建议的附加统计；只在本次会话里保留，用于悬停提示。 */
export interface SuggestionInfo {
  generated_at: string;
  greps: number;
  evidence_count: number;
}

export function ItemsMatrix({
  groups,
  periods,
  period,
  mode,
  sortKey,
  sortDirection,
  onSort,
  collapsedGroups,
  onToggleGroup,
  selected,
  onSelect,
  leftWidth,
  onLeftWidthChange,
  onLoadOlder,
  scrollRightToken,
  onSaveMeta,
  onSaveAlias,
  onGenerateSuggestion,
  suggestionBusy,
  suggestionInfo,
}: {
  groups: ItemGroup[];
  periods: PeriodRange[];
  period: MatrixPeriod;
  mode: ItemCellMode;
  sortKey: ItemSortKey;
  sortDirection: 'asc' | 'desc';
  onSort: (key: ItemSortKey) => void;
  collapsedGroups: Set<string>;
  onToggleGroup: (project: string) => void;
  selected: SelectedCell | null;
  onSelect: (cell: SelectedCell) => void;
  leftWidth: number;
  onLeftWidthChange: (width: number) => void;
  onLoadOlder: () => void;
  scrollRightToken: number;
  onSaveMeta: (channel: ChannelView, patch: Partial<ChannelMeta>) => void;
  onSaveAlias: (channel: ChannelView, alias: string | null) => void;
  onGenerateSuggestion: (channel: ChannelView) => void;
  suggestionBusy: ReadonlySet<string>;
  suggestionInfo: Record<string, SuggestionInfo>;
}): ReactElement {
  const rightRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const syncTargetRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hScrollbarHeight, setHScrollbarHeight] = useState(0);

  const widths = scaledWidths(leftWidth);
  const rightWidth = periods.length * PERIOD_COL_WIDTH + LOAD_COL_WIDTH;

  /**
   * 量右栏横向滚动条占掉的高度，垫给左栏底部。
   *
   * 右栏的横向滚动条在滚动视口内，左栏没有：不补偿的话，滚到最底部时
   * 左栏能比右栏多滚一个滚动条厚度，最后一行就错位。厚度随浏览器/缩放变化，
   * 不能写死 18px，这里用 offsetHeight - clientHeight 实测（无边框时正好是滚动条高度）。
   *
   * 周期列增删、左栏拖拽会改变右栏可用宽度，横向滚动条可能因此出现/消失，
   * 所以这些依赖变化时要重新观察并立即量一遍，避免一直沿用旧厚度。
   */
  useEffect(() => {
    const element = rightRef.current;
    if (!element) return undefined;
    const measure = (): void => {
      const next = Math.max(0, element.offsetHeight - element.clientHeight);
      setHScrollbarHeight((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    // 横向滚动条出现/消失会改变内容盒高度，ResizeObserver 能感知到。
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [periods.length, leftWidth]);

  /**
   * 左右两栏各自滚动，但纵向必须锁在一起。
   *
   * 用同一个滚动容器时，右侧横向滚动条会横穿左栏、吸顶表头也会盖住左侧，
   * 这正是上一版“左右互相干扰”的来源。拆成两张表后，滚动位置就用这里同步；
   * rAF 里复位标志，避免两个 scroll 事件互相触发形成死循环。
   */
  const syncScroll = (source: 'left' | 'right'): void => {
    const left = leftRef.current;
    const right = rightRef.current;
    if (!left || !right) return;
    const from = source === 'left' ? left : right;
    const to = source === 'left' ? right : left;
    // 只忽略“上一步由我们写进去的滚动事件”，不忽略用户真正的连续滚动。
    // 用一个全局 boolean 会让快速滚轮时另一栏丢事件、出现可见的错位。
    if (syncTargetRef.current === from) {
      syncTargetRef.current = null;
      return;
    }
    if (Math.abs(to.scrollTop - from.scrollTop) < 1) return;
    syncTargetRef.current = to;
    to.scrollTop = from.scrollTop;
    // 若赋值后因到达边界没有触发 scroll 事件，下一帧清掉标记，避免吞掉用户下一次滚动。
    window.requestAnimationFrame(() => {
      if (syncTargetRef.current === to) syncTargetRef.current = null;
    });
  };

  // 切换周期角度时回到最左（最新一期）；加载更早周期后滚到最右，让新列立刻可见。
  useEffect(() => {
    const el = rightRef.current;
    if (el) el.scrollTo({ left: 0 });
    // period 变化时 periods 的首个 key 也会变；这里只依赖角度，避免每次加载都跳回左边。
  }, [period]);

  useEffect(() => {
    if (scrollRightToken === 0) return;
    const el = rightRef.current;
    if (!el) return;
    // 等浏览器完成新列布局再滚，否则 scrollWidth 还是旧宽度。
    const frame = window.requestAnimationFrame(() => {
      el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollRightToken]);

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      const maxWidth = Math.max(
        MIN_LEFT_WIDTH,
        (wrapRef.current?.clientWidth ?? 1600) - 280,
      );
      const next = Math.min(
        maxWidth,
        Math.max(MIN_LEFT_WIDTH, drag.startWidth + (event.clientX - drag.startX)),
      );
      onLeftWidthChange(next);
    };
    const onUp = (): void => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, onLeftWidthChange]);

  // 窄屏保护：用户上次在宽屏拖到 1200px 后换到 1366 的笔记本，
  // 左栏会把时间轴完全挤出视口，连拖拽条都看不见。窗口变窄时自动收到可用宽度。
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;
    const clamp = (): void => {
      const max = Math.max(MIN_LEFT_WIDTH, element.clientWidth - 280);
      if (leftWidth > max) onLeftWidthChange(max);
    };
    clamp();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(clamp);
    observer.observe(element);
    return () => observer.disconnect();
  }, [leftWidth, onLeftWidthChange]);

  return (
    <div
      className={dragging ? 'items-workspace items-workspace-dragging' : 'items-workspace'}
      ref={wrapRef}
    >
      <div
        className="items-left-pane"
        ref={leftRef}
        style={{ width: leftWidth, paddingBottom: hScrollbarHeight }}
        onScroll={() => syncScroll('left')}
      >
        <table className="items-table items-left-table">
          <colgroup>
            {ITEM_COLUMNS.map((column, index) => (
              <col key={column.key} style={{ width: widths[index] }} />
            ))}
          </colgroup>

          <thead>
            <tr className="items-head-row">
              {ITEM_COLUMNS.map((column, index) => (
                <th
                  key={column.key}
                  className="items-head-cell"
                  style={{ width: widths[index] }}
                  title={`${column.title}；点击按此列排序`}
                  scope="col"
                >
                  <button
                    type="button"
                    className="items-sort-button"
                    onClick={() => onSort(column.key)}
                  >
                    <span>{column.label}</span>
                    {sortKey === column.key ? (
                      <span className="items-sort-arrow" aria-hidden="true">
                        {sortDirection === 'asc' ? '▲' : '▼'}
                      </span>
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.project);
              const taskCount = group.items.reduce((sum, item) => sum + item.stats.total, 0);
              return (
                <Fragment key={group.project}>
                  <tr className="items-group-row">
                    <td
                      className="items-group-cell"
                      colSpan={ITEM_COLUMNS.length}
                      style={{ height: GROUP_ROW_HEIGHT }}
                    >
                      <button
                        type="button"
                        className="items-group-toggle"
                        aria-expanded={!collapsed}
                        onClick={() => onToggleGroup(group.project)}
                      >
                        <span className="items-group-caret" aria-hidden="true">
                          {collapsed ? '▸' : '▾'}
                        </span>
                        <strong>{group.project}</strong>
                        {group.alias && group.alias !== group.project ? (
                          <span className="muted small">· {group.alias}</span>
                        ) : null}
                        <span className="muted small">
                          {group.items.length} 个事项 · {taskCount} 条任务
                        </span>
                      </button>
                    </td>
                  </tr>

                  {collapsed
                    ? null
                    : group.items.map((item) => (
                        <tr
                          key={item.channel.id}
                          className="items-row"
                          style={{ height: ROW_HEIGHT }}
                        >
                          {renderLeftCells(
                            item,
                            widths,
                            onSaveMeta,
                            onSaveAlias,
                            onGenerateSuggestion,
                            suggestionBusy.has(item.channel.id),
                            suggestionInfo[item.channel.id],
                          )}
                        </tr>
                      ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 拖拽条固定在左栏右缘：左右已经是独立两栏，这里只改左栏宽度。 */}
      <div
        className={dragging ? 'items-resizer active' : 'items-resizer'}
        style={{ left: leftWidth - 3 }}
        role="separator"
        aria-orientation="vertical"
        aria-label="调节左栏宽度"
        title="左右拖动调整属性栏与时间轴占比"
        onPointerDown={(event) => {
          event.preventDefault();
          dragRef.current = { startX: event.clientX, startWidth: leftWidth };
          setDragging(true);
        }}
      />

      <div
        className="items-right-pane"
        ref={rightRef}
        onScroll={() => syncScroll('right')}
      >
        <table className="items-table items-right-table" style={{ width: rightWidth }}>
          <colgroup>
            {periods.map((range) => (
              <col key={range.key} style={{ width: PERIOD_COL_WIDTH }} />
            ))}
            <col style={{ width: LOAD_COL_WIDTH }} />
          </colgroup>

          <thead>
            <tr className="items-head-row">
              {periods.map((range, index) => (
                <th
                  key={range.key}
                  className={index === 0 ? 'items-period-head current' : 'items-period-head'}
                  style={{ width: PERIOD_COL_WIDTH }}
                  title={range.title}
                  scope="col"
                >
                  <span className="items-period-title-row">
                    <span className="items-period-label">{range.shortLabel}</span>
                    {index === 0 ? <span className="items-period-now">本期</span> : null}
                  </span>
                  <span className="items-period-key">{range.key}</span>
                </th>
              ))}
              <th className="items-load-head" scope="col">
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  title="继续往前加载更早的周期列"
                  onClick={onLoadOlder}
                >
                  更早 →
                </button>
              </th>
            </tr>
          </thead>

          <tbody>
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.project);
              return (
                <Fragment key={group.project}>
                  <tr className="items-group-row">
                    <td
                      className="items-group-period"
                      colSpan={periods.length + 1}
                      style={{ height: GROUP_ROW_HEIGHT }}
                    />
                  </tr>

                  {collapsed
                    ? null
                    : group.items.map((item) => (
                        <tr
                          key={item.channel.id}
                          className="items-row"
                          style={{ height: ROW_HEIGHT }}
                        >
                          {periods.map((range) => {
                            const isSelected =
                              selected?.channelKey === item.channel.channel_key &&
                              selected.periodKey === range.key;
                            return (
                              <td
                                key={range.key}
                                className={
                                  isSelected
                                    ? 'items-period-cell selected'
                                    : 'items-period-cell'
                                }
                                onClick={() =>
                                  onSelect({
                                    channelKey: item.channel.channel_key,
                                    periodKey: range.key,
                                  })
                                }
                              >
                                <PeriodCell
                                  item={item}
                                  range={range}
                                  mode={mode}
                                  selected={isSelected}
                                />
                              </td>
                            );
                          })}
                          <td className="items-load-cell" />
                        </tr>
                      ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        {groups.length === 0 ? (
          <p className="muted items-empty">没有符合筛选条件的事项。</p>
        ) : null}
      </div>
    </div>
  );
}

function renderLeftCells(
  item: ItemRow,
  widths: number[],
  onSaveMeta: (channel: ChannelView, patch: Partial<ChannelMeta>) => void,
  onSaveAlias: (channel: ChannelView, alias: string | null) => void,
  onGenerateSuggestion: (channel: ChannelView) => void,
  suggestionBusy: boolean,
  suggestionInfo: SuggestionInfo | undefined,
): ReactElement[] {
  const cell = (index: number, content: ReactElement): ReactElement => (
    <td
      key={ITEM_COLUMNS[index]!.key}
      className="items-left-cell"
      style={{ width: widths[index] }}
    >
      {/* 固定高度裁剪：任意一侧的行被文字撑高都会破坏左右对齐。 */}
      <div className="items-cell-frame" style={{ height: CELL_BODY_HEIGHT }}>
        {content}
      </div>
    </td>
  );

  return [
    cell(
      0,
      <div className="items-name-cell">
        <EditableText
          value={item.channel.alias ?? ''}
          placeholder={item.name}
          title="点击修改别名；清空后回退到 topic / channel_key"
          onSave={(next) => onSaveAlias(item.channel, next || null)}
        />
        <span className="items-key mono" title={item.channel.channel_key}>
          {item.channel.channel_key}
        </span>
      </div>,
    ),
    cell(
      1,
      <EditableText
        value={item.owner.value ?? ''}
        placeholder="未设置"
        derived={item.owner.derived}
        title={
          item.owner.derived
            ? '当前按任务负责人自动推导；点击填写后以人工值为准'
            : '点击编辑负责人'
        }
        onSave={(next) => onSaveMeta(item.channel, { owner: next || null })}
      />,
    ),
    cell(
      2,
      <EditablePriority
        value={item.priority.value}
        derived={item.priority.derived}
        onSave={(next) => onSaveMeta(item.channel, { priority: next })}
      />,
    ),
    cell(
      3,
      <EditableStage
        value={item.stage.value}
        derived={item.stage.derived}
        onSave={(next) => onSaveMeta(item.channel, { stage: next })}
      />,
    ),
    cell(
      4,
      <EditableText
        value={item.meta.group ?? ''}
        placeholder="—"
        onSave={(next) => onSaveMeta(item.channel, { group: next || null })}
      />,
    ),
    cell(
      5,
      <EditableList
        values={item.tags.value}
        derived={item.tags.derived}
        placeholder="—"
        onSave={(next) => onSaveMeta(item.channel, { tags: next })}
      />,
    ),
    cell(
      6,
      <EditableList
        values={item.participants.value}
        derived={item.participants.derived}
        placeholder="—"
        onSave={(next) => onSaveMeta(item.channel, { participants: next })}
      />,
    ),
    cell(
      7,
      <EditableText
        value={item.meta.iteration ?? ''}
        placeholder="—"
        onSave={(next) => onSaveMeta(item.channel, { iteration: next || null })}
      />,
    ),
    cell(
      8,
      <div
        className="items-progress"
        title={`完成 ${item.stats.done} / ${item.stats.total} 条（已取消 ${item.stats.cancelled} 条不计入分母）`}
      >
        <div className="items-progress-bar">
          <span style={{ width: `${item.stats.progress}%` }} />
        </div>
        <span className="items-progress-text">{item.stats.progress}%</span>
      </div>,
    ),
    cell(
      9,
      <EditableText
        value={item.meta.remark ?? ''}
        placeholder="—"
        onSave={(next) => onSaveMeta(item.channel, { remark: next || null })}
      />,
    ),
    cell(
      10,
      <SuggestionCell
        item={item}
        busy={suggestionBusy}
        info={suggestionInfo}
        onGenerate={() => onGenerateSuggestion(item.channel)}
      />,
    ),
  ];
}

/** AI建议列：空白时只露出“生成建议”，有内容时显示正文和重新生成入口。 */
function SuggestionCell({
  item,
  busy,
  info,
  onGenerate,
}: {
  item: ItemRow;
  busy: boolean;
  info: SuggestionInfo | undefined;
  onGenerate: () => void;
}): ReactElement {
  const text = item.meta.ai_suggestion?.trim() ?? '';
  if (busy) {
    return (
      <div className="items-suggestion-cell busy">
        <span className="items-suggestion-spinner" aria-hidden="true" />
        <span className="muted">生成中…</span>
      </div>
    );
  }
  if (!text) {
    return (
      <div className="items-suggestion-cell">
        <button
          type="button"
          className="items-suggestion-generate"
          onClick={onGenerate}
          title="AIDash 会先按事项数据检索任务、卡片、汇报与项目记忆，再生成一条建议"
        >
          生成建议
        </button>
      </div>
    );
  }

  const meta: string[] = [];
  if (item.meta.ai_suggestion_at) {
    meta.push(`生成于 ${formatStamp(item.meta.ai_suggestion_at)}`);
  }
  if (info) {
    meta.push(`检索 ${info.greps} 次 · 命中 ${info.evidence_count} 条`);
  }
  const title = [text, meta.join(' · ')].filter(Boolean).join('\n\n');

  return (
    <div className="items-suggestion-cell">
      <p className="items-suggestion-text" title={title}>
        {text}
      </p>
      <button
        type="button"
        className="items-suggestion-retry"
        onClick={onGenerate}
        title="重新检索并生成建议"
        aria-label="重新生成 AI 建议"
      >
        ↻
      </button>
    </div>
  );
}

function PeriodCell({
  item,
  range,
  mode,
  selected,
}: {
  item: ItemRow;
  range: PeriodRange;
  mode: ItemCellMode;
  selected: boolean;
}): ReactElement {
  const entries = tasksInPeriod(item.tasks, range);
  const summary = summarizePeriod(entries);
  const title = `${range.title} · ${entries.length} 条记录${
    selected ? '（已选中）' : '，点击查看详情'
  }`;

  if (entries.length === 0) {
    return (
      <div className="items-cell-body empty" title={title} style={{ height: CELL_BODY_HEIGHT }}>
        <span className="muted">—</span>
      </div>
    );
  }

  if (mode === 'tasks') {
    return (
      <div className="items-cell-body" title={title} style={{ height: CELL_BODY_HEIGHT }}>
        {entries.slice(0, 3).map((entry) => (
          <div key={entry.task.id} className="items-cell-task">
            <TaskStatusBadge status={entry.task.status} />
            <span className="items-cell-task-title">{entry.task.title}</span>
          </div>
        ))}
        {entries.length > 3 ? (
          <span className="items-cell-more">还有 {entries.length - 3} 条…</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="items-cell-body" title={title} style={{ height: CELL_BODY_HEIGHT }}>
      <div className="items-cell-counts">
        {summary.counts.slice(0, 3).map((count) => (
          <span
            key={count.kind}
            className={`items-count tone-${eventTone(count.kind)}`}
          >
            {count.label}
            {count.count}
          </span>
        ))}
        {summary.counts.length > 3 ? (
          <span className="items-count tone-muted">+{summary.counts.length - 3}</span>
        ) : null}
      </div>
      {summary.highlights.map((highlight, index) => (
        <p
          key={`${highlight.text}-${index}`}
          className={`items-cell-line tone-${highlight.tone}`}
          title={highlight.text}
        >
          {highlight.text}
        </p>
      ))}
    </div>
  );
}

function EditableText({
  value,
  placeholder,
  title,
  derived = false,
  onSave,
}: {
  value: string;
  placeholder: string;
  title?: string;
  derived?: boolean;
  onSave: (next: string) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className={`items-cell-edit${value ? '' : ' empty'}${derived ? ' derived' : ''}`}
        title={title ?? '点击编辑'}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value || placeholder}
      </button>
    );
  }

  const commit = (): void => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) onSave(next);
  };

  return (
    <input
      className="items-inline-input"
      autoFocus
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          setEditing(false);
          setDraft(value);
        }
      }}
    />
  );
}

function EditableList({
  values,
  placeholder,
  derived = false,
  onSave,
}: {
  values: string[];
  placeholder: string;
  derived?: boolean;
  onSave: (next: string[]) => void;
}): ReactElement {
  const joined = values.join('、');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(joined);

  useEffect(() => {
    if (!editing) setDraft(joined);
  }, [joined, editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className={`items-cell-edit items-cell-list${values.length ? '' : ' empty'}${
          derived ? ' derived' : ''
        }`}
        title={derived ? '当前按任务推导；点击填写后以人工值为准（逗号分隔）' : '点击编辑（逗号分隔）'}
        onClick={() => {
          setDraft(joined);
          setEditing(true);
        }}
      >
        {values.length > 0 ? (
          <span className="items-chip-row">
            {values.slice(0, 2).map((value) => (
              <span key={value} className="items-chip" title={value}>
                {value}
              </span>
            ))}
            {values.length > 2 ? (
              <span className="items-chip more">+{values.length - 2}</span>
            ) : null}
          </span>
        ) : (
          placeholder
        )}
      </button>
    );
  }

  const commit = (): void => {
    setEditing(false);
    const next = parseListInput(draft);
    if (next.join('|') !== values.join('|')) onSave(next);
  };

  return (
    <input
      className="items-inline-input"
      autoFocus
      value={draft}
      placeholder="用逗号分隔"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          setEditing(false);
          setDraft(joined);
        }
      }}
    />
  );
}

function EditablePriority({
  value,
  derived,
  onSave,
}: {
  value: Priority | null;
  derived: boolean;
  onSave: (next: Priority | null) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <select
        className="items-inline-input"
        autoFocus
        value={value ?? ''}
        onChange={(event) => {
          setEditing(false);
          onSave((event.target.value || null) as Priority | null);
        }}
        onBlur={() => setEditing(false)}
      >
        <option value="">未设置</option>
        {(['P0', 'P1', 'P2', 'P3'] as Priority[]).map((priority) => (
          <option key={priority} value={priority}>
            {priority}
          </option>
        ))}
      </select>
    );
  }
  return (
    <button
      type="button"
      className={`items-cell-edit items-cell-badge${derived ? ' derived' : ''}`}
      title={derived ? '按未结束任务的最高优先级推导；点击填写后以人工值为准' : '点击编辑优先级'}
      onClick={() => setEditing(true)}
    >
      {value ? <PriorityBadge priority={value} /> : <span className="muted">—</span>}
    </button>
  );
}

function EditableStage({
  value,
  derived,
  onSave,
}: {
  value: ItemStage | null;
  derived: boolean;
  onSave: (next: ItemStage | null) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <select
        className="items-inline-input"
        autoFocus
        value={value ?? ''}
        onChange={(event) => {
          setEditing(false);
          onSave((event.target.value || null) as ItemStage | null);
        }}
        onBlur={() => setEditing(false)}
      >
        <option value="">未设置</option>
        {STAGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <button
      type="button"
      className={`items-cell-edit items-cell-stage stage-${value ?? 'none'}${
        derived ? ' derived' : ''
      }`}
      title={derived ? '按任务状态推导；点击填写后以人工值为准' : '点击编辑阶段'}
      onClick={() => setEditing(true)}
    >
      {value ? STAGE_LABELS[value] : <span className="muted">—</span>}
    </button>
  );
}

/** 按左栏总宽等比缩放列宽；最后一列吃掉舍入误差，保证表格宽度与左栏一致。 */
function scaledWidths(total: number): number[] {
  const scale = total / BASE_LEFT_WIDTH;
  const widths = ITEM_COLUMNS.map((column) => Math.max(52, Math.round(column.width * scale)));
  const sum = widths.reduce((acc, width) => acc + width, 0);
  widths[widths.length - 1] = Math.max(52, widths[widths.length - 1]! + (total - sum));
  return widths;
}

export { PERIOD_COL_WIDTH };
