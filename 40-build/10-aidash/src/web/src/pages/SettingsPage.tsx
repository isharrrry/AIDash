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
import type { AsyncState } from '../hooks/useAsync';
import { useAsync } from '../hooks/useAsync';
import { usePolling } from '../hooks/usePolling';
import { harnessPresence } from '../../../shared/harness';
import { formatAbsolute, formatBytes, formatRelative } from '../lib/format';
import { DEFAULT_POLL_MS } from '../lib/polling';
import type { HarnessPresence, HarnessView, HealthView, SettingsView } from '../types';
import { AuditTable } from '../components/AuditTable';
import { EmptyState, ErrorBox, Loading } from '../components/Feedback';
import { LlmSettingsPanel } from '../components/LlmSettingsPanel';
import { MemoryDigestSettingsPanel } from '../components/MemoryDigestSettingsPanel';
import { PromptSettingsPanel } from '../components/PromptSettingsPanel';
import { SettingsTabs } from '../components/SettingsTabs';
import type { SettingsTabItem } from '../components/SettingsTabs';
import { useToast } from '../components/Toast';

type SettingsTabId =
  | 'overview'
  | 'service'
  | 'llm'
  | 'prompts'
  | 'knowledge'
  | 'harness'
  | 'audit';

const SETTINGS_TAB_STORAGE_KEY = 'aidash.settings.tab';
const DEFAULT_SETTINGS_TAB: SettingsTabId = 'overview';

/**
 * 分区顺序按“先看状态、再配服务、最后查记录”排列：
 * 概览和日常排查最靠前，提示词/知识库/Harness/审计依次收纳较重的表单与表格。
 */
const SETTINGS_TABS: ReadonlyArray<SettingsTabItem<SettingsTabId>> = [
  { id: 'overview', label: '概览' },
  { id: 'service', label: '服务参数' },
  { id: 'llm', label: '模型配置' },
  { id: 'prompts', label: '能力提示词' },
  { id: 'knowledge', label: '知识库与记忆' },
  { id: 'harness', label: 'Harness' },
  { id: 'audit', label: '审计日志' },
];

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

/** 从 sessionStorage 恢复分区；无效值（旧版本或手改）回落到概览。 */
function initialTab(): SettingsTabId {
  const stored = window.sessionStorage.getItem(SETTINGS_TAB_STORAGE_KEY);
  return SETTINGS_TABS.some((tab) => tab.id === stored)
    ? (stored as SettingsTabId)
    : DEFAULT_SETTINGS_TAB;
}

/**
 * SCR-05 设置 / 审计 / 健康。
 *
 * 令牌（AIDASH_TOKEN）仍然只走环境变量；第三方 LLM 密钥允许页面写入，
 * 但服务端只存进加密文件、永不回显。其余配置项可以就地编辑。
 *
 * 页面按职责拆成页内分区，只挂载当前分区：四份提示词、LLM 表单与审计查询
 * 都不必在进入设置页时一起初始化。
 */
export function SettingsPage(): ReactElement {
  const notify = useToast().notify;
  const { refreshNonce, refreshAll } = useApp();
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);
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
  usePolling(() => health.reload(), DEFAULT_POLL_MS);
  // 心跳驱动的运行态（运行中/空闲在线）必须自己刷新：只在进页面时加载一次，
  // 用户会一直看到打开页面那一刻的旧状态，把“任务跑着”误判成“离线”。
  // 只在本分区可见时轮询，别让设置页其它分区为一张表持续发请求。
  usePolling(() => harnesses.reload(), DEFAULT_POLL_MS, activeTab === 'harness');

  const refresh = (): void => {
    // 审计查询的状态在 AuditTable 内部，只监听全局刷新计数；这里直接重载
    // 设置/健康/注册表不会让它重新查询，用户会以为刷新按钮在审计分区失灵。
    if (activeTab === 'audit') {
      refreshAll();
      return;
    }
    settings.reload();
    health.reload();
    harnesses.reload();
  };

  const changeTab = (tab: SettingsTabId): void => {
    setActiveTab(tab);
    window.sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, tab);
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
  const tabs = SETTINGS_TABS.map((tab) =>
    tab.id === 'harness' && harnesses.data
      ? { ...tab, badge: String(harnesses.data.length) }
      : tab,
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>设置与运维</h1>
          <p className="muted">健康、服务参数、模型与提示词、知识库、Harness 与审计按分区查看。</p>
        </div>
        <button type="button" className="btn btn-small" onClick={refresh}>
          刷新
        </button>
      </header>

      <SettingsTabs tabs={tabs} active={activeTab} onChange={changeTab}>
        {activeTab === 'overview' ? (
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
            {health.error ? (
              <ErrorBox message={`健康检查失败：${health.error}`} onRetry={health.reload} />
            ) : null}

            {h ? (
              <>
                <div className="health-grid">
                  <Metric label="状态" value={healthStatusText} />
                  <Metric label="数据库大小" value={dbSize} />
                  <Metric label="审计哈希链" value={chainText} />
                  <Metric label="审计链校验时间" value={chainCheckedAt} />
                  <Metric label="等待中请求" value={String(h.waiting_requests ?? '—')} />
                  <Metric label="知识库" value={kbStatus} />
                  <Metric label="运行时长" value={formatUptime(h.uptime_seconds)} />
                  <Metric label="版本" value={h.version ?? '—'} />
                </div>
                <p className="muted small settings-overview-note">
                  数据库路径、Schema 版本等静态参数统一放在「服务参数」；
                  这里只展示运行状态和最近一次审计链校验结果。
                </p>
              </>
            ) : null}
          </section>
        ) : null}

        {activeTab === 'service' ? (
          <SettingsBoundary state={settings}>
            {(data) => (
              <section className="panel" aria-label="服务参数">
                <header className="panel-header">
                  <h2>服务参数</h2>
                  <span className="muted small">
                    服务端启动参数；模型与提示词在各自分区配置
                  </span>
                </header>

                {data.env_overrides.length > 0 ? (
                  <p className="warn-text small" role="status">
                    <strong>配置覆盖提示：</strong>
                    以下键的页面保存值覆盖了同名环境变量——
                    {data.env_overrides
                      .map((item) => `${ENV_OVERRIDE_LABELS[item.key] ?? item.key}（${item.env_var}）`)
                      .join('、')}
                    。页面设置优先，修改环境变量不会生效；这里只提示，不改变现有行为。
                  </p>
                ) : null}

                <div className="settings-sections">
                  <SettingsGroup title="服务端">
                    <SettingRow
                      label="监听地址"
                      value={`${data.server.host}:${data.server.port}`}
                    />
                    <SettingRow
                      label="数据库路径"
                      value={data.server.db_path}
                      className="mono settings-value-path"
                    />
                    <SettingRow label="配置来源" value={data.server.config_source} />
                    <SettingRow label="Schema 版本" value={String(data.server.schema_version)} />
                  </SettingsGroup>

                  <SettingsGroup
                    title="登录凭据"
                    note="凭据只在服务端环境变量 AIDASH_TOKEN 中维护（可以是一句短口令）；页面只显示“已配置/未配置”，不回传明文，也不回传掩码尾号。"
                  >
                    <SettingRow
                      label="访问令牌"
                      value={data.token.configured ? '已配置' : '未配置'}
                    />
                  </SettingsGroup>

                  <SettingsGroup
                    title="保留策略"
                    note="卡片超过保留天数会自动归档。审计表只增不删，这里配置的是“至少保留多久”，服务不会自动删除更早的记录。服务日志写到 stdout/stderr，轮转与清理由外部日志系统负责。"
                  >
                    <SettingRow
                      label="卡片（超期自动归档）"
                      value={`${data.retention.card_days} 天`}
                    />
                    <SettingRow
                      label="审计（最少保留）"
                      value={`${data.retention.audit_days} 天`}
                    />
                    <SettingRow
                      label="日志（外部系统负责）"
                      value={`${data.retention.log_days} 天`}
                    />
                  </SettingsGroup>

                  <SettingsGroup title="服务限制">
                    <SettingRow
                      label="最长等待"
                      value={`${data.limits.max_wait_seconds} 秒`}
                    />
                    <SettingRow label="认领租约" value={`${data.limits.lease_seconds} 秒`} />
                    <SettingRow label="分页上限" value={String(data.limits.page_size_max)} />
                    <SettingRow
                      label="每分钟限流"
                      value={String(data.limits.rate_limit_per_minute)}
                    />
                  </SettingsGroup>
                </div>
              </section>
            )}
          </SettingsBoundary>
        ) : null}

        {activeTab === 'llm' ? (
          <SettingsBoundary state={settings}>
            {(data) => <LlmSettingsPanel settings={data} onSaved={refresh} />}
          </SettingsBoundary>
        ) : null}

        {activeTab === 'prompts' ? (
          <SettingsBoundary state={settings}>
            {(data) => <PromptSettingsPanel settings={data} onSaved={refresh} />}
          </SettingsBoundary>
        ) : null}

        {activeTab === 'knowledge' ? (
          <SettingsBoundary state={settings}>
            {(data) => (
              <>
                <section className="panel" aria-label="知识库配置">
                  <header className="panel-header">
                    <h2>知识库配置</h2>
                    <span className={data.kb.configured ? 'badge result-success' : 'badge'}>
                      {data.kb.configured ? '已启用' : '未配置'}
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
                        disabled={savingKb || !data.kb.configured}
                        onClick={() => void saveKb(null)}
                      >
                        清空配置
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={reindexing || !data.kb.configured}
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

                <MemoryDigestSettingsPanel settings={data} onSaved={refresh} />
              </>
            )}
          </SettingsBoundary>
        ) : null}

        {activeTab === 'harness' ? (
          <section className="panel" aria-label="harness 注册表">
            <header className="panel-header">
              <h2>Harness 注册表</h2>
              <span className="muted small">{harnesses.data?.length ?? 0} 个</span>
            </header>

            {harnesses.loading && !harnesses.data ? <Loading label="加载 harness…" /> : null}
            {harnesses.error ? (
              <ErrorBox
                message={`harness 列表加载失败：${harnesses.error}`}
                onRetry={harnesses.reload}
              />
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
                          <HarnessPresenceBadge harness={harness} />
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
        ) : null}

        {activeTab === 'audit' ? <AuditTable /> : null}
      </SettingsTabs>
    </div>
  );
}

/**
 * 设置类分区共用的加载边界。
 * 保留旧行为：已有成功数据时即使刷新失败也继续显示旧值，只在上面补一条错误提示。
 */
function SettingsBoundary({
  state,
  children,
}: {
  state: AsyncState<SettingsView>;
  children: (settings: SettingsView) => ReactNode;
}): ReactElement {
  return (
    <>
      {state.loading && !state.data ? (
        <section className="panel">
          <Loading label="加载配置…" />
        </section>
      ) : null}
      {state.error ? (
        <section className="panel">
          <ErrorBox message={`配置加载失败：${state.error}`} onRetry={state.reload} />
        </section>
      ) : null}
      {state.data ? children(state.data) : null}
    </>
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

function SettingsGroup({
  title,
  note,
  children,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      <dl>{children}</dl>
      {note ? <p className="muted small">{note}</p> : null}
    </section>
  );
}

function SettingRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}): ReactElement {
  return (
    <>
      <dt>{label}</dt>
      <dd className={className}>{value}</dd>
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

const HARNESS_PRESENCE_META: Record<HarnessPresence, { label: string; hint: string }> = {
  busy: { label: '运行中', hint: '正在执行任务；心跳仍按间隔上报，不会因为阻塞而离线' },
  idle: { label: '空闲在线', hint: '在线轮询，等待任务' },
  offline: { label: '离线', hint: '超过离线阈值没有收到心跳' },
  disabled: { label: '已禁用', hint: '被人工禁用，心跳不会把它改回在线' },
};

/**
 * harness 状态徽章。
 *
 * 优先用服务端派生的 presence（status + busy 的合成结果）；老服务端没有这个
 * 字段时按同样顺序本地降级，避免部署未同步时整列空白。
 */
function HarnessPresenceBadge({ harness }: { harness: HarnessView }): ReactElement {
  const presence = harness.presence ?? harnessPresence(harness);
  const meta = HARNESS_PRESENCE_META[presence];
  return (
    <span className={`badge harness-${presence}`} title={meta.hint}>
      {presence === 'busy' ? <span className="spinner spinner-xs" aria-hidden="true" /> : null}
      {meta.label}
    </span>
  );
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
