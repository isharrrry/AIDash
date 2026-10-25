import { useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { CARD_STATUS_LABELS } from '../lib/format';
import { TREE_STEP } from '../lib/task-tree';
import type { CardView, TreeNode } from '../types';
import { MarkdownInline } from './Markdown';

export interface TaskDecisionChipsProps {
  cards: CardView[];
  depth: number;
  onOpenCard: (cardId: string) => void;
}

/**
 * 任务行下挂的决策卡。
 *
 * 决策条目直接挂在任务行下面：用户看任务时就知道“这条任务卡在哪个决策上”，
 * 不用再去决策台按标题猜它属于哪件事。点开仍走全局卡片抽屉/模态框。
 */
export function TaskDecisionChips({
  cards,
  depth,
  onOpenCard,
}: TaskDecisionChipsProps): ReactElement | null {
  if (cards.length === 0) return null;
  return (
    <div
      className="task-decisions"
      style={{ paddingLeft: `${8 + depth * TREE_STEP}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="task-decisions-label">决策</span>
      {cards.slice(0, 4).map((card) => (
        <button
          type="button"
          key={card.id}
          className={`task-decision-chip card-status-${card.status}`}
          title={`${card.title ?? '未命名决策'} · ${CARD_STATUS_LABELS[card.status]}`}
          onClick={() => onOpenCard(card.id)}
        >
          <span className="task-decision-dot" aria-hidden="true" />
          <span className="task-decision-status">{CARD_STATUS_LABELS[card.status]}</span>
          <span className="task-decision-title">
            <MarkdownInline source={card.title ?? '未命名决策'} />
          </span>
        </button>
      ))}
      {cards.length > 4 ? (
        <span className="muted small">还有 {cards.length - 4} 条</span>
      ) : null}
    </div>
  );
}

export interface TaskAddChildFormProps {
  node: TreeNode;
  depth: number;
  onAddChild: (parent: TreeNode, title: string) => Promise<boolean>;
  onClose: () => void;
}

/**
 * 行内新增草稿子任务。
 *
 * 输入内容与提交中状态放在本组件内部：表单关闭时组件卸载，
 * 草稿自然清空，父级 TaskNode 不必额外维护一份临时输入。
 */
export function TaskAddChildForm({
  node,
  depth,
  onAddChild,
  onClose,
}: TaskAddChildFormProps): ReactElement {
  const [draftTitle, setDraftTitle] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const submitAdd = async (): Promise<void> => {
    const title = draftTitle.trim();
    if (!title || addBusy) return;
    setAddBusy(true);
    const ok = await onAddChild(node, title);
    setAddBusy(false);
    if (!ok) return;
    // 成功后清空并保留输入框，方便连续给同一节点补几条草稿。
    setDraftTitle('');
  };

  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitAdd();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraftTitle('');
      onClose();
    }
  };

  return (
    <div
      className="task-add-inline"
      style={{ paddingLeft: `${8 + depth * TREE_STEP}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        autoFocus
        value={draftTitle}
        maxLength={200}
        placeholder={`在「${node.title}」下新增草稿子任务，一句话即可`}
        aria-label="草稿子任务标题"
        onChange={(event) => setDraftTitle(event.target.value)}
        onKeyDown={onDraftKeyDown}
      />
      <button
        type="button"
        className="btn btn-small btn-primary"
        disabled={addBusy || !draftTitle.trim()}
        onClick={() => void submitAdd()}
      >
        {addBusy ? '保存中…' : '保存草稿'}
      </button>
      <button
        type="button"
        className="btn btn-small btn-ghost"
        onClick={() => {
          setDraftTitle('');
          onClose();
        }}
      >
        取消
      </button>
      <span className="muted small">Enter 保存 · Esc 取消 · 默认停在草稿，不会自动派发</span>
    </div>
  );
}
