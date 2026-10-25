import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { CardOption } from '../types';

/**
 * 批量回答条。
 *
 * 只在“所有已选卡片都存在同一个 option_id”时才允许提交：
 * 设计文档里的 reject/later 没有对应接口（GAP-05），这里不做臆造，
 * 宁可显示“选项不一致，无法批量”，也不替用户猜测答案。
 */
export function BatchBar({
  selectedCount,
  commonOptions,
  busy,
  onSubmit,
  onClear,
}: {
  selectedCount: number;
  commonOptions: CardOption[];
  busy: boolean;
  onSubmit: (optionId: string) => void;
  onClear: () => void;
}): ReactElement | null {
  const [optionId, setOptionId] = useState('');

  useEffect(() => {
    if (!commonOptions.some((option) => option.id === optionId)) {
      setOptionId(commonOptions[0]?.id ?? '');
    }
  }, [commonOptions, optionId]);

  if (selectedCount === 0) return null;

  const disabled = busy || !optionId || commonOptions.length === 0;

  return (
    <div className="batch-bar" role="region" aria-label="批量操作">
      <span>
        已选 <strong>{selectedCount}</strong> 张决策卡
      </span>

      {commonOptions.length > 0 ? (
        <label className="inline">
          <span className="muted small">统一选择</span>
          <select value={optionId} onChange={(event) => setOptionId(event.target.value)}>
            {commonOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="warn-text">所选卡片的选项不一致，无法批量回答</span>
      )}

      <div className="inline">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={disabled}
          onClick={() => onSubmit(optionId)}
        >
          {busy ? '提交中…' : '批量提交'}
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={onClear}>
          取消选择
        </button>
      </div>
    </div>
  );
}
