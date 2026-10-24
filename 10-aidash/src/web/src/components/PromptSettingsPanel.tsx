import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { describeError } from '../api/client';
import { updateSettings } from '../api/endpoints';
import type { PromptKey, SettingsView } from '../types';
import { useToast } from './Toast';

/** 服务端 assertPrompt 的上限；页面提前拦一下，避免整批保存时才报错。 */
const MAX_PROMPT_CHARS = 8000;

function draftsFrom(settings: SettingsView): Record<PromptKey, string> {
  const entries = settings.prompts.map((prompt) => [prompt.key, prompt.system] as const);
  return Object.fromEntries(entries) as Record<PromptKey, string>;
}

/**
 * 四类能力提示词。
 *
 * 为什么一次保存全部：服务端按“合并后的完整对象”校验，逐条保存反而会让
 * 中途失败的几条留在半更新状态；页面上先把草稿都编辑好，再一次性提交。
 *
 * “恢复默认”只改本地草稿，不立即写服务端：用户可能想先看看默认文案再决定，
 * 也可能一次恢复多个能力后统一保存。
 */
export function PromptSettingsPanel({
  settings,
  onSaved,
}: {
  settings: SettingsView;
  onSaved: () => void;
}): ReactElement {
  const notify = useToast().notify;
  const [drafts, setDrafts] = useState<Record<PromptKey, string>>(() => draftsFrom(settings));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // 外部刷新/保存成功后同步；用户有未保存草稿时不覆盖。
  useEffect(() => {
    if (dirty) return;
    setDrafts(draftsFrom(settings));
  }, [settings, dirty]);

  const update = (key: PromptKey, value: string): void => {
    setDirty(true);
    setDrafts((current) => ({ ...current, [key]: value }));
  };

  const reset = (key: PromptKey, value: string): void => {
    setDirty(true);
    setDrafts((current) => ({ ...current, [key]: value }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await updateSettings({ prompts: drafts });
      setDirty(false);
      notify('success', '提示词已保存');
      onSaved();
    } catch (cause) {
      notify('error', `保存提示词失败：${describeError(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  const tooLarge = Object.values(drafts).some((value) => value.length > MAX_PROMPT_CHARS);
  const empty = Object.values(drafts).some((value) => value.trim().length === 0);

  return (
    <section className="panel" aria-label="能力提示词">
      <header className="panel-header">
        <div>
          <h2>能力提示词</h2>
          <p className="muted small">
            四种能力各有一套系统提示词；默认值已经可用，改坏可单条恢复。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={saving || !dirty || tooLarge || empty}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存全部'}
        </button>
      </header>

      {empty ? (
        <p className="muted small warn-text">提示词不能为空；不需要某项能力时请保留默认文案。</p>
      ) : null}

      <div className="prompt-list">
        {settings.prompts.map((prompt) => {
          const draft = drafts[prompt.key] ?? '';
          const changed = draft !== prompt.default_system;
          return (
            <article key={prompt.key} className="prompt-item">
              <header className="prompt-item-header">
                <div>
                  <h3>
                    {prompt.label} <code className="muted small">{prompt.key}</code>
                    {changed ? <span className="badge badge-leftover">已修改</span> : null}
                  </h3>
                  <p className="muted small">{prompt.description}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  disabled={saving || draft === prompt.default_system}
                  onClick={() => reset(prompt.key, prompt.default_system)}
                >
                  恢复默认
                </button>
              </header>
              <textarea
                className="prompt-editor"
                rows={7}
                value={draft}
                disabled={saving}
                onChange={(event) => update(prompt.key, event.target.value)}
              />
              <span
                className={
                  draft.length > MAX_PROMPT_CHARS ? 'muted small warn-text' : 'muted small'
                }
              >
                {draft.length} / {MAX_PROMPT_CHARS} 字符
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
}
