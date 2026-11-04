import type { ReactElement } from 'react';
import type { ItemStage, Priority } from '../types';
import { OPEN_STAGE_FILTER, PERIOD_OPTIONS, STAGE_OPTIONS } from '../lib/item-period';
import type { MatrixPeriod } from '../lib/item-period';

/** 单元格默认显示汇报摘要，还是直接列任务项。 */
export type ItemCellMode = 'summary' | 'tasks';

export interface ItemFilterState {
  keyword: string;
  project: string;
  stage: string;
  priority: string;
  owner: string;
}

export function ItemsToolbar({
  period,
  onPeriodChange,
  mode,
  onModeChange,
  filters,
  onFiltersChange,
  projects,
  owners,
  periodsLoaded,
  loading,
  itemCount,
  taskCount,
  onLoadOlder,
  onRefresh,
}: {
  period: MatrixPeriod;
  onPeriodChange: (period: MatrixPeriod) => void;
  mode: ItemCellMode;
  onModeChange: (mode: ItemCellMode) => void;
  filters: ItemFilterState;
  onFiltersChange: (patch: Partial<ItemFilterState>) => void;
  projects: string[];
  owners: string[];
  periodsLoaded: number;
  loading: boolean;
  itemCount: number;
  taskCount: number;
  onLoadOlder: () => void;
  onRefresh: () => void;
}): ReactElement {
  return (
    <section className="panel items-toolbar" aria-label="事项筛选与视图设置">
      <div className="items-toolbar-row">
        <div className="items-field">
          <span className="items-field-label">周期</span>
          <div className="segmented" role="group" aria-label="周期角度">
            {PERIOD_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={period === option.value ? 'segmented-item active' : 'segmented-item'}
                aria-pressed={period === option.value}
                title={`${option.name}查看任务记录`}
                onClick={() => onPeriodChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="items-field">
          <span className="items-field-label">格子内容</span>
          <div className="segmented" role="group" aria-label="格子内容">
            <button
              type="button"
              className={mode === 'summary' ? 'segmented-item active' : 'segmented-item'}
              aria-pressed={mode === 'summary'}
              title="按汇报口径抽取本周期要点（默认）"
              onClick={() => onModeChange('summary')}
            >
              汇报摘要
            </button>
            <button
              type="button"
              className={mode === 'tasks' ? 'segmented-item active' : 'segmented-item'}
              aria-pressed={mode === 'tasks'}
              title="直接列出本周期最新几条任务项"
              onClick={() => onModeChange('tasks')}
            >
              任务项
            </button>
          </div>
        </div>

        <label className="items-field items-search-field">
          <span className="items-field-label">搜索</span>
          <input
            className="input"
            type="search"
            value={filters.keyword}
            placeholder="事项名 / 属性 / 通道 key"
            onChange={(event) => onFiltersChange({ keyword: event.target.value })}
          />
        </label>

        <div className="items-field">
          <span className="items-field-label">父通道</span>
          <select
            className="input"
            value={filters.project}
            onChange={(event) => onFiltersChange({ project: event.target.value })}
          >
            <option value="">全部</option>
            {projects.map((project) => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
          </select>
        </div>

        <div className="items-field">
          <span className="items-field-label">阶段</span>
          <select
            className="input"
            value={filters.stage}
            onChange={(event) => onFiltersChange({ stage: event.target.value })}
          >
            <option value={OPEN_STAGE_FILTER}>非关闭（默认）</option>
            <option value="">全部</option>
            {STAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="items-field">
          <span className="items-field-label">优先级</span>
          <select
            className="input"
            value={filters.priority}
            onChange={(event) => onFiltersChange({ priority: event.target.value })}
          >
            <option value="">全部</option>
            {(['P0', 'P1', 'P2', 'P3'] as Priority[]).map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </div>

        <div className="items-field">
          <span className="items-field-label">负责人</span>
          <select
            className="input"
            value={filters.owner}
            onChange={(event) => onFiltersChange({ owner: event.target.value })}
          >
            <option value="">全部</option>
            {owners.map((owner) => (
              <option key={owner} value={owner}>
                {owner}
              </option>
            ))}
          </select>
        </div>

        <div className="items-toolbar-actions">
          <span className="muted small">
            {itemCount} 个事项 · {taskCount} 条任务 · 已显示 {periodsLoaded} 期
          </span>
          <button type="button" className="btn btn-small" onClick={onLoadOlder}>
            加载更早 4 期
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>
      <p className="muted small items-toolbar-hint">
        每行是一个子通道（事项），同一父通道可整组收起；右侧每列是一个周期，
        默认最新一期在最左，向右滚动查看更早记录。阶段默认只看非关闭事项，
        切到“全部”可找回已关闭事项。点格子打开右侧详情，查看该周期的完整任务树与汇报。
        左栏属性可直接点击编辑，拖拽分隔条可调整左右占比。
      </p>
    </section>
  );
}

export function isStageValue(value: string): value is ItemStage {
  return (
    value === 'planned' ||
    value === 'in_progress' ||
    value === 'waiting' ||
    value === 'done' ||
    value === 'closed'
  );
}
