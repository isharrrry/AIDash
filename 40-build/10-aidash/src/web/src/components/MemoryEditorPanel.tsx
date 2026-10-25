import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { MAX_MEMORY_CHARS } from '../../../shared/constants';
import { ApiError, describeError } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { formatAbsolute, formatRelative } from '../lib/format';
import { ErrorBox, Loading } from './Feedback';
import { Markdown } from './Markdown';
import { useToast } from './Toast';

/**
 * 记忆面板需要的最小视图形状。
 *
 * ProjectMemoryView 与 AssistantMemoryView 都结构上满足它：
 * 一个是“某个主对话的记忆”，一个是“AIDash 自己的记忆”，展示与编辑逻辑完全一样，
 * 只有标题、加载/保存函数不同。抽成一份的原因不是省代码，而是避免两处冲突处理
 * 各自演化——冲突提示一旦有一边写错，用户就会在不知情的情况下覆盖掉另一边的改动。
 */
export interface MemoryDocumentView {
  content_md: string;
  version: number;
  exists: boolean;
  line_count: number;
  updated_by: string | null;
  updated_at: string | null;
}

export interface MemoryEditorPanelProps {
  title: string;
  /** 标题旁的身份标记，例如项目名或“内置”。 */
  badge?: ReactNode;
  /** 标题下的补充说明。 */
  description?: ReactNode;
  ariaLabel: string;
  load: () => Promise<MemoryDocumentView>;
  save: (contentMd: string, expectedVersion: number) => Promise<MemoryDocumentView>;
  /** 变化时重新加载；通常是 project 名或一个刷新计数。 */
  reloadKey: unknown;
  /** 编辑态下的格式提示。 */
  editingHint: ReactNode;
  /** 还没有内容时的说明。 */
  emptyHint: ReactNode;
  compact?: boolean;
  /** 保存成功后通知父级刷新列表元数据（行数/修改时间）。 */
  onSaved?: () => void;
}

/**
 * 记忆阅读/编辑面板。
 *
 * 保存用 expected_version 做乐观锁：编辑期间 agent 可能刚追加了内容，
 * 直接覆盖会让那条约束凭空消失。冲突时不丢弃用户草稿，而是保留并给出“载入最新”。
 */
export function MemoryEditorPanel({
  title,
  badge,
  description,
  ariaLabel,
  load,
  save,
  reloadKey,
  editingHint,
  emptyHint,
  compact = false,
  onSaved,
}: MemoryEditorPanelProps): ReactNode {
  const notify = useToast().notify;
  const memory = useAsync<MemoryDocumentView>(load, [reloadKey]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  // 非编辑状态才跟随服务端数据：编辑中刷新若覆盖 textarea，用户刚写的字会消失。
  useEffect(() => {
    if (!editing && memory.data) setDraft(memory.data.content_md);
  }, [editing, memory.data]);

  const startEdit = (): void => {
    setDraft(memory.data?.content_md ?? '');
    setConflict(null);
    setEditing(true);
  };

  const cancelEdit = (): void => {
    setEditing(false);
    setConflict(null);
  };

  const submit = async (): Promise<void> => {
    if (!memory.data) return;
    setSaving(true);
    setConflict(null);
    try {
      const saved = await save(draft, memory.data.version);
      notify('success', `记忆已保存（v${saved.version}）`);
      setEditing(false);
      memory.reload();
      onSaved?.();
    } catch (cause) {
      // 服务端信封的 code 只有粗粒度枚举（这里是 CONFLICT），细分的
      // MEMORY_VERSION_CONFLICT 放在 message 里（04 §4.11）。两者都要对，
      // 否则冲突会被当成普通错误，草稿保护就失效了。
      if (
        cause instanceof ApiError &&
        cause.code === 'CONFLICT' &&
        cause.message === 'MEMORY_VERSION_CONFLICT'
      ) {
        setConflict(
          '记忆已被其他 agent 或页面更新。你的草稿还在：先复制草稿，再点“载入最新”查看最新内容，合并后重新保存。',
        );
      } else {
        notify('error', `保存记忆失败：${describeError(cause)}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const loadLatest = (): void => {
    setEditing(false);
    setConflict(null);
    memory.reload();
  };

  const lineCount = draft ? draft.split('\n').length : 0;
  const dirty = memory.data ? draft !== memory.data.content_md : draft.length > 0;
  const tooLarge = draft.length > MAX_MEMORY_CHARS;

  return (
    <section
      className={compact ? 'panel project-memory compact' : 'panel project-memory'}
      aria-label={ariaLabel}
    >
      <header className="panel-header">
        <div>
          <h2>{title}</h2>
          <p className="muted small">
            {badge}
            {badge && memory.data ? ' · ' : null}
            {memory.data ? (
              <>
                v{memory.data.version} · {memory.data.line_count} 行
                {memory.data.updated_at ? (
                  <>
                    {' · '}
                    <span title={formatAbsolute(memory.data.updated_at)}>
                      {formatRelative(memory.data.updated_at)}更新
                    </span>
                  </>
                ) : null}
                {memory.data.updated_by ? ` · ${memory.data.updated_by}` : null}
              </>
            ) : null}
          </p>
          {description ? <p className="muted small">{description}</p> : null}
        </div>
        <div className="inline">
          {editing ? (
            <>
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={saving || !dirty || tooLarge}
                onClick={() => void submit()}
              >
                {saving ? '保存中…' : '保存记忆'}
              </button>
              <button type="button" className="btn btn-small btn-ghost" onClick={cancelEdit}>
                取消
              </button>
              {conflict ? (
                <button type="button" className="btn btn-small" onClick={loadLatest}>
                  载入最新（丢弃草稿）
                </button>
              ) : null}
            </>
          ) : (
            <button type="button" className="btn btn-small" onClick={startEdit}>
              {memory.data?.exists ? '编辑' : '写记忆'}
            </button>
          )}
        </div>
      </header>

      {memory.loading && !memory.data ? <Loading label="加载记忆…" /> : null}
      {memory.error ? <ErrorBox message={memory.error} onRetry={memory.reload} /> : null}

      {editing ? (
        <>
          <p className="muted small">{editingHint}</p>
          <textarea
            className="memory-editor"
            rows={compact ? 10 : 16}
            value={draft}
            disabled={saving}
            placeholder={'- [2026-10-24] [deploy] 发布前先备份 db，再跑迁移\n- [auth] 网关白名单未放行时登录接口会 500'}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="inline memory-actions">
            <span className={tooLarge ? 'muted small warn-text' : 'muted small'}>
              {draft.length} / {MAX_MEMORY_CHARS} 字符 · {lineCount} 行
              {tooLarge ? ' · 超出上限，请先清理' : ''}
            </span>
          </div>
          {conflict ? (
            <div className="error-box" role="alert">
              {conflict}
            </div>
          ) : null}
        </>
      ) : memory.data && memory.data.content_md.trim() ? (
        // 与汇报详情共用 reports-content 的排版（白底/同字号/滚动高度），
        // 不再套一层灰色代码块背景：记忆也是给人读的正文，不是调试输出。
        <div className="memory-view reports-content">
          <Markdown source={memory.data.content_md} />
        </div>
      ) : memory.data && !memory.loading ? (
        <p className="muted">{emptyHint}</p>
      ) : null}
    </section>
  );
}
