import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { CardAnswer, CardOption, CardView } from '../types';
import { describeError } from '../api/client';
import {
  CARD_STATUS_LABELS,
  formatAbsolute,
  isRecommendedOption,
  optionLabel,
  recommendationLabel,
  recommendationReason,
  recommendationRole,
} from '../lib/format';
import { Markdown, MarkdownInline } from './Markdown';

/**
 * 需要“让浏览器自己处理按键”的输入控件。
 *
 * 注意只排除文本类输入：radio/checkbox 也是 <input>，但如果把它们也排除，
 * 用户用鼠标点完某个选项后按数字键就失效了，正好和快捷键的预期相反。
 */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  'date',
  'datetime-local',
  'time',
  'month',
  'week',
]);

function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    return TEXT_INPUT_TYPES.has((element as HTMLInputElement).type);
  }
  return false;
}

/**
 * SCR-02 R4：question 卡的“选项回答区”。
 *
 * 分工原则：CardBody 只讲四段背景，选项、优缺点、推荐徽标和回答表单只在这里出现一次。
 * 关闭态（已回答/已过期/已忽略/已归档）仍然展示全部选项：
 * 用户需要看到“当时还有哪些没选的方案”，否则决策记录只剩一个答案，无法复盘取舍。
 *
 * variant='modal' 时启用键盘快捷操作：
 * 数字键选中对应选项、Enter 提交；←/→ 由外层的拍板模态框负责切换前后卡片。
 */
export function AnswerPanel({
  card,
  busy,
  onSubmit,
  variant = 'drawer',
}: {
  card: CardView;
  busy: boolean;
  onSubmit: (answer: CardAnswer) => Promise<void>;
  variant?: 'drawer' | 'modal';
}): ReactElement {
  const [optionId, setOptionId] = useState('');
  const [freeText, setFreeText] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 键盘 Enter 与表单 submit 可能同帧触发；用同步 ref 保证只提交一次。
  const submittingRef = useRef(false);

  useEffect(() => {
    setOptionId(card.answer?.option_id ?? '');
    setFreeText(card.answer?.free_text ?? '');
    setNote(card.answer?.note ?? '');
    setError(null);
  }, [card.id, card.updated_at, card.answer]);

  const closed = card.status !== 'open';
  const answeredOption = card.answer?.option_id
    ? card.options.find((option) => option.id === card.answer?.option_id)
    : undefined;

  const submitAnswer = async (): Promise<void> => {
    if (submittingRef.current || busy) return;
    if (!optionId && !freeText.trim()) {
      setError('请选择一个选项，或填写自由文本');
      return;
    }
    setError(null);
    submittingRef.current = true;
    try {
      await onSubmit({
        option_id: optionId || null,
        free_text: freeText.trim() || null,
        note: note.trim() || null,
      });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      submittingRef.current = false;
    }
  };

  const submitForm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitAnswer();
  };

  useEffect(() => {
    if (variant !== 'modal' || closed) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEntryTarget(event.target)) return;

      // 1..9 对应前 9 个选项，0 对应第 10 个（接口上限正好 10 个）。
      if (/^[1-9]$/.test(event.key) || event.key === '0') {
        const index = event.key === '0' ? 9 : Number(event.key) - 1;
        const option = card.options[index];
        if (option) {
          event.preventDefault();
          setOptionId(option.id);
        }
        return;
      }

      if (event.key === 'Enter') {
        const tag = (event.target as HTMLElement | null)?.tagName;
        // 焦点在按钮/链接上时交给原生行为，避免同一次 Enter 提交两遍。
        if (tag === 'BUTTON' || tag === 'A') return;
        if (!optionId && !freeText.trim()) return;
        event.preventDefault();
        void submitAnswer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // submitAnswer 每次渲染都是新函数；它依赖的 optionId/freeText/note 已列入下方依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, closed, card.options, optionId, freeText, note, busy]);

  if (closed) {
    return (
      <section className={variant === 'modal' ? 'answer-panel-modal' : 'drawer-section'}>
        <h3>选项回答区</h3>
        <p className="muted">
          卡片当前状态为 <strong>{CARD_STATUS_LABELS[card.status]}</strong>，不能再提交回答。
        </p>

        {card.answer ? (
          // 已回答：先给结论，再把全部选项列在下面；选中项高亮，未选中项灰显但不隐藏。
          <div className="answer-summary">
            <p>
              已选：<strong>{optionLabel(card, card.answer.option_id) || '—'}</strong>
            </p>
            {card.answer.free_text ? <p>自由文本：{card.answer.free_text}</p> : null}
            {card.answer.note ? <p>备注：{card.answer.note}</p> : null}
            {card.answer.answered_at ? (
              <p className="muted small">回答于 {formatAbsolute(card.answer.answered_at)}</p>
            ) : null}
          </div>
        ) : (
          <p className="muted small">没有收到回答；以下选项仅作只读展示。</p>
        )}

        <div className="answer-options">
          {card.options.map((option) => {
            const selected = card.answer?.option_id === option.id;
            return (
              <ReadonlyOption
                key={option.id}
                option={option}
                selected={selected}
                disabled={!card.answer}
                dimmed={Boolean(card.answer) && !selected}
              />
            );
          })}
          {answeredOption ? null : card.answer?.option_id ? (
            <p className="muted small">所选选项已不在卡片中，但回答记录仍然保留。</p>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className={variant === 'modal' ? 'answer-panel-modal' : 'drawer-section'}>
      <h3>选项回答区</h3>
      <form className="stack" onSubmit={submitForm}>
        <div className="answer-options">
          {card.options.map((option, index) => {
            const checked = optionId === option.id;
            const inputId = `answer-${card.id}-${option.id}`;
            return (
              <div
                key={option.id}
                className={[
                  'answer-option-card',
                  checked ? 'selected' : '',
                  isRecommendedOption(option) ? 'recommended' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                // 整张卡都可点选；radio 与 label 的点击会冒泡到同一处理逻辑，重复赋值无害。
                onClick={() => setOptionId(option.id)}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={`answer-${card.id}`}
                  value={option.id}
                  checked={checked}
                  onChange={() => setOptionId(option.id)}
                />
                <label className="answer-option-clickable" htmlFor={inputId}>
                  <OptionDetails
                    option={option}
                    shortcutKey={variant === 'modal' ? shortcutLabel(index) : undefined}
                  />
                </label>
              </div>
            );
          })}
        </div>

        {card.allow_free_text ? (
          <label className="field">
            <span>自由文本（可选，不选选项时必填）</span>
            <textarea
              rows={3}
              value={freeText}
              maxLength={4096}
              onChange={(event) => setFreeText(event.target.value)}
            />
          </label>
        ) : null}

        <label className="field">
          <span>备注（可选，≤500 字）</span>
          <input
            type="text"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        {error ? <div className="error-box" role="alert">{error}</div> : null}

        <div className="inline answer-submit">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? '提交中…' : '提交回答'}
          </button>
          <span className="muted small">
            {variant === 'modal'
              ? '数字键选选项 · Enter 提交 · ←/→ 切换前后卡片 · Esc 关闭'
              : '提交后卡片变为“已回答”，不可重复提交。'}
          </span>
        </div>
      </form>
    </section>
  );
}

/** 模态框里的快捷键提示：前 9 个用 1..9，第 10 个用 0。 */
function shortcutLabel(index: number): string | undefined {
  if (index < 9) return String(index + 1);
  if (index === 9) return '0';
  return undefined;
}

/**
 * 单个选项的完整信息：标题、主/备推荐徽标、描述、优点、缺点、旧数据推荐理由。
 *
 * 为什么优缺点用 Markdown：决策项经常带列表或代码片段，纯文本会把换行压平，
 * 用户很难比较“代价”与“收益”。空段必须显式写“未提供”，不能留白。
 */
function OptionDetails({
  option,
  chosen = false,
  shortcutKey,
}: {
  option: CardOption;
  chosen?: boolean;
  shortcutKey?: string;
}): ReactElement {
  const badgeLabel = recommendationLabel(option);
  const role = recommendationRole(option);
  const reason = recommendationReason(option);

  return (
    <div className="answer-option-body">
      <div className="option-head">
        {shortcutKey ? (
          <kbd className="option-key" title={`按数字键 ${shortcutKey} 选择`}>
            {shortcutKey}
          </kbd>
        ) : null}
        <strong>{option.label}</strong>
        {chosen ? <span className="badge answer-chosen">已选</span> : null}
        {badgeLabel ? (
          <span className={`badge recommendation-${role ?? 'legacy'}`}>{badgeLabel}</span>
        ) : null}
      </div>
      {option.description?.trim() ? (
        <p className="muted small">
          <MarkdownInline source={option.description} fallback="未提供" />
        </p>
      ) : (
        <p className="muted small">未提供</p>
      )}
      <div className="option-tradeoffs">
        <div className="option-tradeoff">
          <span className="option-trait-label">优点</span>
          {option.pros_md?.trim() ? (
            <Markdown source={option.pros_md} />
          ) : (
            <p className="muted small">未提供</p>
          )}
        </div>
        <div className="option-tradeoff">
          <span className="option-trait-label">缺点</span>
          {option.cons_md?.trim() ? (
            <Markdown source={option.cons_md} />
          ) : (
            <p className="muted small">未提供</p>
          )}
        </div>
      </div>
      {reason ? (
        <p className="muted small">
          推荐理由：<MarkdownInline source={reason} />
        </p>
      ) : null}
    </div>
  );
}

/**
 * 关闭态的只读选项：保留完整信息，radio 禁用，不渲染任何提交控件。
 *
 * dimmed 用于“已回答但没选中”的选项：降低视觉权重但不隐藏，
 * 让用户一眼看到选中项，同时仍能回看其他方案。
 */
function ReadonlyOption({
  option,
  selected = false,
  disabled = false,
  dimmed = false,
}: {
  option: CardOption;
  selected?: boolean;
  disabled?: boolean;
  dimmed?: boolean;
}): ReactElement {
  const classes = ['answer-option-card', 'readonly'];
  if (selected) classes.push('selected');
  if (disabled) classes.push('disabled');
  if (dimmed) classes.push('unselected');
  if (isRecommendedOption(option)) classes.push('recommended');

  return (
    <div className={classes.join(' ')}>
      <input
        type="radio"
        checked={selected}
        disabled
        readOnly
        aria-label={`选项 ${option.label}`}
      />
      <OptionDetails option={option} chosen={selected} />
    </div>
  );
}
