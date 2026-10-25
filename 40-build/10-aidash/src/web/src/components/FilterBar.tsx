import type { ReactElement } from 'react';
import type { CardStatus, CardType, Priority } from '../types';
import { CARD_STATUS_LABELS, CARD_TYPE_LABELS } from '../lib/format';

export interface CardFilters {
  types: CardType[];
  statuses: CardStatus[];
  priorities: Priority[];
  q: string;
  sort: 'priority' | 'due_at' | 'created_at' | 'updated_at';
  order: 'asc' | 'desc';
  pageSize: number;
  includeArchived: boolean;
}

export const ALL_CARD_TYPES: CardType[] = [
  'info',
  'handoff',
  'question',
  'suggestion',
  'status',
  'artifact',
];

export const DEFAULT_CARD_FILTERS: CardFilters = {
  types: ALL_CARD_TYPES,
  statuses: ['open'],
  priorities: ['P0', 'P1', 'P2', 'P3'],
  q: '',
  // P0 在最前：优先级字符串本身有序，升序即可。
  sort: 'priority',
  order: 'asc',
  pageSize: 50,
  includeArchived: false,
};

const STATUS_OPTIONS: CardStatus[] = ['open', 'answered', 'expired', 'dismissed', 'archived'];
const PRIORITY_OPTIONS: Priority[] = ['P0', 'P1', 'P2', 'P3'];

function toggleValue<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function ChipGroup<T extends string>({
  options,
  selected,
  labelOf,
  onChange,
}: {
  options: T[];
  selected: T[];
  labelOf: (value: T) => string;
  onChange: (next: T[]) => void;
}): ReactElement {
  return (
    <div className="chip-group" role="group">
      {options.map((value) => {
        const active = selected.includes(value);
        return (
          <button
            key={value}
            type="button"
            className={active ? 'chip active' : 'chip'}
            aria-pressed={active}
            onClick={() => onChange(toggleValue(selected, value))}
          >
            {labelOf(value)}
          </button>
        );
      })}
    </div>
  );
}

export function FilterBar({
  filters,
  onChange,
  showTypes = true,
}: {
  filters: CardFilters;
  onChange: (patch: Partial<CardFilters>) => void;
  showTypes?: boolean;
}): ReactElement {
  return (
    <section className="panel filter-bar" aria-label="筛选栏">
      <div className="filter-row">
        <label className="field grow">
          <span>搜索</span>
          <input
            type="search"
            value={filters.q}
            placeholder="标题 / 正文关键词（输入防抖 300ms）"
            onChange={(event) => onChange({ q: event.target.value })}
          />
        </label>

        <label className="field">
          <span>排序</span>
          <select
            value={filters.sort}
            onChange={(event) =>
              onChange({ sort: event.target.value as CardFilters['sort'] })
            }
          >
            <option value="priority">优先级</option>
            <option value="due_at">到期时间</option>
            <option value="created_at">创建时间</option>
            <option value="updated_at">更新时间</option>
          </select>
        </label>

        <label className="field">
          <span>方向</span>
          <select
            value={filters.order}
            onChange={(event) => onChange({ order: event.target.value as 'asc' | 'desc' })}
          >
            <option value="asc">升序</option>
            <option value="desc">降序</option>
          </select>
        </label>

        <label className="field">
          <span>每页</span>
          <select
            value={filters.pageSize}
            onChange={(event) => onChange({ pageSize: Number(event.target.value) })}
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>

        <label className="check inline-check">
          <input
            type="checkbox"
            checked={filters.includeArchived}
            onChange={(event) => onChange({ includeArchived: event.target.checked })}
          />
          含归档
        </label>
      </div>

      <div className="filter-row wrap">
        {showTypes ? (
          <div className="filter-block">
            <span className="filter-label">信息流类型</span>
            <ChipGroup
              options={ALL_CARD_TYPES}
              selected={filters.types}
              labelOf={(value) => CARD_TYPE_LABELS[value]}
              onChange={(types) => onChange({ types })}
            />
          </div>
        ) : null}

        <div className="filter-block">
          <span className="filter-label">状态</span>
          <ChipGroup
            options={STATUS_OPTIONS}
            selected={filters.statuses}
            labelOf={(value) => CARD_STATUS_LABELS[value]}
            onChange={(statuses) => onChange({ statuses })}
          />
        </div>

        <div className="filter-block">
          <span className="filter-label">优先级</span>
          <ChipGroup
            options={PRIORITY_OPTIONS}
            selected={filters.priorities}
            labelOf={(value) => value}
            onChange={(priorities) => onChange({ priorities })}
          />
        </div>

        <button
          type="button"
          className="btn btn-small btn-ghost"
          onClick={() => onChange(DEFAULT_CARD_FILTERS)}
        >
          重置筛选
        </button>
      </div>
    </section>
  );
}
