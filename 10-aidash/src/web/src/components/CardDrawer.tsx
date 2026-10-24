import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { CardAnswer, CardView, HandoffState, Page } from '../types';
import { ApiError, describeError } from '../api/client';
import { answerCard, getCard, listCards, setHandoffState } from '../api/endpoints';
import { useApp } from '../AppContext';
import { copyToClipboard } from '../lib/clipboard';
import { openCard } from '../lib/router';
import { useAsync } from '../hooks/useAsync';
import { AnswerPanel } from './AnswerPanel';
import { CardActions } from './CardActions';
import { CardBody } from './CardBody';
import { EnrichmentPanel } from './EnrichmentPanel';
import { ErrorBox, Loading } from './Feedback';
import { KbDocPreview } from './KbDocPreview';
import { useToast } from './Toast';

/**
 * SCR-02 卡片详情。
 *
 * 普通卡片用右侧抽屉；question（拍板）卡改用大尺寸模态框：
 * 决策信息天然是“四段背景 + 多个选项 + 优缺点”，抽屉宽度不够，用户必须不停上下滚。
 * 模态框用左右两栏把背景与选项并排，尽量在一屏内看完整。
 *
 * 关闭后保留原列表位置；深链为当前路由加 `?card={id}`。
 * 每次写操作后同时刷新抽屉自身与底层列表，避免“抽屉已变、列表还是旧的”。
 */
export function CardDrawer({
  cardId,
  onClose,
  onChanged,
}: {
  cardId: string;
  onClose: () => void;
  onChanged: () => void;
}): ReactElement {
  const notify = useToast().notify;
  const { currentChannelKey, currentProject } = useApp();
  const { data, loading, error, reload } = useAsync(() => getCard(cardId), [cardId]);
  const [kbPath, setKbPath] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);

  // useAsync 在依赖变化时会保留上一张卡的数据；用 id 校验避免切换时短暂显示旧内容。
  const card = data && data.id === cardId ? data : null;

  // 决策卡前后翻页：只取“待处理”的问题卡，顺序按创建时间，和决策队列的阅读顺序一致。
  // 范围跟随右上角通道树；未聚焦时跨通道翻页。
  const questions = useAsync<Page<CardView>>(
    () =>
      listCards({
        channel_key: currentChannelKey || undefined,
        project: currentProject || undefined,
        types: ['question'],
        statuses: ['open'],
        page_size: 200,
        sort: 'created_at',
        order: 'asc',
      }),
    [currentChannelKey, currentProject],
    card?.type === 'question',
  );
  const questionItems = questions.data?.items ?? [];
  const questionIndex = questionItems.findIndex((item) => item.id === cardId);
  const prevQuestion = questionIndex > 0 ? questionItems[questionIndex - 1] : undefined;
  const nextQuestion =
    questionIndex >= 0 && questionIndex < questionItems.length - 1
      ? questionItems[questionIndex + 1]
      : undefined;

  // 抽屉打开期间锁滚动，关闭/卸载时恢复，避免背景列表跟着滚。
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // ←/→ 切换前后决策卡。只跳过文本输入：textarea 里的左右键要移动光标，
  // radio 上不拦截的话左右键会变成“换选项”，和用户要求的“换条目”冲突。
  useEffect(() => {
    if (card?.type !== 'question') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (tag === 'INPUT' && (target as HTMLInputElement).type !== 'radio') return;

      if (event.key === 'ArrowLeft' && prevQuestion) {
        event.preventDefault();
        openCard(prevQuestion.id);
      } else if (event.key === 'ArrowRight' && nextQuestion) {
        event.preventDefault();
        openCard(nextQuestion.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [card?.type, prevQuestion, nextQuestion]);

  const refresh = useCallback(() => {
    reload();
    onChanged();
  }, [reload, onChanged]);

  const handleAnswer = async (answer: CardAnswer): Promise<void> => {
    setAnswering(true);
    try {
      await answerCard(cardId, answer);
      notify('success', '回答已提交');
      refresh();
    } catch (cause) {
      // 冲突/过期意味着别人已处理或到期：刷新到最新状态，避免用户重复点击。
      if (cause instanceof ApiError && cause.code === 'CONFLICT') {
        notify('warn', '该卡已被处理或已过期，已刷新最新状态');
        refresh();
      } else {
        notify('error', `回答失败：${describeError(cause)}`);
      }
      throw cause;
    } finally {
      setAnswering(false);
    }
  };

  const handleHandoff = async (state: HandoffState): Promise<void> => {
    setHandoffBusy(true);
    try {
      await setHandoffState(cardId, state);
      notify('success', '交接状态已更新');
      refresh();
    } catch (cause) {
      notify('error', `更新交接状态失败：${describeError(cause)}`);
    } finally {
      setHandoffBusy(false);
    }
  };

  const handleCopy = async (): Promise<void> => {
    const message = card?.message_md?.trim();
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

  // 首屏加载/切换卡片时先给一个居中加载层：类型未知时先渲染抽屉会闪一下再变成模态框。
  if (!card && loading) {
    return (
      <div className="modal-overlay" role="presentation">
        <div className="card-loading panel">
          <Loading label="加载卡片…" />
        </div>
      </div>
    );
  }

  if (card?.type === 'question') {
    return (
      <div className="modal-overlay" role="presentation" onClick={onClose}>
        <section
          className="question-modal"
          role="dialog"
          aria-modal="true"
          aria-label="决策卡详情"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="question-modal-head">
            <div className="modal-nav" aria-label="切换待决策卡">
              <button
                type="button"
                className="btn btn-small modal-nav-btn"
                disabled={!prevQuestion || answering}
                title="上一张待决策卡（←）"
                onClick={() => prevQuestion && openCard(prevQuestion.id)}
              >
                ←
              </button>
              <span className="muted small modal-nav-index">
                {questionIndex >= 0
                  ? `${questionIndex + 1} / ${questionItems.length}`
                  : '— / —'}
              </span>
              <button
                type="button"
                className="btn btn-small modal-nav-btn"
                disabled={!nextQuestion || answering}
                title="下一张待决策卡（→）"
                onClick={() => nextQuestion && openCard(nextQuestion.id)}
              >
                →
              </button>
            </div>
            <span className="grow muted small">决策卡 · {cardId}</span>
            <span className="question-modal-hint">
              ←/→ 切换 · 数字键选择 · Enter 提交 · Esc 关闭
            </span>
            <button
              type="button"
              className="drawer-close"
              aria-label="关闭决策卡"
              onClick={onClose}
            >
              ×
            </button>
          </header>

          <div className="question-modal-body">
            {/* 左栏：四段背景。宽屏下四段用两列网格，减少纵向滚动。 */}
            <div className="question-modal-main">
              {error ? <ErrorBox message={error} onRetry={reload} /> : null}
              <CardBody
                card={card}
                onCopyHandoff={() => void handleCopy()}
                onHandoffState={(state) => void handleHandoff(state)}
                handoffBusy={handoffBusy}
              />
              <EnrichmentPanel card={card} onOpenKb={setKbPath} />
              {kbPath ? <KbDocPreview path={kbPath} onClose={() => setKbPath(null)} /> : null}
            </div>

            {/* 右栏：选项与回答表单。两栏各自滚动，选项不会被背景挤出屏幕。 */}
            <div className="question-modal-side">
              <AnswerPanel
                card={card}
                busy={answering}
                onSubmit={handleAnswer}
                variant="modal"
              />
              <CardActions card={card} onChanged={refresh} onClose={onClose} />
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="drawer-overlay" role="presentation" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="卡片详情"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <strong>卡片详情</strong>
            <span className="muted small"> {cardId}</span>
          </div>
          <button type="button" className="drawer-close" aria-label="关闭抽屉" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="drawer-body">
          {error ? <ErrorBox message={error} onRetry={reload} /> : null}

          {card ? (
            <>
              <CardBody
                card={card}
                onCopyHandoff={() => void handleCopy()}
                onHandoffState={(state) => void handleHandoff(state)}
                handoffBusy={handoffBusy}
              />
              <EnrichmentPanel card={card} onOpenKb={setKbPath} />
              {kbPath ? <KbDocPreview path={kbPath} onClose={() => setKbPath(null)} /> : null}
              <CardActions card={card} onChanged={refresh} onClose={onClose} />
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
