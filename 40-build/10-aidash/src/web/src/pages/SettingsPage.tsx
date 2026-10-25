import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { describeError } from '../api/client';
import {
  getHealth,
  getSettings,
  listHarnesses,
  reindexKb,
  updateSettings,
} from '../api/endpoints';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import { usePolling } from '../hooks/usePolling';
import { formatAbsolute, formatBytes, formatRelative } from '../lib/format';
import type { HarnessView, HealthView, SettingsView } from '../types';
import { AuditTable } from '../components/AuditTable';
import { EmptyState, ErrorBox, Loading } from '../components/Feedback';
import { LlmSettingsPanel } from '../components/LlmSettingsPanel';
import { MemoryDigestSettingsPanel } from '../components/MemoryDigestSettingsPanel';
import { PromptSettingsPanel } from '../components/PromptSettingsPanel';
import { useToast } from '../components/Toast';

/** 覆盖提示里的键名 → 人话；未知键直接显示原键名，避免新字段被前端吞掉。 */
const ENV_OVERRIDE_LABELS: Record<string, string> = {
  enrichment_enabled: '卡片增强开关',
  enrichment_timeout_ms: 'LLM 超时',
  llm_endpoint: 'LLM 端点',
  llm_model: 'LLM 模型',
  llm_mode: 'LLM 模式',
  kb_root: '知识库根目录',
  card_retention_days: '卡片保留天数',
  audit_min_retention_days: '审计最少保留天数',
  log_retention_days: '日志保留天数',
};

/**
 * SCR-05 设置 / 审计 / 健康。
 *
 * 令牌（AIDASH_TOKEN）仍然只走环境变量；第三方 LLM 密钥允许页面写入，
 * 但服务端只存进加密文件、永不回显。其余配置项可以就地编辑。
 */
export function SettingsPage(): ReactElement {
  const notify = useToast().notify;
  const { refreshNonce } = useApp();
  const [reindexing, setReindexing] = useState(false);
  const [reindexNote, setReindexNote] = useState<string | null>(null);
  // 知识库目录是“就地编辑 + 显式保存”：轮询刷新设置时不能把用户正在输入的草稿冲掉，
  // 所以用 dirty 标记决定是否把服务端值同步回输入框。
  const [kbDraft, setKbDraft] = useState('');
  const [kbDirty, setKbDirty] = useState(false);
  const [savingKb, setSavingKb] = useState(false);

  // refreshNonce 让顶部“刷新”按钮也能刷新本页，而不是只刷新全局通道/健康状态。
  const settings = useAsync<SettingsView>(() => getSettings(), [refreshNonce]);
  const health = useAsync<HealthView>(() => getHealth(), [refreshNonce]);
  const harnesses = useAsync<HarnessView[]>(() => listHarnesses(), [refreshNonce]);
  usePolling(() => health.reload(), 30000);

  const refresh = (): void => {
    settings.reload();
    health.reload();
    harnesses.reload();
  };

  const reindex = async (): Promise<void> => {
    if (!window.confirm('重新索引会扫描 KB 根目录并更新全文索引，可能需要一段时间。确认继续？')) {
      return;
    }
    setReindexing(true);
    setReindexNote(null);
    try {
      const result = await reindexKb();
      const note = summarize(result);
      setReindexNote(note);
      notify('success', '重新索引已完成');
      health.reload();
    } catch (cause) {
      notify('error', `重新索引失败：${describeError(cause)}`);
    } finally {
      setReindexing(false);
    }
  };

  /**
   * 保存知识库根目录。
   *
   * 传 null 表示取消配置并回退到环境变量里的默认值（服务端的 coalesce 规则）；
   * 空字符串同样按“清空”处理，避免用户以为空格是一个合法路径。
   */
  const saveKb = async (value: string | null): Promise<void> => {
    setSavingKb(true);
    try {
      const view = await updateSettings({ kb_root: value });
      setKbDirty(false);
      setKbDraft(view.kb.root ?? '');
      notify('success', value ? '知识库目录已保存' : '知识库配置已清空');
      settings.reload();
      health.reload();
    } catch (cause) {
      notify('error', `保存知识库配置失败：${describeError(cause)}`);
    } finally {
      setSavingKb(false);
    }
  };

  const s = settings.data;

  // 设置加载完成或外部刷新后同步草稿；用户正在编辑（dirty）时不覆盖。
  useEffect(() => {
    if (!kbDirty) setKbDraft(s?.kb.root ?? '');
  }, [s?.kb.root, kbDirty]);
  const h = health.data;
  // 服务端 /api/health 只返回这一种形状；不再为旧文档里的扁平字段做兼容分支。
  const healthHealthy = h?.status === 'ok';
  const healthBroken = h?.status === 'error';
  const dbPath = h?.db.path ?? '—';
  const dbSize = formatBytes(h?.db.size_bytes);
  const chain = h?.audit_chain;
  // 健康检查只返回缓存的校验快照；把“什么时候校验的”一并显示，
  // 否则用户会把“上次校验是完整的”误读成“此刻一定完整”。
  const chainCheckedAt = chain?.checked_at
    ? new Date(chain.checked_at).toLocaleString()
    : '—';
  const chainText = chain
    ? chain.ok
      ? '完整'
      : chain.broken_at !== undefined
        ? `断链（位置 ${chain.broken_at}）`
        : '断链'
    : '—';
  // 知识库状态以设置视图为准：/api/health 不返回 kb 字段。
  const kbStatus = s ? (s.kb.configured ? '已启用' : '未配置') : '—';
  const healthStatusText = healthHealthy ? '正常' : healthBroken ? '异常' : (h?.status ?? '未知');

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>设置与运维</h1>
          <p className="muted">模型配置、能力提示词、健康检查、harness 注册表与审计日志。</p>
        </div>
        <button type="button" className="btn btn-small" onClick={refresh}>
          刷新
        </button>
      </header>

      <section className="panel" aria-label="健康检查">
        <header className="panel-header">
          <h2>健康检查</h2>
          <span
            className={
              healthHealthy
                ? 'badge result-success'
                : healthBroken
                  ? 'badge severity-critical'
                  : 'badge'
            }
          >
            {healthStatusText}
          </span>
        </header>

        {health.loading && !health.data ? <Loading label="检查健康状态…" /> : null}
        {health.error ? <ErrorBox message={`健康检查失败：${health.error}`} onRetry={health.reload} /> : null}

        {h ? (
          <div className="health-grid">
            <Metric label="状态" value={healthStatusText} />
            <Metric label="数据库大小" value={dbSize} />
            <Metric label="数据库路径" value={dbPath} />
            <Metric label="审计哈希链" value={chainText} />
            <Metric label="审计链校验时间" value={chainCheckedAt} />
            <Metric label="等待中请求" value={String(h.waiting_requests ?? '—')} />
            <Metric label="知识库" value={kbStatus} />
            <Metric label="运行时长" value={formatUptime(h.uptime_seconds)} />
            <Metric label="版本" value={h.version ?? '—'} />
            <Metric label="Schema" value={String(s?.server.schema_version ?? '—')} />
          </div>
        ) : null}
      </section>

      <section className="panel" aria-label="服务参数">
        <header className="panel-header">
          <h2>服务参数</h2>
          <span className="muted small">服务端启动参数；模型与提示词在下方单独配置</span>
        </header>

        {settings.loading && !s ? <Loading label="加载配置…" /> : null}
        {settings.error ? <ErrorBox message={`配置加载失败：${settings.error}`} onRetry={settings.reload} /> : null}

        {s ? (
          <div className="settings-sections">
            {s.env_overrides.length > 0 ? (
              <p className="warn-text small" role="status">
                <strong>配置覆盖提示：</strong>
                以下键的页面保存值覆盖了同名环境变量——
                {s.env_overrides
                  .map((item) => `${ENV_OVERRIDE_LABELS[item.key] ?? item.key}（${item.env_var}）`)
                  .join('、')}
                。页面设置优先，修改环境变量不会生效；这里只提示，不改变现有行为。
              </p>
            ) : null}
            <SettingsGroup title="服务端">
              <SettingRow label="监听地址" value={`${s.server.host}:${s.server.port}`} />
              <SettingRow label="数据库" value={s.server.db_path} />
              <SettingRow label="配置来源" value={s.server.config_source} />
              <SettingRow label="Schema 版本" value={String(s.server.schema_version)} />
            </SettingsGroup>

            <SettingsGroup title="登录凭据">
              <SettingRow label="访问令牌" value={s.token.configured ? '已配置' : '未配置'} />
              <p className="muted small">
                凭据只在服务端环境变量 AIDASH_TOKEN 中维护（可以是一句短口令）；
                页面只显示“已配置/未配置”，不回传明文，也不回传掩码尾号。
              </p>
            </SettingsGroup>

            <SettingsGroup title="保留策略">
              <SettingRow label="卡片（超期自动归档）" value={`${s.retention.card_days} 天`} />
              <SettingRow label="审计（最少保留）" value={`${s.retention.audit_days} 天`} />
              <SettingRow label="日志（外部系统负责）" value={`${s.retention.log_days} 天`} />
              <p className="muted small">
                卡片超过保留天数会自动归档。审计表只增不删，这里配置的是“至少保留多久”，
                服务不会自动删除更早的记录。服务日志写到 stdout/stderr，
                轮转与清理由外部日志系统负责。
              </p>
            </SettingsGroup>

            <SettingsGroup title="服务限制">
              <SettingRow label="最长等待" value={`${s.limits.max_wait_seconds} 秒`} />
              <SettingRow label="认领租约" value={`${s.limits.lease_seconds} 秒`} />
              <SettingRow label="分页上限" value={String(s.limits.page_size_max)} />
              <SettingRow label="每分钟限流" value={String(s.limits.rate_limit_per_minute)} />
            </SettingsGroup>
          </div>
        ) : null}
      </section>

      {s ? <LlmSettingsPanel settings={s} onSaved={refresh} /> : null}
      {s ? <PromptSettingsPanel settings={s} onSaved={refresh} /> : null}

      <section className="panel" aria-label="知识库配置">
        <header className="panel-header">
          <h2>知识库配置</h2>
          <span className={s?.kb.configured ? 'badge result-success' : 'badge'}>
            {s?.kb.configured ? '已启用' : '未配置'}
          </span>
        </header>

        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void saveKb(kbDraft.trim() || null);
          }}
        >
          <label className="field">
            <span>KB 根目录（绝对路径）</span>
            <input
              value={kbDraft}
              placeholder="例如 F:\\docs\\knowledge"
              onChange={(event) => {
                setKbDirty(true);
                setKbDraft(event.target.value);
              }}
            />
          </label>
          <div className="inline wrap">
            <button
              type="submit"
              className="btn btn-small"
              disabled={savingKb || !kbDraft.trim()}
            >
              {savingKb ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={savingKb || !s?.kb.configured}
              onClick={() => void saveKb(null)}
            >
              清空配置
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={reindexing || !s?.kb.configured}
              onClick={() => void reindex()}
            >
              {reindexing ? '索引中…' : '重新索引'}
            </button>
          </div>
          <p className="muted small">
            只读索引：只扫描该目录下的 Markdown，不会写入或删除原文件。
            保存后立即生效；首次配置或目录内容变化后点“重新索引”。
          </p>
          {reindexNote ? <pre className="detail-json">{reindexNote}</pre> : null}
        </form>
      </section>

      {s ? <MemoryDigestSettingsPanel settings={s} onSaved={refresh} /> : null}

      <section className="panel" aria-label="harness 注册表">
        <header className="panel-header">
          <h2>Harness 注册表</h2>
          <span className="muted small">{harnesses.data?.length ?? 0} 个</span>
        </header>

        {harnesses.loading && !harnesses.data ? <Loading label="加载 harness…" /> : null}
        {harnesses.error ? (
          <ErrorBox message={`harness 列表加载失败：${harnesses.error}`} onRetry={harnesses.reload} />
        ) : null}

        {harnesses.data && harnesses.data.length === 0 ? (
          <EmptyState
            title="还没有 harness 注册"
            hint="harness 启动时应调用 harness.register；注册后任务认领和心跳才会出现在这里。"
          />
        ) : null}

        {harnesses.data && harnesses.data.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>harness_id</th>
                  <th>名称</th>
                  <th>主机</th>
                  <th>状态</th>
                  <th>最后心跳</th>
                  <th>能力</th>
                </tr>
              </thead>
              <tbody>
                {harnesses.data.map((harness) => (
                  <tr key={harness.harness_id}>
                    <td>
                      <code>{harness.harness_id}</code>
                    </td>
                    <td>{harness.name}</td>
                    <td>{harness.host ?? '—'}</td>
                    <td>
                      <span className={`badge harness-${harness.status}`}>{harness.status}</span>
                    </td>
                    <td title={formatAbsolute(harness.last_seen)}>
                      {formatRelative(harness.last_seen)}
                    </td>
                    <td>
                      {capabilitiesOf(harness).length > 0 ? (
                        <div className="tag-list">
                          {capabilitiesOf(harness).map((capability) => (
                            <span key={capability} className="tag">
                              {capability}
                            </span>
                          ))}
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <AuditTable />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="metric">
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

function SettingRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </>
  );
}

function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

/** capabilities 可能在数组字段，也可能还在 capabilities_json 里；两者都安全读取。 */
function capabilitiesOf(harness: HarnessView): string[] {
  if (Array.isArray(harness.capabilities)) {
    return harness.capabilities.filter((item): item is string => typeof item === 'string');
  }
  if (!harness.capabilities_json) return [];
  try {
    const parsed: unknown = JSON.parse(harness.capabilities_json);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
    return [String(parsed)];
  } catch {
    return [harness.capabilities_json];
  }
}

/** 把 reindex 的未知响应收成可读文本，最多 500 字，避免把大 JSON 塞进页面。 */
function summarize(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '服务端未返回详情';
  try {
    return JSON.stringify(value, null, 2).slice(0, 500);
  } catch {
    return String(value);
  }
}
