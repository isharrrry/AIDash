import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { describeError } from '../api/client';
import { updateSettings } from '../api/endpoints';
import type { SettingsView } from '../types';
import { useToast } from './Toast';

/**
 * 自动记忆归纳的节奏设置。
 *
 * 真正的“立即归纳”放在记忆页（针对某个项目），这里只控制后台定时器：
 * 多久检查一次、回看多少天的素材。关闭后定时器不再调用模型，
 * 但手动归纳仍可用——用户想临时整理一次不该被开关挡住。
 */
export function MemoryDigestSettingsPanel({
  settings,
  onSaved,
}: {
  settings: SettingsView;
  onSaved: () => void;
}): ReactElement {
  const notify = useToast().notify;
  const digest = settings.memory_digest;
  const [enabled, setEnabled] = useState(digest.enabled);
  const [intervalHours, setIntervalHours] = useState(String(digest.interval_hours));
  const [windowDays, setWindowDays] = useState(String(digest.window_days));
  const [saving, setSaving] = useState(false);

  const intervalValue = Number(intervalHours);
  const windowValue = Number(windowDays);
  const dirty =
    enabled !== digest.enabled ||
    intervalValue !== digest.interval_hours ||
    windowValue !== digest.window_days;
  const invalid =
    !Number.isInteger(intervalValue) ||
    intervalValue < 1 ||
    intervalValue > 168 ||
    !Number.isInteger(windowValue) ||
    windowValue < 1 ||
    windowValue > 90;

  useEffect(() => {
    if (dirty) return;
    setEnabled(digest.enabled);
    setIntervalHours(String(digest.interval_hours));
    setWindowDays(String(digest.window_days));
  }, [digest.enabled, digest.interval_hours, digest.window_days, dirty]);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await updateSettings({
        memory_digest_enabled: enabled,
        memory_digest_interval_hours: intervalValue,
        memory_digest_window_days: windowValue,
      });
      notify('success', '记忆归纳设置已保存');
      onSaved();
    } catch (cause) {
      notify('error', `保存记忆归纳设置失败：${describeError(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel" aria-label="自动记忆归纳">
      <header className="panel-header">
        <div>
          <h2>自动记忆归纳</h2>
          <p className="muted small">
            后台按项目整理最近的卡片与任务，只写“长期约束 / 反复踩的坑 / 稳定偏好”，最多 5 行。
          </p>
        </div>
        <span className={enabled ? 'badge result-success' : 'badge'}>
          {enabled ? '已开启' : '已关闭'}
        </span>
      </header>

      <div className="stack">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            开启定时归纳（需要先配置 LLM；模型不可用时会记录一次失败原因，不推进时间窗）
          </span>
        </label>

        <div className="inline wrap">
          <label className="field">
            <span>检查间隔（小时，1~168）</span>
            <input
              type="number"
              min={1}
              max={168}
              value={intervalHours}
              onChange={(event) => setIntervalHours(event.target.value)}
            />
          </label>
          <label className="field">
            <span>回看窗口（天，1~90）</span>
            <input
              type="number"
              min={1}
              max={90}
              value={windowDays}
              onChange={(event) => setWindowDays(event.target.value)}
            />
          </label>
        </div>

        <div className="inline">
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={saving || !dirty || invalid}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存设置'}
          </button>
          <span className="muted small">
            素材少于 3 条时不会调用模型；手动归纳不受此开关限制。
          </span>
        </div>
        {invalid ? (
          <p className="muted small warn-text">间隔需为 1~168 的整数，窗口需为 1~90 的整数。</p>
        ) : null}
      </div>
    </section>
  );
}
