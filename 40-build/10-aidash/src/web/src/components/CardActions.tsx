import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { CardView, Priority } from '../types';
import { describeError } from '../api/client';
import { archiveCard, dismissCard, updateCard } from '../api/endpoints';
import { useToast } from './Toast';

type BusyAction = 'save' | 'archive' | 'dismiss' | null;

/**
 * SCR-02 R5：只允许改标题与优先级。
 * 正文/选项是 harness 写下的事实，用户改了会让“卡片”与执行方看到的内容不一致。
 */
export function CardActions({
  card,
  onChanged,
  onClose,
}: {
  card: CardView;
  onChanged: () => void;
  onClose: () => void;
}): ReactElement {
  const notify = useToast().notify;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title ?? '');
  const [priority, setPriority] = useState<Priority>(card.priority);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(card.title ?? '');
    setPriority(card.priority);
    setEditing(false);
    setError(null);
  }, [card.id, card.updated_at, card.title, card.priority]);

  const run = async (action: Exclude<BusyAction, null>, task: () => Promise<void>): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      await task();
    } catch (cause) {
      const message = describeError(cause);
      setError(message);
      notify('error', message);
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError('标题不能为空');
      return;
    }
    if (nextTitle === (card.title ?? '') && priority === card.priority) {
      notify('info', '没有需要保存的修改');
      return;
    }
    await run('save', async () => {
      await updateCard(card.id, { title: nextTitle, priority });
      notify('success', '卡片字段已更新');
      setEditing(false);
      onChanged();
    });
  };

  const archive = async (): Promise<void> => {
    if (!window.confirm('归档后卡片将移出默认列表，确认继续？')) return;
    await run('archive', async () => {
      await archiveCard(card.id);
      notify('success', '卡片已归档');
      onChanged();
      onClose();
    });
  };

  const dismiss = async (): Promise<void> => {
    if (!window.confirm('“稍后处理”会把卡片标记为已忽略，确认继续？')) return;
    await run('dismiss', async () => {
      await dismissCard(card.id);
      notify('success', '卡片已标记为稍后处理');
      onChanged();
      onClose();
    });
  };

  const archived = card.status === 'archived';

  return (
    <section className="drawer-section">
      <h3>操作</h3>

      {editing && !archived ? (
        <div className="form-grid">
          <label className="field">
            <span>标题（≤200 字）</span>
            <input
              type="text"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="field">
            <span>优先级</span>
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as Priority)}
            >
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </select>
          </label>
          <div className="inline">
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={busy !== null}
              onClick={() => void save()}
            >
              {busy === 'save' ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="inline wrap">
          <button
            type="button"
            className="btn btn-small"
            disabled={archived}
            onClick={() => setEditing(true)}
          >
            编辑标题/优先级
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={archived || busy !== null}
            onClick={() => void archive()}
          >
            {busy === 'archive' ? '归档中…' : '归档'}
          </button>
          {card.status === 'open' ? (
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={busy !== null}
              onClick={() => void dismiss()}
            >
              {busy === 'dismiss' ? '处理中…' : '稍后处理'}
            </button>
          ) : null}
        </div>
      )}

      {archived ? <p className="muted small">该卡已归档，只读展示。</p> : null}
      {error ? <div className="error-box" role="alert">{error}</div> : null}
    </section>
  );
}
