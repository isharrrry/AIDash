import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { describeError } from '../api/client';
import { testLlm, updateSettings } from '../api/endpoints';
import type { LlmMode, LlmTestView, SettingsView } from '../types';
import { useToast } from './Toast';

/**
 * 页面密钥「解不开」的原因码 → 人话。
 * 只做展示映射：真实的排查细节留在服务端日志，前端不猜测、不展示任何密钥片段。
 */
const KEY_ERROR_TEXT: Record<string, string> = {
  master_key_missing: '主密钥文件 master.key 缺失',
  master_key_invalid: '主密钥文件 master.key 损坏（长度不对或读不出来）',
  decrypt_failed: '密文与当前主密钥不匹配（可能换过钥匙或文件被改坏）',
  secrets_file_invalid: '密钥文件 secrets.json 已损坏',
};

const MODE_OPTIONS: Array<{ value: LlmMode; label: string; hint: string }> = [
  { value: 'fast', label: 'fast', hint: '最快、最省：适合短卡片分析' },
  { value: 'standard', label: 'standard', hint: '平衡：日常分析/归纳' },
  { value: 'max', label: 'max', hint: '最大输出预算：长文与复杂卡片（默认）' },
];

/**
 * LLM 连接配置。
 *
 * 页面允许写 API Key，但服务端只把它写进 `~/.aidash/secrets.json`（AES-256-GCM），
 * 不并入 SQLite 设置、不出现在任何响应里。因此这里输入框永远从空开始：
 * “已配置”只代表服务端有密钥，页面拿不到也不需要拿到明文。
 *
 * 读取优先级是“页面密钥 > 环境变量”：用户清空页面密钥后，环境变量仍会兜底，
 * 所以状态里要区分 key_source，避免用户误以为清空就彻底停用了模型。
 */
export function LlmSettingsPanel({
  settings,
  onSaved,
}: {
  settings: SettingsView;
  onSaved: () => void;
}): ReactElement {
  const notify = useToast().notify;
  const llm = settings.enrichment.llm;
  const [endpoint, setEndpoint] = useState(llm.endpoint ?? '');
  const [model, setModel] = useState(llm.model ?? '');
  const [mode, setMode] = useState<LlmMode>(llm.mode);
  const [enabled, setEnabled] = useState(settings.enrichment.enabled);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestView | null>(null);

  const dirty =
    endpoint.trim() !== (llm.endpoint ?? '') ||
    model.trim() !== (llm.model ?? '') ||
    mode !== llm.mode ||
    enabled !== settings.enrichment.enabled ||
    apiKey.trim().length > 0;

  // 保存/外部刷新后同步草稿；用户正在输入（dirty）时不覆盖。
  useEffect(() => {
    if (dirty) return;
    setEndpoint(llm.endpoint ?? '');
    setModel(llm.model ?? '');
    setMode(llm.mode);
    setEnabled(settings.enrichment.enabled);
  }, [llm.endpoint, llm.model, llm.mode, settings.enrichment.enabled, dirty]);

  const save = async (extra: { llm_api_key?: string | null } = {}): Promise<void> => {
    setSaving(true);
    setTestResult(null);
    try {
      await updateSettings({
        enrichment_enabled: enabled,
        llm_endpoint: endpoint.trim() || null,
        llm_model: model.trim() || null,
        llm_mode: mode,
        ...(apiKey.trim() ? { llm_api_key: apiKey.trim() } : {}),
        ...extra,
      });
      setApiKey('');
      notify('success', 'LLM 配置已保存');
      onSaved();
    } catch (cause) {
      notify('error', `保存 LLM 配置失败：${describeError(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testLlm();
      setTestResult(result);
      notify('success', `连接正常（${result.latency_ms} ms）`);
    } catch (cause) {
      notify('error', `连接测试失败：${describeError(cause)}`);
    } finally {
      setTesting(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    if (!window.confirm('清空页面保存的 API Key？环境变量里的密钥仍会继续生效。')) return;
    await save({ llm_api_key: null });
  };

  const keySourceText =
    llm.key_source === 'file'
      ? '页面保存（加密文件）'
      : llm.key_source === 'env'
        ? '环境变量'
        : '未配置';

  // 「配过但解不开」必须单独喊出来：它和「没配」看起来都是没有可用密钥，
  // 但处置完全不同——前者要找回/重设，后者只要粘贴一个。
  const keyStateWarning =
    llm.key_state === 'unreadable'
      ? `页面保存的密钥当前无法解密：${KEY_ERROR_TEXT[llm.key_error ?? ''] ?? '原因未知'}。增强分析不会使用它。请重新粘贴密钥，或恢复 master.key 后重启。`
      : null;

  return (
    <section className="panel" aria-label="LLM 配置">
      <header className="panel-header">
        <div>
          <h2>LLM 配置</h2>
          <p className="muted small">
            默认 DeepSeek（deepseek-flash / max）。保存后立即生效，不需要重启服务。
          </p>
        </div>
        <span className={llm.configured ? 'badge result-success' : 'badge'}>
          {llm.configured ? '已就绪' : '未配置'}
        </span>
      </header>

      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>API 端点</span>
          <input
            value={endpoint}
            placeholder="https://api.deepseek.com/v1/chat/completions"
            onChange={(event) => setEndpoint(event.target.value)}
          />
          <span className="muted small">
            可填完整 `/chat/completions`，也可只填 base（如 `https://api.deepseek.com/v1`）。
          </span>
        </label>

        <div className="inline wrap">
          <label className="field grow">
            <span>模型</span>
            <input
              value={model}
              placeholder="deepseek-flash"
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <label className="field">
            <span>模式</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as LlmMode)}>
              {MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} — {option.hint}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>启用卡片增强分析（关闭后不再调用模型；手动记忆归纳仍可用）</span>
        </label>

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            placeholder={
              llm.key_state === 'unreadable'
                ? '页面密钥已失效，重新粘贴即可覆盖'
                : llm.has_api_key
                  ? '已配置；留空表示不修改'
                  : '粘贴密钥后保存即可使用'
            }
            onChange={(event) => setApiKey(event.target.value)}
          />
          <span className="muted small">
            来源：{keySourceText} · 加密文件：<code>{llm.key_path}</code>
          </span>
          {keyStateWarning ? (
            <span className="warn-text small" role="alert">
              {keyStateWarning}
            </span>
          ) : null}
        </label>

        <div className="inline wrap">
          <button type="submit" className="btn btn-primary btn-small" disabled={saving || !dirty}>
            {saving ? '保存中…' : '保存配置'}
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={testing || dirty || !llm.configured}
            title={dirty ? '先保存再测试，避免测的是旧配置' : undefined}
            onClick={() => void runTest()}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={saving || llm.key_source !== 'file'}
            onClick={() => void clearKey()}
          >
            清空页面密钥
          </button>
        </div>

        <p className="muted small">
          知识库建议：
          {settings.enrichment.kb_suggestion_ready
            ? '已就绪（KB + 模型 + 增强开关）'
            : '未就绪'}
          ；增强分析总开关为{settings.enrichment.enabled ? '开启' : '关闭'}。
        </p>

        {testResult ? (
          <div className="llm-test-result" role="status">
            <strong>连接正常</strong>
            <span className="muted small">
              {testResult.latency_ms} ms · {testResult.model} · {testResult.mode}
            </span>
            {testResult.reply ? (
              <p className="muted small">模型回复：{testResult.reply}</p>
            ) : null}
          </div>
        ) : null}
      </form>
    </section>
  );
}
