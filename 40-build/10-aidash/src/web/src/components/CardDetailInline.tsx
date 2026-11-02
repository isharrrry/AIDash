import { useState } from 'react';
import type { ReactElement } from 'react';
import type { CardAnswer, CardView, HandoffState } from '../types';
import { ApiError, describeError } from '../api/client';
import { answerCard, setHandoffState } from '../api/endpoints';
import { copyToClipboard } from '../lib/clipboard';
import { shortId } from '../lib/format';
import { openCard } from '../lib/router';
import { AnswerPanel } from './AnswerPanel';
import { CardActions } from './CardActions';
import { CardBody } from './CardBody';
import { EnrichmentPanel } from './EnrichmentPanel';
import { KbDocPreview } from './KbDocPreview';
import { useToast } from './Toast';

/**
 * 与服务的 ENRICHABLE 集合保持一致：只有 question / suggestion 会跑增强。
 * 其他类型即使显示“增强与知识依据”也永远没有内容，内联展开时没必要多占一块。
 */
const ENRICHABLE: ReadonlySet<CardView['type']> = new Set(['question', 'suggestion']);

/**
 * 卡片详情的内联版本。
 *
 * 任务详情的信息流原来点开的是整页遮罩的卡片抽屉：读完必须再关一次，
 * 而且滚动位置和“正在看哪个任务”都会被遮罩打断。这里把抽屉里的同一套内容
 * （按类型切换的正文、选项回答区、增强与知识依据、卡片操作）直接嵌进任务详情，
 * 由外层的 Expander 控制展开/收起，浏览时不再离开当前任务。
 *
 * 为什么不直接复用 CardDrawer：决策卡走的是“左右两栏 + 键盘拍板”的专用模态布局，
 * 与任务详情里的纵向排布没有共同结构。内容组件仍是同一批
 * （CardBody / AnswerPanel / CardActions），同一张卡在抽屉与内联里不会长成两种样子。
 */
export function CardDetailInline({
  card,
  onChanged,
  onCollapse,
}: {
  card: CardView;
  /** 回答、交接状态、归档等写操作后通知外层重新拉取。 */
  onChanged: () => void;
  /** 归档/稍后处理后收起当前条目；省略时保持展开。 */
  onCollapse?: () => void;
}): ReactElement {
  const notify = useToast().notify;
  const [answering, setAnswering] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [kbPath, setKbPath] = useState<string | null>(null);

  const handleAnswer = async (answer: CardAnswer): Promise<void> => {
    setAnswering(true);
    try {
      await answerCard(card.id, answer);
      notify('success', '回答已提交');
      onChanged();
    } catch (cause) {
      // 与抽屉行为一致：别人已处理/卡片过期时先刷新到最新状态，避免重复点击。
      if (cause instanceof ApiError && cause.code === 'CONFLICT') {
        notify('warn', '该卡已被处理或已过期，已刷新最新状态');
        onChanged();
      } else {
        notify('error', `回答失败：${describeError(cause)}`);
      }
      // 交给 AnswerPanel 显示在表单内，用户不用去翻 Toast。
      throw cause;
    } finally {
      setAnswering(false);
    }
  };

  const handleHandoff = async (state: HandoffState): Promise<void> => {
    setHandoffBusy(true);
    try {
      await setHandoffState(card.id, state);
      notify('success', '交接状态已更新');
      onChanged();
    } catch (cause) {
      notify('error', `更新交接状态失败：${describeError(cause)}`);
    } finally {
      setHandoffBusy(false);
    }
  };

  const handleCopy = async (): Promise<void> => {
    const message = card.message_md?.trim();
    if (!message) {
      notify('warn', '当前卡片没有可复制的交接话术。');
      return;
    }
    try {
      await copyToClipboard(message);
      notify('success', '交接话术已复制到剪贴板');
    } catch (cause) {
      notify('error', describeError(cause));
    }
  };

  return (
    <div className="card-inline-detail">
      <CardBody
        card={card}
        onCopyHandoff={() => void handleCopy()}
        onHandoffState={(state) => void handleHandoff(state)}
        handoffBusy={handoffBusy}
      />

      {/* 决策卡的选项是读过正文后的下一步动作，直接放在正文下面，不用再开抽屉。 */}
      {card.type === 'question' ? (
        <AnswerPanel
          card={card}
          busy={answering}
          onSubmit={handleAnswer}
        />
      ) : null}

      {ENRICHABLE.has(card.type) ? (
        <EnrichmentPanel card={card} onOpenKb={setKbPath} />
      ) : null}
      {kbPath ? <KbDocPreview path={kbPath} onClose={() => setKbPath(null)} /> : null}

      <CardActions
        card={card}
        onChanged={onChanged}
        onClose={() => onCollapse?.()}
      />

      {/*
        内联承担日常阅读与操作；仍然留一个抽屉入口，供需要超大屏阅读或
        决策卡键盘拍板（数字键/Enter/←→）的场景使用。
      */}
      <footer className="card-inline-foot muted small">
        <span title={card.id}>卡片 {shortId(card.id)}</span>
        <button type="button" className="link-button" onClick={() => openCard(card.id)}>
          在抽屉中打开
        </button>
      </footer>
    </div>
  );
}
