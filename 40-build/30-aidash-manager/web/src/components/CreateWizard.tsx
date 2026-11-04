import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { CreatePayload, DiscoverResult, HarnessTemplate, Service, ServiceType } from '../types';
import { Badge, Field, Modal, Spinner } from './ui';

interface Props {
  templates: HarnessTemplate[];
  services: Service[];
  onClose: () => void;
  onCreated: (service: Service) => void;
}

type Issue = { key: string; message: string };
type PortProbe = { state: 'idle' | 'checking' | 'free' | 'busy' | 'error'; detail?: string };

const INTEGER_FIELDS: { key: 'poll' | 'lease' | 'heartbeat' | 'commandTimeout'; label: string; min: number }[] = [
  { key: 'poll', label: '轮询间隔', min: 1 },
  { key: 'lease', label: '租约', min: 1 },
  { key: 'heartbeat', label: '心跳', min: 1 },
  { key: 'commandTimeout', label: '命令超时', min: 1 },
];

function splitList(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstRunningAidashUrl(services: Service[]): string {
  const service = services.find(
    (item) => item.type === 'aidash' && ['running', 'external'].includes(item.runtime?.state ?? ''),
  );
  if (!service?.web_url) return 'http://127.0.0.1:8787/mcp';
  return `${service.web_url.replace(/\/+$/, '')}/mcp`;
}

export function CreateWizard({ templates, services, onClose, onCreated }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [type, setType] = useState<ServiceType>('aidash');
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [appDir, setAppDir] = useState('');
  const [discover, setDiscover] = useState<DiscoverResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('8787');
  const [configMode, setConfigMode] = useState<'env' | 'file'>('env');
  const [configPath, setConfigPath] = useState('');
  const [serverEntry, setServerEntry] = useState('');
  const [dbPath, setDbPath] = useState('');
  const [backupDir, setBackupDir] = useState('');
  const [staticDir, setStaticDir] = useState('');

  const [template, setTemplate] = useState('claude');
  const [aidashUrl, setAidashUrl] = useState(() => firstRunningAidashUrl(services));
  const [harnessId, setHarnessId] = useState('');
  const [channels, setChannels] = useState('');
  const [ensureChannel, setEnsureChannel] = useState('');
  const [channelTitle, setChannelTitle] = useState('');
  const [matchAll, setMatchAll] = useState(true);
  const [tags, setTags] = useState('');
  const [titlePrefix, setTitlePrefix] = useState('');
  const [channelKey, setChannelKey] = useState('');
  const [priority, setPriority] = useState('');
  const [kind, setKind] = useState('');
  const [runnerConfigPath, setRunnerConfigPath] = useState('');
  const [runnerEntry, setRunnerEntry] = useState('');
  const [dataDir, setDataDir] = useState('');
  const [logFile, setLogFile] = useState('');
  const [runCwd, setRunCwd] = useState('');
  const [poll, setPoll] = useState('5');
  const [lease, setLease] = useState('900');
  const [heartbeat, setHeartbeat] = useState('60');
  const [gap, setGap] = useState('2');
  const [commandTimeout, setCommandTimeout] = useState('1800');
  const [useExistingConfig, setUseExistingConfig] = useState(false);

  const [token, setToken] = useState('');
  const [tokenSource, setTokenSource] = useState<'manager' | 'env'>('manager');
  const [tokenEnv, setTokenEnv] = useState('AIDASH_TOKEN');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorList, setErrorList] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [portProbe, setPortProbe] = useState<PortProbe>({ state: 'idle' });
  const alertRef = useRef<HTMLDivElement | null>(null);

  const selectedTemplate = templates.find((item) => item.key === template) ?? templates[0];
  const visibleIssues = [...Object.values(fieldErrors), ...errorList];

  function clearFieldError(key: string) {
    setFieldErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function focusAlert() {
    requestAnimationFrame(() => alertRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  // 通道过滤是认领范围，不会建通道；用户只填过滤、没填“创建/复用通道”时，
  // 启动后 AIDash 里看不到通道，会误以为 runner 没工作。这里给一条可见的提醒。
  const concreteChannelFilters = splitList(channels).filter((item) => !item.includes('*'));
  const suggestEnsureChannel = concreteChannelFilters.length > 0 && !ensureChannel.trim();

  const existingConfig = useMemo(() => {
    if (!discover) return false;
    return discover.existing_files.some((file) => {
      const name = file.split(/[\\/]/).pop()?.toLowerCase() ?? '';
      return type === 'aidash' ? name.endsWith('aidash.config.json') : /^aidash-runner.*\.json$/.test(name);
    });
  }, [discover, type]);

  async function runDiscover(nextCwd = cwd) {
    if (!nextCwd.trim()) return;
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const result = await api.discover(nextCwd.trim(), appDir.trim());
      setDiscover(result);
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  }

  useEffect(() => {
    if (!discover) return;
    if (type === 'runner') {
      setRunCwd((current) => current || discover.cwd);
    }
  }, [discover, type]);

  // 端口探测：只在 AIDash 表单里、端口合法时延迟请求，避免每次按键都查。
  useEffect(() => {
    if (type !== 'aidash' || step !== 2) {
      setPortProbe({ state: 'idle' });
      return;
    }
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      setPortProbe({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setPortProbe({ state: 'checking' });
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.checkPort(host.trim() || '127.0.0.1', number);
        if (cancelled) return;
        setPortProbe(
          result.available
            ? { state: 'free' }
            : { state: 'busy', detail: result.reason === 'EADDRINUSE' ? '端口已被占用' : result.reason ?? '端口不可用' },
        );
      } catch (err) {
        if (!cancelled) setPortProbe({ state: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [type, step, host, port]);

  function pickType(next: ServiceType) {
    setType(next);
    setError(null);
    setErrorList([]);
    setFieldErrors({});
  }

  function validate(): Issue[] {
    const issues: Issue[] = [];
    if (!name.trim()) issues.push({ key: 'name', message: '服务名称必填' });
    else if (services.some((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      issues.push({ key: 'name', message: '服务名称已存在，请换一个' });
    }
    if (!cwd.trim()) issues.push({ key: 'cwd', message: '工作目录必填' });
    if (tokenSource === 'manager' && !token.trim()) issues.push({ key: 'token', message: 'AIDASH_TOKEN 必填（或选择“使用环境变量”）' });
    if (tokenSource === 'env' && !tokenEnv.trim()) issues.push({ key: 'tokenEnv', message: '环境变量名必填' });
    if (type === 'aidash') {
      const number = Number(port);
      if (!Number.isInteger(number) || number < 1 || number > 65535) issues.push({ key: 'port', message: '端口必须是 1..65535 的整数' });
      else if (portProbe.state === 'busy') issues.push({ key: 'port', message: portProbe.detail ?? '端口已被占用' });
    } else {
      if (!/^https?:\/\//.test(aidashUrl.trim())) issues.push({ key: 'aidashUrl', message: 'AIDash 地址必须是以 http:// 或 https:// 开头的 URL' });
      if (ensureChannel.trim() && !/^[A-Za-z0-9._~:/-]+$/.test(ensureChannel.trim())) {
        issues.push({ key: 'ensureChannel', message: '创建/复用通道只能包含 ASCII 字母数字与 . _ ~ : / -，且不能有空白' });
      }
      if (channelTitle.trim() && !ensureChannel.trim()) {
        issues.push({ key: 'ensureChannel', message: '填写通道标题时必须同时填写“创建/复用通道”' });
      }
      if (!matchAll) {
        const hasSelector = splitList(tags).length > 0 || titlePrefix.trim() || channelKey.trim() || splitList(priority).length > 0 || splitList(kind).length > 0;
        if (!hasSelector) issues.push({ key: 'match', message: '未选择“匹配全部任务”时，至少填写一个匹配条件' });
      }
      const numericValues = { poll, lease, heartbeat, commandTimeout };
      for (const field of INTEGER_FIELDS) {
        const value = Number(numericValues[field.key]);
        if (!Number.isInteger(value) || value < field.min) {
          issues.push({ key: field.key, message: `${field.label}必须是大于等于 ${field.min} 的整数` });
        }
      }
      const gapValue = Number(gap);
      if (!Number.isFinite(gapValue) || gapValue < 0) issues.push({ key: 'gap', message: '任务间隔必须是非负数字' });
    }
    return issues;
  }

  async function submit() {
    const issues = validate();
    if (issues.length > 0) {
      setFieldErrors(Object.fromEntries(issues.map((issue) => [issue.key, issue.message])));
      setErrorList([]);
      setError(null);
      focusAlert();
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    setError(null);
    setErrorList([]);
    const body: CreatePayload = {
      type,
      name: name.trim(),
      cwd: cwd.trim(),
      token: tokenSource === 'manager' ? token.trim() : undefined,
      spec: {},
    };
    if (type === 'aidash') {
      body.spec = {
        host: host.trim() || '127.0.0.1',
        port: Number(port),
        tokenSource,
        tokenEnv: tokenEnv.trim() || 'AIDASH_TOKEN',
        configMode,
        ...(configPath.trim() ? { configPath: configPath.trim() } : {}),
        ...(appDir.trim() ? { appDir: appDir.trim() } : {}),
        ...(serverEntry.trim() ? { serverEntry: serverEntry.trim() } : {}),
        ...(dbPath.trim() ? { dbPath: dbPath.trim() } : {}),
        ...(backupDir.trim() ? { backupDir: backupDir.trim() } : {}),
        ...(staticDir.trim() ? { staticDir: staticDir.trim() } : {}),
      };
    } else {
      body.spec = {
        template,
        aidashUrl: aidashUrl.trim(),
        ...(harnessId.trim() ? { harnessId: harnessId.trim() } : {}),
        runnerName: name.trim(),
        ...(runnerConfigPath.trim() ? { configPath: runnerConfigPath.trim() } : {}),
        ...(dataDir.trim() ? { dataDir: dataDir.trim() } : {}),
        ...(logFile.trim() ? { logFile: logFile.trim() } : {}),
        ...(runnerEntry.trim() ? { runnerEntry: runnerEntry.trim() } : {}),
        // 留空交给服务端使用服务工作目录；不要把 cwd 再传一遍，
        // 否则相对 cwd 会被二次拼接（<cwd>/<cwd>）。
        ...(runCwd.trim() ? { runCwd: runCwd.trim() } : {}),
        channels: splitList(channels),
        ...(ensureChannel.trim() ? { ensureChannel: ensureChannel.trim() } : {}),
        ...(channelTitle.trim() ? { channelTitle: channelTitle.trim() } : {}),
        match: {
          matchAll,
          tags: splitList(tags),
          titlePrefix: titlePrefix.trim(),
          channelKey: channelKey.trim(),
          priority: splitList(priority),
          kind: splitList(kind),
        },
        pollSeconds: Number(poll),
        leaseSeconds: Number(lease),
        heartbeatSeconds: Number(heartbeat),
        gapSeconds: Number(gap),
        commandTimeoutSeconds: Number(commandTimeout),
        tokenSource,
        tokenEnv: tokenEnv.trim() || 'AIDASH_TOKEN',
      };
      body.useExistingConfig = useExistingConfig;
    }
    try {
      const created = await api.createService(body);
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        const details = err.details as { errors?: string[] } | null;
        setErrorList(details?.errors ?? []);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      focusAlert();
    } finally {
      setSubmitting(false);
    }
  }

  const footer =
    step === 1 ? (
      <div className="row end gap">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn primary" onClick={() => setStep(2)}>
          下一步
        </button>
      </div>
    ) : (
      <div className="row end gap">
        <button type="button" className="btn ghost" onClick={() => setStep(1)} disabled={submitting}>
          上一步
        </button>
        <button type="button" className="btn primary" onClick={submit} disabled={submitting}>
          {submitting ? '创建中…' : '创建服务'}
        </button>
      </div>
    );

  return (
    <Modal
      title="新建服务"
      subtitle={step === 1 ? '选择要管理的服务类型；之后可以随时在配置页调整参数。' : '必填项标 *，不确定的路径可以先点“检测目录”。'}
      wide
      onClose={onClose}
      footer={footer}
    >
      {step === 1 ? (
        <div className="type-picker">
          <button type="button" className={`type-card ${type === 'aidash' ? 'selected' : ''}`} onClick={() => pickType('aidash')}>
            <div className="type-mark type-aidash">A</div>
            <h3>AIDash 服务端</h3>
            <p>管理一个 AIDash 实例：监听端口、数据库、配置文件、Web 地址与日志。为后续级联准备多个实例。</p>
            <ul>
              <li>适合本仓 / 独立部署的 server/dist</li>
              <li>支持环境变量与配置文件两种模式</li>
              <li>启动后可在管理台直接打开 AIDash Web</li>
            </ul>
          </button>
          <button type="button" className={`type-card ${type === 'runner' ? 'selected' : ''}`} onClick={() => pickType('runner')}>
            <div className="type-mark type-runner">R</div>
            <h3>Runner 值守壳</h3>
            <p>管理一个 aidash-runner 实例：连接 AIDash、认领任务、拉起 harness。每个 runner 独立配置与数据目录。</p>
            <ul>
              <li>内置 Claude / Codex / DeepSeek dsh / Narnat 模板</li>
              <li>可配置任务匹配、轮询节奏与工作目录</li>
              <li>状态来自 runner 自己的控制面，不靠猜 PID</li>
            </ul>
          </button>
        </div>
      ) : (
        <div className="wizard-form">
          <div className="wizard-summary">
            <div className={`type-mark type-${type}`}>{type === 'aidash' ? 'A' : 'R'}</div>
            <div>
              <strong>{type === 'aidash' ? 'AIDash 服务端' : 'Runner 值守壳'}</strong>
              <p className="muted small">创建后可随时修改配置；令牌只会保存在本机 0600 权限的文件里。</p>
            </div>
            <button type="button" className="btn ghost sm" onClick={() => setStep(1)}>
              更改类型
            </button>
          </div>

          {(error || visibleIssues.length > 0) ? (
            <div className="alert alert-danger" ref={alertRef} role="alert">
              <strong>{error ?? `请先修正 ${visibleIssues.length} 项`}</strong>
              {visibleIssues.length > 0 ? (
                <ul>
                  {visibleIssues.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <section className="form-section">
            <h3>基础信息</h3>
            <div className="form-grid two">
              <Field label="服务名称" required hint="用于管理台展示，不可与其他服务重名" error={fieldErrors.name}>
                <input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    clearFieldError('name');
                  }}
                  placeholder={type === 'aidash' ? '本机 AIDash' : 'Claude 值守'}
                  aria-invalid={Boolean(fieldErrors.name)}
                  autoFocus
                />
              </Field>
              <Field
                label={type === 'aidash' ? '数据目录' : '工作目录'}
                required
                hint={
                  type === 'aidash'
                    ? '服务进程的 cwd，只放数据：数据库、备份、配置文件都按它解析；程序由管理台提供'
                    : '服务进程的 cwd；runner 的相对路径都按它解析'
                }
                error={fieldErrors.cwd}
              >
                <div className="input-row">
                  <input
                    value={cwd}
                    onChange={(event) => {
                      setCwd(event.target.value);
                      clearFieldError('cwd');
                    }}
                    placeholder="D:\\app\\AIDash\\demodata\\dashdata"
                    aria-invalid={Boolean(fieldErrors.cwd)}
                  />
                  <button type="button" className="btn ghost" onClick={() => runDiscover()} disabled={discovering || !cwd.trim()}>
                    {discovering ? '检测中…' : '检测目录'}
                  </button>
                </div>
              </Field>
              {type === 'aidash' ? (
                <Field label="程序目录" hint="AIDash 安装目录（含 server/dist 或 dist）；留空由管理台从同装程序或已登记服务自动识别">
                  <input
                    value={appDir}
                    onChange={(event) => {
                      setAppDir(event.target.value);
                      setDiscover(null);
                    }}
                    placeholder="留空自动提供（如 D:\\app\\AIDash）"
                  />
                </Field>
              ) : null}
            </div>
            {discoverError ? <div className="alert alert-warn">{discoverError}</div> : null}
            {discover ? (
              <div className="discover-box">
                <div className="row wrap gap-s">
                  <Badge tone={discover.exists ? 'success' : 'danger'}>{discover.exists ? '目录存在' : '目录不存在'}</Badge>
                  {type === 'aidash' ? (
                    <Badge tone={discover.aidash_entry_exists ? 'success' : 'warn'}>
                      {discover.aidash_entry_exists
                        ? `程序已就绪 · 来源 ${discover.aidash_program.source}`
                        : '未找到 AIDash 程序，请指定程序目录'}
                    </Badge>
                  ) : (
                    <Badge tone={discover.runner_entry.exists ? 'success' : 'warn'}>
                      {discover.runner_entry.exists ? '检测到 runner 入口' : '未检测到 runner 入口（将使用 PATH）'}
                    </Badge>
                  )}
                  {discover.existing_files.length > 0 ? (
                    <Badge tone="accent">已有配置：{discover.existing_files.map((file) => file.split(/[\\/]/).pop()).join('、')}</Badge>
                  ) : null}
                </div>
                {type === 'aidash' ? (
                  <div className="small muted mono">
                    {discover.aidash_program.serverEntry || discover.aidash_layout.serverEntry}
                    {discover.aidash_program.appDir ? `（程序目录 ${discover.aidash_program.appDir}）` : ''}
                  </div>
                ) : (
                  <div className="small muted mono">{discover.runner_entry.path ?? '未找到本地 runner 入口'}</div>
                )}
              </div>
            ) : null}
          </section>

          {type === 'aidash' ? (
            <>
              <section className="form-section">
                <h3>监听与存储</h3>
                <div className="form-grid three">
                  <Field label="监听地址" hint="留空默认 127.0.0.1，只监听本机">
                    <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="127.0.0.1" />
                  </Field>
                  <Field label="端口" required hint="多个 AIDash 实例必须不同" error={fieldErrors.port}>
                    <input
                      value={port}
                      onChange={(event) => {
                        setPort(event.target.value);
                        clearFieldError('port');
                      }}
                      inputMode="numeric"
                      placeholder="8787"
                      aria-invalid={Boolean(fieldErrors.port)}
                    />
                    {portProbe.state !== 'idle' && !fieldErrors.port ? (
                      <span className={`probe probe-${portProbe.state}`}>
                        {portProbe.state === 'checking'
                          ? '正在检测端口…'
                          : portProbe.state === 'free'
                            ? `端口 ${port} 可用`
                            : portProbe.state === 'busy'
                              ? portProbe.detail ?? '端口已被占用'
                              : `端口检测失败：${portProbe.detail ?? '未知错误'}`}
                      </span>
                    ) : null}
                  </Field>
                  <Field label="配置模式" hint="环境变量优先于配置文件">
                    <select value={configMode} onChange={(event) => setConfigMode(event.target.value as 'env' | 'file')}>
                      <option value="env">环境变量模式（默认）</option>
                      <option value="file">配置文件模式</option>
                    </select>
                  </Field>
                </div>
              </section>

              <details className="advanced">
                <summary>高级：入口与路径</summary>
                <div className="form-grid two">
                  <Field label="服务端入口" hint="留空由程序目录自动解析；数据目录不会再被当成程序目录">
                    <input value={serverEntry} onChange={(event) => setServerEntry(event.target.value)} placeholder={discover?.aidash_program.serverEntry || '自动检测'} />
                  </Field>
                  <Field label="配置文件路径" hint="文件模式启动时若不存在会自动生成">
                    <input value={configPath} onChange={(event) => setConfigPath(event.target.value)} placeholder="aidash.config.json（相对数据目录）" />
                  </Field>
                  <Field label="SQLite 库路径">
                    <input value={dbPath} onChange={(event) => setDbPath(event.target.value)} placeholder={discover?.aidash_data.dbPath ?? '数据目录/data/aidash.db'} />
                  </Field>
                  <Field label="备份目录">
                    <input value={backupDir} onChange={(event) => setBackupDir(event.target.value)} placeholder={discover?.aidash_data.backupDir ?? '数据目录/backups'} />
                  </Field>
                  <Field label="Web 静态目录" className="span-2">
                    <input value={staticDir} onChange={(event) => setStaticDir(event.target.value)} placeholder={discover?.aidash_program.staticDir || '随程序提供'} />
                  </Field>
                </div>
              </details>
            </>
          ) : (
            <>
              <section className="form-section">
                <h3>Harness 模板</h3>
                <div className="template-grid">
                  {templates.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`template-card ${template === item.key ? 'selected' : ''}`}
                      onClick={() => setTemplate(item.key)}
                    >
                      <div className="row between">
                        <strong>{item.name}</strong>
                        {template === item.key ? <Badge tone="accent">已选择</Badge> : null}
                      </div>
                      <p className="small muted">{item.description}</p>
                      <code className="small">{item.command || '自定义'}</code>
                    </button>
                  ))}
                </div>
                {selectedTemplate ? (
                  <div className="template-detail">
                    <div className="row wrap gap-s">
                      <Badge tone="neutral">安装：{selectedTemplate.install_hint}</Badge>
                      <Badge tone="warn">凭据：{selectedTemplate.credential_hint}</Badge>
                    </div>
                    <pre className="argv-preview">{selectedTemplate.argv.join(' ')}</pre>
                    <ul className="small muted">
                      {selectedTemplate.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>

              <section className="form-section">
                <h3>连接与身份</h3>
                <div className="form-grid two">
                  <Field label="AIDash MCP 地址" required hint="会自动补齐 /mcp；可从已管理的 AIDash 选择" error={fieldErrors.aidashUrl}>
                    <input
                      value={aidashUrl}
                      onChange={(event) => {
                        setAidashUrl(event.target.value);
                        clearFieldError('aidashUrl');
                      }}
                      list="aidash-urls"
                      placeholder="http://127.0.0.1:8787/mcp"
                      aria-invalid={Boolean(fieldErrors.aidashUrl)}
                    />
                    <datalist id="aidash-urls">
                      {services
                        .filter((item) => item.type === 'aidash' && item.web_url)
                        .map((item) => (
                          <option key={item.id} value={`${item.web_url!.replace(/\/+$/, '')}/mcp`}>
                            {item.name}
                          </option>
                        ))}
                    </datalist>
                  </Field>
                  <Field label="harness_id" hint="留空自动生成；同一 AIDash 上必须唯一">
                    <input value={harnessId} onChange={(event) => setHarnessId(event.target.value)} placeholder="claude-myhost" />
                  </Field>
                  <Field label="通道过滤" hint="只决定认领哪些任务，不会创建通道；留空=全部，支持 * 与 prefix/*">
                    <input value={channels} onChange={(event) => setChannels(event.target.value)} placeholder="devhost/myproj/topic" />
                  </Field>
                  <Field
                    label="创建/复用通道（可选）"
                    hint="精确 channel_key；启动 runner 时在 AIDash 中创建或复用该通道（--ensure-channel）"
                    error={fieldErrors.ensureChannel}
                  >
                    <input
                      value={ensureChannel}
                      onChange={(event) => {
                        setEnsureChannel(event.target.value);
                        clearFieldError('ensureChannel');
                      }}
                      placeholder="devhost/myproj/topic"
                      aria-invalid={Boolean(fieldErrors.ensureChannel)}
                    />
                  </Field>
                  <Field label="通道标题（可选）" hint="配合“创建/复用通道”；留空由 AIDash 使用默认标题">
                    <input value={channelTitle} onChange={(event) => setChannelTitle(event.target.value)} placeholder="我的话题" />
                  </Field>
                  {suggestEnsureChannel ? (
                    <div className="alert alert-warn span-2">
                      通道过滤只决定认领哪些任务，不会在 AIDash 里创建通道。若
                      {' '}{concreteChannelFilters.join('、')}{' '}
                      还不存在，请把同一个 key 填入“创建/复用通道”；runner 启动时会执行 channel.upsert。
                    </div>
                  ) : null}
                  <Field label="任务工作目录" hint="harness 子进程的 cwd；默认服务工作目录">
                    <input value={runCwd} onChange={(event) => setRunCwd(event.target.value)} placeholder={cwd || '默认工作目录'} />
                  </Field>
                </div>
              </section>

              <section className="form-section">
                <h3>任务匹配</h3>
                <div className="match-mode">
                  <label className={`radio-card ${matchAll ? 'selected' : ''}`}>
                    <input type="radio" checked={matchAll} onChange={() => { setMatchAll(true); clearFieldError('match'); }} />
                    <div>
                      <strong>匹配全部可认领任务</strong>
                      <p className="small muted">match_all=true。适合专用 runner；同一通道有多个 runner 时会互相抢任务。</p>
                    </div>
                  </label>
                  <label className={`radio-card ${!matchAll ? 'selected' : ''}`}>
                    <input type="radio" checked={!matchAll} onChange={() => { setMatchAll(false); clearFieldError('match'); }} />
                    <div>
                      <strong>按条件匹配</strong>
                      <p className="small muted">至少填写一个条件，避免误跑全部任务。</p>
                    </div>
                  </label>
                </div>
                {fieldErrors.match ? <div className="alert alert-danger">{fieldErrors.match}</div> : null}
                {!matchAll ? (
                  <div className="form-grid three">
                    <Field label="标签" hint="逗号分隔">
                      <input value={tags} onChange={(event) => { setTags(event.target.value); clearFieldError('match'); }} placeholder="aidash-runner-demo" />
                    </Field>
                    <Field label="标题前缀">
                      <input value={titlePrefix} onChange={(event) => { setTitlePrefix(event.target.value); clearFieldError('match'); }} placeholder="[build]" />
                    </Field>
                    <Field label="通道 key">
                      <input value={channelKey} onChange={(event) => { setChannelKey(event.target.value); clearFieldError('match'); }} placeholder="devhost/myproj/topic" />
                    </Field>
                    <Field label="优先级">
                      <input value={priority} onChange={(event) => { setPriority(event.target.value); clearFieldError('match'); }} placeholder="P0,P1" />
                    </Field>
                    <Field label="任务类型">
                      <input value={kind} onChange={(event) => { setKind(event.target.value); clearFieldError('match'); }} placeholder="task,suggestion" />
                    </Field>
                  </div>
                ) : (
                  <div className="alert alert-warn">
                    该 runner 会认领通道内所有未被指派的任务。只建议在专用通道或单 runner 环境使用。
                  </div>
                )}
              </section>

              <details className="advanced" open={existingConfig}>
                <summary>高级：配置与数据目录</summary>
                <div className="form-grid two">
                  <Field label="配置文件路径" hint="默认 aidash-runner.&lt;harness_id&gt;.json">
                    <input value={runnerConfigPath} onChange={(event) => setRunnerConfigPath(event.target.value)} placeholder="aidash-runner.claude-myhost.json" />
                  </Field>
                  <Field label="数据目录" hint="每个 runner 独立；留空使用管理台默认目录">
                    <input value={dataDir} onChange={(event) => setDataDir(event.target.value)} placeholder="（管理台默认）" />
                  </Field>
                  <Field label="日志文件">
                    <input value={logFile} onChange={(event) => setLogFile(event.target.value)} placeholder="（管理台默认）" />
                  </Field>
                  <Field label="runner 入口" hint="留空自动探测；也可填 aidash-runner.mjs 的绝对路径" className="span-2">
                    <input value={runnerEntry} onChange={(event) => setRunnerEntry(event.target.value)} placeholder={discover?.runner_entry.path ?? '自动探测 / PATH 上的 aidash-runner'} />
                  </Field>
                  <Field label="轮询间隔（秒）" error={fieldErrors.poll}>
                    <input value={poll} onChange={(event) => { setPoll(event.target.value); clearFieldError('poll'); }} inputMode="numeric" />
                  </Field>
                  <Field label="租约（秒）" error={fieldErrors.lease}>
                    <input value={lease} onChange={(event) => { setLease(event.target.value); clearFieldError('lease'); }} inputMode="numeric" />
                  </Field>
                  <Field label="心跳（秒）" error={fieldErrors.heartbeat}>
                    <input value={heartbeat} onChange={(event) => { setHeartbeat(event.target.value); clearFieldError('heartbeat'); }} inputMode="numeric" />
                  </Field>
                  <Field label="任务间隔（秒）" error={fieldErrors.gap}>
                    <input value={gap} onChange={(event) => { setGap(event.target.value); clearFieldError('gap'); }} inputMode="decimal" />
                  </Field>
                  <Field label="命令超时（秒）" error={fieldErrors.commandTimeout}>
                    <input value={commandTimeout} onChange={(event) => { setCommandTimeout(event.target.value); clearFieldError('commandTimeout'); }} inputMode="numeric" />
                  </Field>
                </div>
                <label className="checkline">
                  <input type="checkbox" checked={useExistingConfig} onChange={(event) => setUseExistingConfig(event.target.checked)} />
                  复用已存在的 runner 配置文件（读取其中的 harness_id、地址等，不覆盖模板）
                  {existingConfig ? <span className="badge badge-accent">检测到已有配置</span> : null}
                </label>
              </details>
            </>
          )}

          <section className="form-section">
            <h3>访问凭据</h3>
            <div className="form-grid two">
              <Field label="令牌来源" hint="推荐由管理台保存到本机 0600 文件">
                <select value={tokenSource} onChange={(event) => { setTokenSource(event.target.value as 'manager' | 'env'); clearFieldError('token'); clearFieldError('tokenEnv'); }}>
                  <option value="manager">管理台保存（必填令牌）</option>
                  <option value="env">使用管理台进程的环境变量</option>
                </select>
              </Field>
              {tokenSource === 'manager' ? (
                <Field label="AIDASH_TOKEN" required hint="不会回显；保存时只写本机 secrets.json" error={fieldErrors.token}>
                  <input
                    type="password"
                    value={token}
                    onChange={(event) => {
                      setToken(event.target.value);
                      clearFieldError('token');
                    }}
                    placeholder="至少 8 位口令或长随机串"
                    autoComplete="new-password"
                    aria-invalid={Boolean(fieldErrors.token)}
                  />
                </Field>
              ) : (
                <Field label="环境变量名" required hint="启动管理台的终端里必须存在该变量" error={fieldErrors.tokenEnv}>
                  <input
                    value={tokenEnv}
                    onChange={(event) => {
                      setTokenEnv(event.target.value);
                      clearFieldError('tokenEnv');
                    }}
                    placeholder="AIDASH_TOKEN"
                    aria-invalid={Boolean(fieldErrors.tokenEnv)}
                  />
                </Field>
              )}
            </div>
          </section>

          {submitting ? <Spinner label="正在创建并写配置…" /> : null}
        </div>
      )}
    </Modal>
  );
}
