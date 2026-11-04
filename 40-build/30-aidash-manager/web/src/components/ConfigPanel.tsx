import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { AidashConfigView, ConfigView, FieldDef, RunnerConfigView, Service } from '../types';
import { Badge, Field, Spinner, Tabs } from './ui';

interface Props {
  service: Service;
  onChanged: () => void | Promise<void>;
  toast: (text: string, tone?: 'success' | 'error' | 'info') => void;
}

type ConfigTab = 'form' | 'raw';

function pretty(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function splitList(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function groupFields(fields: FieldDef[]): { group: string; fields: FieldDef[] }[] {
  const groups = new Map<string, FieldDef[]>();
  for (const field of fields) {
    const list = groups.get(field.group) ?? [];
    list.push(field);
    groups.set(field.group, list);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, fields: list }));
}

function rawValue(raw: Record<string, unknown> | null, key: string): unknown {
  return raw && Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;
}

export function ConfigPanel({ service, onChanged, toast }: Props) {
  const [view, setView] = useState<ConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorList, setErrorList] = useState<string[]>([]);
  const [tab, setTab] = useState<ConfigTab>('form');
  const [saving, setSaving] = useState(false);
  const [raw, setRaw] = useState<Record<string, unknown> | null>(null);
  const [text, setText] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [mode, setMode] = useState<'env' | 'file'>('env');
  const [templateKey, setTemplateKey] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const errorRef = useRef<HTMLDivElement | null>(null);

  function focusError() {
    requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  // AIDash 环境变量模式下的服务定义字段。
  const [envForm, setEnvForm] = useState({
    host: service.aidash?.host ?? '127.0.0.1',
    port: String(service.aidash?.port ?? 8787),
    dbPath: service.aidash?.dbPath ?? '',
    backupDir: service.aidash?.backupDir ?? '',
    staticDir: service.aidash?.staticDir ?? '',
    logLevel: service.aidash?.logLevel ?? 'info',
  });
  const [serviceForm, setServiceForm] = useState({
    name: service.name,
    cwd: service.cwd,
    appDir: service.type === 'aidash' ? (service.aidash?.appDir ?? '') : '',
    tokenSource: (service.type === 'aidash' ? service.aidash?.tokenSource : service.runner?.tokenSource) ?? 'manager',
    tokenEnv: (service.type === 'aidash' ? service.aidash?.tokenEnv : service.runner?.tokenEnv) ?? 'AIDASH_TOKEN',
    entry: (service.type === 'aidash' ? service.aidash?.serverEntry : service.runner?.runnerEntry) ?? '',
  });
  // 通道创建是 runner 的启动参数（--ensure-channel），不属于 runner 配置文件；
  // 放在“服务定义”里编辑，改完重启 runner 即可在 AIDash 创建/复用通道。
  const [runnerChannelForm, setRunnerChannelForm] = useState({
    ensureChannel: service.runner?.ensureChannel ?? '',
    channelTitle: service.runner?.channelTitle ?? '',
  });

  async function load() {
    setLoading(true);
    setError(null);
    setErrorList([]);
    try {
      const result = await api.config(service.id);
      setView(result);
      setRaw(result.file.raw ?? {});
      setText(result.file.text || pretty(result.file.raw ?? {}));
      setConfigPath(result.config_path);
      setMode(result.type === 'aidash' ? result.mode : 'file');
      setTemplateKey(result.type === 'runner' ? (result as RunnerConfigView).template : '');
      setServiceForm({
        name: service.name,
        cwd: service.cwd,
        appDir: service.type === 'aidash' ? (service.aidash?.appDir ?? '') : '',
        tokenSource: (service.type === 'aidash' ? service.aidash?.tokenSource : service.runner?.tokenSource) ?? 'manager',
        tokenEnv: (service.type === 'aidash' ? service.aidash?.tokenEnv : service.runner?.tokenEnv) ?? 'AIDASH_TOKEN',
        entry: (service.type === 'aidash' ? service.aidash?.serverEntry : service.runner?.runnerEntry) ?? '',
      });
      setRunnerChannelForm({
        ensureChannel: service.runner?.ensureChannel ?? '',
        channelTitle: service.runner?.channelTitle ?? '',
      });
      if (result.type === 'aidash') {
        setEnvForm({
          host: service.aidash?.host ?? '127.0.0.1',
          port: String(service.aidash?.port ?? 8787),
          dbPath: service.aidash?.dbPath ?? '',
          backupDir: service.aidash?.backupDir ?? '',
          staticDir: service.aidash?.staticDir ?? '',
          logLevel: service.aidash?.logLevel ?? 'info',
        });
      }
      setWarnings(result.file.warnings ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.id]);

  useEffect(() => {
    if (raw === null) return;
    setText(pretty(raw));
  }, [raw]);

  // 错误提示在面板顶部；等它渲染进 DOM 后再滚动过去，避免用户以为点击没反应。
  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [error]);

  function setRawField(key: string, value: unknown) {
    setRaw((current) => {
      const next = { ...(current ?? {}) };
      if (value === undefined || value === '' || value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  function setMatchField(key: string, value: unknown) {
    setRaw((current) => {
      const next = structuredClone(current ?? {}) as Record<string, unknown>;
      const commands = Array.isArray(next.commands) ? ([...next.commands] as Record<string, unknown>[]) : [];
      if (commands.length === 0) return next;
      const first = { ...commands[0] };
      const match = { ...((first.match as Record<string, unknown>) ?? {}) };
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete match[key];
      else match[key] = value;
      first.match = match;
      commands[0] = first;
      next.commands = commands;
      return next;
    });
  }

  async function saveAidashEnv() {
    setSaving(true);
    setError(null);
    setErrorList([]);
    try {
      await api.updateService(service.id, {
        spec: {
          ...(service.aidash ?? {}),
          host: envForm.host,
          port: Number(envForm.port),
          dbPath: envForm.dbPath,
          backupDir: envForm.backupDir,
          staticDir: envForm.staticDir,
          logLevel: envForm.logLevel,
          configMode: mode,
          configPath: configPath || (service.aidash?.configPath ?? 'aidash.config.json'),
        },
      });
      toast('环境变量模式参数已保存');
      await load();
      await onChanged();
    } catch (err) {
      handleError(err);
    } finally {
      setSaving(false);
    }
  }

  async function saveFile() {
    setSaving(true);
    setError(null);
    setErrorList([]);
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = tab === 'raw' ? (JSON.parse(text) as Record<string, unknown>) : (raw ?? {});
      } catch (err) {
        throw new ApiError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`, 'JSON_INVALID', 400, null);
      }
      const body: Record<string, unknown> = { configPath, config: parsed };
      if (service.type === 'aidash') {
        body.mode = mode;
      }
      const result = await api.saveConfig(service.id, body);
      toast('配置已保存');
      setWarnings(result.warnings ?? []);
      await load();
      await onChanged();
    } catch (err) {
      handleError(err);
    } finally {
      setSaving(false);
    }
  }

  async function saveServiceDefinition() {
    setSaving(true);
    setError(null);
    setErrorList([]);
    try {
      const spec: Record<string, unknown> = {
        tokenSource: serviceForm.tokenSource,
        tokenEnv: serviceForm.tokenEnv,
      };
      if (service.type === 'aidash') {
        spec.appDir = serviceForm.appDir.trim();
        spec.serverEntry = serviceForm.entry.trim();
      } else {
        spec.runnerEntry = serviceForm.entry;
        spec.ensureChannel = runnerChannelForm.ensureChannel.trim();
        spec.channelTitle = runnerChannelForm.channelTitle.trim();
      }
      await api.updateService(service.id, {
        name: serviceForm.name,
        cwd: serviceForm.cwd,
        spec,
      });
      toast('服务定义已保存');
      await load();
      await onChanged();
    } catch (err) {
      handleError(err);
    } finally {
      setSaving(false);
    }
  }

  async function applyTemplate() {
    if (!templateKey) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.applyTemplate(service.id, templateKey);
      toast(`已应用模板 ${templateKey}；命令已替换，其余参数保留`);
      setWarnings(result.warnings ?? []);
      await load();
      await onChanged();
    } catch (err) {
      handleError(err);
    } finally {
      setSaving(false);
    }
  }

  async function switchMode(next: 'env' | 'file') {
    if (service.type !== 'aidash' || next === mode) {
      setMode(next);
      return;
    }
    setMode(next);
    setSaving(true);
    setError(null);
    try {
      await api.saveConfig(service.id, {
        mode: next,
        configPath,
      });
      toast(next === 'file' ? '已切换为配置文件模式' : '已切换为环境变量模式');
      await load();
      await onChanged();
    } catch (err) {
      setMode(next === 'file' ? 'env' : 'file');
      handleError(err);
    } finally {
      setSaving(false);
    }
  }

  /**
   * 常用字段与原始 JSON 共用同一份数据：切页签时把当前编辑内容带过去，
   * 避免用户在两边的修改被另一侧静默覆盖。
   */
  function changeTab(next: ConfigTab) {
    if (next === tab) return;
    if (tab === 'raw' && next === 'form') {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('顶层必须是 JSON 对象');
        }
        setRaw(parsed as Record<string, unknown>);
        setError(null);
        setErrorList([]);
      } catch (err) {
        setError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}；修正后才能切换到常用字段`);
        focusError();
        return;
      }
    } else if (tab === 'form' && next === 'raw') {
      setText(pretty(raw ?? {}));
    }
    setTab(next);
  }

  function handleError(err: unknown) {
    if (err instanceof ApiError) {
      setError(err.message);
      const details = err.details as { errors?: string[]; warnings?: string[] } | null;
      setErrorList(details?.errors ?? []);
      if (details?.warnings?.length) setWarnings(details.warnings);
    } else {
      setError(err instanceof Error ? err.message : String(err));
    }
    focusError();
  }

  const fields = view?.fields ?? [];
  const grouped = useMemo(() => groupFields(fields), [fields]);

  if (loading && !view) {
    return <Spinner label="读取配置…" />;
  }
  if (!view) {
    return <div className="alert alert-danger">{error ?? '读取配置失败'}</div>;
  }

  const fileErrors = view.file.errors ?? [];
  const aidashView = view.type === 'aidash' ? (view as AidashConfigView) : null;
  const runnerView = view.type === 'runner' ? (view as RunnerConfigView) : null;

  return (
    <div className="config-panel">
      <div className="config-head">
        <div>
          <div className="row wrap gap-s">
            <Badge tone={view.file.exists ? 'success' : 'warn'}>{view.file.exists ? '配置文件存在' : '配置文件尚未生成'}</Badge>
            {view.type === 'aidash' ? <Badge tone={mode === 'file' ? 'accent' : 'neutral'}>当前：{mode === 'file' ? '配置文件模式' : '环境变量模式'}</Badge> : null}
            {runnerView ? <Badge tone="neutral">模板：{runnerView.template_detail?.name ?? runnerView.template}</Badge> : null}
          </div>
          <div className="muted small path-line">
            生效设置：{aidashView ? `${aidashView.effective.host}:${aidashView.effective.port}` : runnerView ? runnerView.effective.aidashUrl : ''}
          </div>
        </div>
        <div className="row gap">
          <button type="button" className="btn ghost sm" onClick={() => void load()} disabled={saving}>
            重新读取
          </button>
          {view.type === 'aidash' && mode === 'env' ? (
            <button type="button" className="btn primary sm" onClick={() => void saveAidashEnv()} disabled={saving}>
              {saving ? '保存中…' : '保存环境参数'}
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger" ref={errorRef} role="alert">
          <strong>{error}</strong>
          {errorList.length > 0 ? (
            <ul>
              {errorList.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {view.type === 'aidash' ? (
        <>
          <section className="form-section">
            <h3>生效方式</h3>
            <div className="mode-switch">
              <button type="button" className={`mode-card ${mode === 'env' ? 'selected' : ''}`} onClick={() => void switchMode('env')} disabled={saving}>
                <strong>环境变量模式</strong>
                <span className="small muted">管理台启动时注入 AIDASH_HOST/PORT/DB_PATH 等；环境变量会覆盖文件。</span>
              </button>
              <button type="button" className={`mode-card ${mode === 'file' ? 'selected' : ''}`} onClick={() => void switchMode('file')} disabled={saving}>
                <strong>配置文件模式</strong>
                <span className="small muted">把参数写进 aidash.config.json；启动时不注入同名环境变量。</span>
              </button>
            </div>
            <p className="small muted">点击模式卡片会立即写入服务定义，下次启动服务时生效；不会重启正在运行的进程。</p>
            <div className="form-grid two">
              <Field label="配置文件路径" hint="可改成新的路径；文件不存在时保存会创建">
                <input value={configPath} onChange={(event) => setConfigPath(event.target.value)} />
              </Field>
              <Field label="实际生效" hint={aidashView?.effective.fileError ?? '配置文件中的同名键优先于服务定义只在文件模式下成立'}>
                <div className="effective-box mono small">
                  {aidashView?.effective.host}:{aidashView?.effective.port} · {aidashView?.effective.source}
                </div>
              </Field>
            </div>
            {mode === 'env' ? (
              <div className="form-grid three">
                <Field label="监听地址">
                  <input value={envForm.host} onChange={(event) => setEnvForm({ ...envForm, host: event.target.value })} />
                </Field>
                <Field label="端口">
                  <input value={envForm.port} onChange={(event) => setEnvForm({ ...envForm, port: event.target.value })} inputMode="numeric" />
                </Field>
                <Field label="日志级别">
                  <select value={envForm.logLevel} onChange={(event) => setEnvForm({ ...envForm, logLevel: event.target.value })}>
                    <option value="debug">debug</option>
                    <option value="info">info</option>
                    <option value="warn">warn</option>
                    <option value="error">error</option>
                  </select>
                </Field>
                <Field label="数据库路径" className="span-2">
                  <input value={envForm.dbPath} onChange={(event) => setEnvForm({ ...envForm, dbPath: event.target.value })} />
                </Field>
                <Field label="备份目录">
                  <input value={envForm.backupDir} onChange={(event) => setEnvForm({ ...envForm, backupDir: event.target.value })} />
                </Field>
                <Field label="Web 静态目录" className="span-2">
                  <input value={envForm.staticDir} onChange={(event) => setEnvForm({ ...envForm, staticDir: event.target.value })} />
                </Field>
              </div>
            ) : null}
            {aidashView?.notes?.length ? (
              <ul className="small muted notes">
                {aidashView.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="form-section">
            <div className="row between">
              <h3>配置文件内容</h3>
              <Tabs<ConfigTab>
                tabs={[
                  { key: 'form', label: '常用字段' },
                  { key: 'raw', label: '原始 JSON' },
                ]}
                active={tab}
                onChange={changeTab}
              />
            </div>
            {fileErrors.length > 0 ? (
              <div className="alert alert-danger">
                <strong>配置文件校验未通过</strong>
                <ul>
                  {fileErrors.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {!view.file.exists ? (
              <p className="small muted">配置文件尚未生成；保存后会写入 <code>{configPath}</code>（目录不存在时会先创建）。</p>
            ) : null}
            {tab === 'form' ? (
              <>
                {grouped.map((group) => (
                  <div className="field-group" key={group.group}>
                    <h4>{group.group}</h4>
                    <div className="form-grid three">
                      {group.fields.map((field) => (
                        <ConfigField
                          key={field.key}
                          field={field}
                          raw={raw}
                          onSet={setRawField}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <div className="row end gap">
                  <button type="button" className="btn primary" onClick={() => void saveFile()} disabled={saving}>
                    {saving ? '保存中…' : '保存配置文件'}
                  </button>
                </div>
              </>
            ) : (
              <RawEditor
                text={text}
                onChange={setText}
                onReset={() => setText(pretty(raw ?? {}))}
                onSave={() => void saveFile()}
                saving={saving}
              />
            )}
          </section>
        </>
      ) : null}

      {view.type === 'runner' ? (
        <>
          <section className="form-section">
            <div className="row between wrap gap">
              <h3>Harness 模板</h3>
              <div className="row gap">
                <select value={templateKey} onChange={(event) => setTemplateKey(event.target.value)}>
                  {(runnerView?.templates ?? []).map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn ghost" onClick={() => void applyTemplate()} disabled={saving || !templateKey}>
                  重新应用模板
                </button>
              </div>
            </div>
            <p className="small muted">应用模板只替换 commands 与 capabilities，连接、节奏等其它参数保留；自定义 argv 会被覆盖。</p>
            {runnerView?.template_detail ? (
              <div className="template-detail">
                <div className="row wrap gap-s">
                  <Badge tone="neutral">{runnerView.template_detail.command || '自定义命令'}</Badge>
                  <Badge tone="warn">凭据：{runnerView.template_detail.credential_hint}</Badge>
                </div>
                <pre className="argv-preview">{runnerView.template_detail.argv.join(' ')}</pre>
              </div>
            ) : null}
          </section>

          <section className="form-section">
            <div className="row between">
              <h3>连接与节奏</h3>
              <Tabs<ConfigTab>
                tabs={[
                  { key: 'form', label: '常用字段' },
                  { key: 'raw', label: '原始 JSON' },
                ]}
                active={tab}
                onChange={changeTab}
              />
            </div>
            {fileErrors.length > 0 ? (
              <div className="alert alert-danger">
                <strong>runner 配置校验未通过</strong>
                <ul>
                  {fileErrors.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {!view.file.exists ? (
              <p className="small muted">配置文件尚未生成；保存后会写入 <code>{configPath}</code>（目录不存在时会先创建）。</p>
            ) : null}
            {tab === 'form' ? (
              <>
                {grouped.map((group) => (
                  <div className="field-group" key={group.group}>
                    <h4>{group.group}</h4>
                    <div className="form-grid three">
                      {group.fields.map((field) => (
                        <ConfigField key={field.key} field={field} raw={raw} onSet={setRawField} />
                      ))}
                    </div>
                  </div>
                ))}
                <MatchEditor raw={raw} onSet={setMatchField} />
                <CommandPreview raw={raw} />
                <div className="form-grid two">
                  <Field label="配置文件路径" hint="更改路径后保存会写新文件；目标已存在会拒绝覆盖">
                    <input value={configPath} onChange={(event) => setConfigPath(event.target.value)} />
                  </Field>
                  <Field label="runner 入口">
                    <div className="effective-box mono small">{runnerView?.runner_entry.path ?? '使用 PATH 上的 aidash-runner'}</div>
                  </Field>
                </div>
                <div className="row end gap">
                  <button type="button" className="btn primary" onClick={() => void saveFile()} disabled={saving}>
                    {saving ? '保存中…' : '保存 runner 配置'}
                  </button>
                </div>
              </>
            ) : (
              <RawEditor
                text={text}
                onChange={setText}
                onReset={() => setText(pretty(raw ?? {}))}
                onSave={() => void saveFile()}
                saving={saving}
              />
            )}
          </section>
        </>
      ) : null}

      <section className="form-section">
        <h3>服务定义</h3>
        <div className="form-grid three">
          <Field label="服务名称" required hint="仅影响管理台展示；不能重名">
            <input value={serviceForm.name} onChange={(event) => setServiceForm({ ...serviceForm, name: event.target.value })} />
          </Field>
          <Field
            label={service.type === 'aidash' ? '数据目录' : '工作目录'}
            required
            hint={service.type === 'aidash' ? '只放数据：库、备份、配置文件按它解析' : '修改后请核对入口与相对路径'}
          >
            <input value={serviceForm.cwd} onChange={(event) => setServiceForm({ ...serviceForm, cwd: event.target.value })} />
          </Field>
          {service.type === 'aidash' ? (
            <Field label="程序目录" hint="AIDash 安装目录（含 server/dist 或 dist）；留空由管理台自动提供">
              <input
                value={serviceForm.appDir}
                onChange={(event) => setServiceForm({ ...serviceForm, appDir: event.target.value })}
                placeholder="留空自动提供"
              />
            </Field>
          ) : null}
          <Field
            label={service.type === 'aidash' ? '服务端入口' : 'runner 入口'}
            hint={
              service.type === 'aidash'
                ? `留空由程序目录/管理台解析${service.aidash?.programSource ? `（当前来源：${service.aidash.programSource}）` : ''}`
                : '留空时自动探测'
            }
          >
            <input
              value={serviceForm.entry}
              onChange={(event) => setServiceForm({ ...serviceForm, entry: event.target.value })}
              placeholder={service.type === 'aidash' ? '留空自动提供' : '自动探测 / PATH'}
            />
          </Field>
          {service.type === 'runner' ? (
            <>
              <Field label="创建/复用通道" hint="精确 channel_key；启动 runner 时调 channel.upsert，不是通道过滤">
                <input
                  value={runnerChannelForm.ensureChannel}
                  onChange={(event) => setRunnerChannelForm({ ...runnerChannelForm, ensureChannel: event.target.value })}
                  placeholder="devhost/myproj/topic"
                />
              </Field>
              <Field label="通道标题" hint="配合创建/复用通道，可留空">
                <input
                  value={runnerChannelForm.channelTitle}
                  onChange={(event) => setRunnerChannelForm({ ...runnerChannelForm, channelTitle: event.target.value })}
                  placeholder="我的话题"
                />
              </Field>
            </>
          ) : null}
          <Field label="令牌来源" hint="切换到“管理台保存”后，请到概览页填写令牌">
            <select
              value={serviceForm.tokenSource}
              onChange={(event) => setServiceForm({ ...serviceForm, tokenSource: event.target.value as 'manager' | 'env' })}
            >
              <option value="manager">管理台保存</option>
              <option value="env">环境变量</option>
            </select>
          </Field>
          <Field label="令牌环境变量名">
            <input value={serviceForm.tokenEnv} onChange={(event) => setServiceForm({ ...serviceForm, tokenEnv: event.target.value })} placeholder="AIDASH_TOKEN" />
          </Field>
          <div className="row end gap" style={{ alignSelf: 'end' }}>
            <button type="button" className="btn ghost" onClick={() => void saveServiceDefinition()} disabled={saving}>
              {saving ? '保存中…' : '保存服务定义'}
            </button>
          </div>
        </div>
        <p className="small muted">修改工作目录不会自动改写已保存的绝对路径；配置文件、数据目录与日志位置仍以实际字段为准。</p>
      </section>

      {warnings.length > 0 ? (
        <div className="alert alert-warn">
          <strong>提示</strong>
          <ul>
            {warnings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ConfigField({ field, raw, onSet }: { field: FieldDef; raw: Record<string, unknown> | null; onSet: (key: string, value: unknown) => void }) {
  const value = rawValue(raw, field.key);
  if (field.type === 'boolean') {
    return (
      <Field label={field.label} hint={field.hint}>
        <select value={value === undefined ? '' : String(value)} onChange={(event) => onSet(field.key, event.target.value === '' ? undefined : event.target.value === 'true')}>
          <option value="">默认</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      </Field>
    );
  }
  if (field.enum) {
    return (
      <Field label={field.label} hint={field.hint}>
        <select value={value === undefined ? '' : String(value)} onChange={(event) => onSet(field.key, event.target.value || undefined)}>
          <option value="">默认</option>
          {field.enum.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (field.type === 'array') {
    const list = Array.isArray(value) ? value.join(', ') : value === undefined ? '' : String(value);
    return (
      <Field label={field.label} hint={field.hint}>
        <input value={list} onChange={(event) => onSet(field.key, splitList(event.target.value))} placeholder="逗号分隔" />
      </Field>
    );
  }
  return (
    <Field label={field.label} hint={field.hint}>
      <input
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(event) => {
          const next = event.target.value;
          if (field.type === 'integer' || field.type === 'number') {
            if (next === '') {
              onSet(field.key, undefined);
              return;
            }
            const number = Number(next);
            if (!Number.isFinite(number)) return; // 非法输入不写进 JSON，避免变成 null
            onSet(field.key, number);
            return;
          }
          onSet(field.key, next);
        }}
        inputMode={field.type === 'integer' || field.type === 'number' ? 'numeric' : undefined}
        placeholder={field.default !== undefined ? String(field.default) : ''}
      />
    </Field>
  );
}

function MatchEditor({ raw, onSet }: { raw: Record<string, unknown> | null; onSet: (key: string, value: unknown) => void }) {
  const commands = Array.isArray(raw?.commands) ? (raw.commands as Record<string, unknown>[]) : [];
  const match = (commands[0]?.match as Record<string, unknown> | undefined) ?? {};
  const matchAll = match.match_all === true;
  const tags = Array.isArray(match.tags) ? (match.tags as string[]).join(', ') : '';
  return (
    <div className="field-group">
      <h4>任务匹配（commands[0].match）</h4>
      {commands.length > 1 ? <p className="small muted">检测到 {commands.length} 条命令规则；这里只编辑第一条，其余请在原始 JSON 中修改。</p> : null}
      <div className="match-mode">
        <label className={`radio-card ${matchAll ? 'selected' : ''}`}>
          <input type="radio" checked={matchAll} onChange={() => onSet('match_all', true)} />
          <div>
            <strong>匹配全部可认领任务</strong>
            <p className="small muted">match_all=true</p>
          </div>
        </label>
        <label className={`radio-card ${!matchAll ? 'selected' : ''}`}>
          <input type="radio" checked={!matchAll} onChange={() => onSet('match_all', undefined)} />
          <div>
            <strong>按条件匹配</strong>
            <p className="small muted">至少一个条件</p>
          </div>
        </label>
      </div>
      {!matchAll ? (
        <div className="form-grid three">
          <Field label="标签">
            <input value={tags} onChange={(event) => onSet('tags', splitList(event.target.value))} placeholder="逗号分隔" />
          </Field>
          <Field label="标题前缀">
            <input value={String(match.title_prefix ?? '')} onChange={(event) => onSet('title_prefix', event.target.value)} />
          </Field>
          <Field label="通道 key">
            <input value={String(match.channel_key ?? '')} onChange={(event) => onSet('channel_key', event.target.value)} />
          </Field>
          <Field label="优先级">
            <input value={Array.isArray(match.priority) ? (match.priority as string[]).join(', ') : ''} onChange={(event) => onSet('priority', splitList(event.target.value))} />
          </Field>
          <Field label="任务类型">
            <input value={Array.isArray(match.kind) ? (match.kind as string[]).join(', ') : ''} onChange={(event) => onSet('kind', splitList(event.target.value))} />
          </Field>
        </div>
      ) : (
        <div className="alert alert-warn">match_all=true：该 runner 会认领所有可认领任务。</div>
      )}
    </div>
  );
}

function CommandPreview({ raw }: { raw: Record<string, unknown> | null }) {
  const commands = Array.isArray(raw?.commands) ? (raw.commands as Record<string, unknown>[]) : [];
  if (commands.length === 0) return null;
  return (
    <div className="field-group">
      <h4>命令预览</h4>
      {commands.map((command, index) => {
        const run = (command.run as Record<string, unknown> | undefined) ?? {};
        const argv = Array.isArray(run.argv) ? (run.argv as string[]) : [];
        return (
          <div className="command-preview" key={index}>
            <div className="row between">
              <Badge tone="neutral">{String(command.name ?? `command-${index}`)}</Badge>
              <span className="small muted">{argv.length} 个参数{run.shell ? ' · shell=true' : ''}</span>
            </div>
            <pre>{argv.join(' ')}</pre>
          </div>
        );
      })}
    </div>
  );
}

function RawEditor({
  text,
  onChange,
  onReset,
  onSave,
  saving,
}: {
  text: string;
  onChange: (value: string) => void;
  onReset: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="raw-editor">
      <textarea value={text} onChange={(event) => onChange(event.target.value)} spellCheck={false} rows={22} />
      <div className="row end gap">
        <button type="button" className="btn ghost" onClick={() => {
          try {
            onChange(JSON.stringify(JSON.parse(text), null, 2));
          } catch {
            // 解析失败时保留原文，让用户自己修。
          }
        }}>
          格式化
        </button>
        <button type="button" className="btn ghost" onClick={onReset}>
          重置
        </button>
        <button type="button" className="btn primary" onClick={onSave} disabled={saving}>
          {saving ? '保存中…' : '保存 JSON'}
        </button>
      </div>
    </div>
  );
}
