export type ServiceType = 'aidash' | 'runner';
export type RuntimeState = 'running' | 'stopped' | 'starting' | 'unresponsive' | 'external' | 'error';

export interface ManagerInfo {
  version: string;
  home: string;
  host: string;
  port: number;
  started_at: string;
  uptime_ms: number;
  node: string;
  platform: string;
}

export interface Runtime {
  state: RuntimeState;
  alive: boolean;
  pid: number | null;
  pid_alive?: boolean;
  url: string | null;
  aidash_url?: string | null;
  health?: unknown;
  started_at?: string | null;
  uptime_ms?: number | null;
  detail: string;
  last_exit?: { code?: number | null; signal?: string | null; at?: string } | null;
  last_error?: string | null;
  config_error?: string | null;
  log_file?: string | null;
  host?: string;
  port?: number;
  instance_id?: string;
  data_dir?: string;
  config_path?: string;
  current_task?: { id?: string; title?: string } | null;
  last_poll_at?: string | null;
  busy?: boolean;
  stats?: Record<string, number> | null;
}

export interface AidashSpec {
  host: string;
  port: number;
  tokenSource: 'manager' | 'env';
  tokenEnv: string;
  /** 程序目录：管理台从这里解析服务端入口；与服务数据目录分离。 */
  appDir?: string;
  serverEntry: string;
  /** 入口来源：explicit / appDir / env / cwd / manager / service:名称 / missing。 */
  programSource?: string;
  programKey?: string;
  programMatched?: boolean;
  configMode: 'env' | 'file';
  configPath: string;
  dbPath: string;
  backupDir: string;
  staticDir: string;
  logLevel: string;
  env: Record<string, string>;
  layoutKey?: string;
  layoutMatched?: boolean;
  hasToken?: boolean;
}

export interface RunnerMatch {
  matchAll: boolean;
  tags: string[];
  titlePrefix: string;
  channelKey: string;
  priority: string[];
  kind: string[];
}

export interface RunnerSpec {
  template: string;
  aidashUrl: string;
  harnessId: string;
  runnerName: string;
  configPath: string;
  dataDir: string;
  logFile: string;
  runCwd: string;
  channels: string[];
  /** 精确通道 key：runner 启动时调 channel.upsert 创建/复用；为空表示不创建。 */
  ensureChannel?: string;
  /** 配合 ensureChannel 的通道标题，可空。 */
  channelTitle?: string;
  match: RunnerMatch;
  pollSeconds: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  gapSeconds: number;
  commandTimeoutSeconds: number;
  tokenSource: 'manager' | 'env';
  tokenEnv: string;
  runnerEntry: string | null;
  env: Record<string, string>;
  capabilities: string[];
  hasToken?: boolean;
  runnerEntryDetected?: {
    path: string | null;
    command: string;
    args_prefix: string[];
    explicit: boolean;
    exists: boolean;
  };
}

export interface LogFileRef {
  key: string;
  label: string;
  path: string;
}

export interface Service {
  id: string;
  type: ServiceType;
  name: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  aidash: AidashSpec | null;
  runner: RunnerSpec | null;
  runtime: Runtime | null;
  web_url: string | null;
  log_files: LogFileRef[];
}

export interface ManagerState {
  manager: ManagerInfo;
  services: Service[];
  templates: HarnessTemplate[];
}

export interface HarnessTemplate {
  key: string;
  name: string;
  command: string;
  description: string;
  install_hint: string;
  credential_hint: string;
  argv: string[];
  result_file: string;
  capability: string;
  notes: string[];
}

export interface FieldDef {
  group: string;
  key: string;
  label: string;
  type: string;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  enum?: string[];
  hint?: string;
}

export interface ConfigFileView {
  exists: boolean;
  raw: Record<string, unknown> | null;
  text: string;
  errors: string[];
  warnings?: string[];
}

export interface AidashConfigView {
  type: 'aidash';
  mode: 'env' | 'file';
  config_path: string;
  file: ConfigFileView;
  effective: {
    host: string;
    port: number;
    dbPath: string;
    backupDir: string;
    staticDir: string;
    logLevel: string;
    configPath: string;
    configMode: string;
    source: string;
    fileError: string | null;
  };
  fields: FieldDef[];
  env_values: Record<string, unknown>;
  notes: string[];
}

export interface RunnerConfigView {
  type: 'runner';
  config_path: string;
  file: ConfigFileView;
  effective: {
    configPath: string;
    harnessId: string;
    instanceId: string;
    dataDir: string;
    logFile: string;
    aidashUrl: string;
    source: string;
    fileError: string | null;
  };
  fields: FieldDef[];
  template: string;
  template_detail: HarnessTemplate | null;
  templates: HarnessTemplate[];
  runner_entry: {
    path: string | null;
    command: string;
    args_prefix: string[];
    explicit: boolean;
    exists: boolean;
  };
  env_values: Record<string, unknown>;
}

export type ConfigView = AidashConfigView | RunnerConfigView;

export interface LogResult {
  source: string;
  files: LogFileRef[];
  exists: boolean;
  path: string;
  lines: string[];
  truncated: boolean;
  size: number;
}

export interface ErrorGroup {
  signature: string;
  severity: 'error' | 'warn';
  count: number;
  first_line: number;
  last_line: number;
  samples: { line: number; text: string }[];
}

export interface ErrorSummary {
  exists: boolean;
  files: { path: string; exists: boolean; error_count?: number; warn_count?: number }[];
  error_count: number;
  warn_count: number;
  groups: ErrorGroup[];
  items: { line: number; severity: string; text: string; file?: string }[];
}

export interface PortCheck {
  host: string;
  port: number;
  available: boolean;
  reason: string | null;
}

export interface DiscoverResult {
  cwd: string;
  exists: boolean;
  aidash_layout: {
    key: string;
    serverEntry: string;
    staticDir: string;
    dbPath: string;
    backupDir: string;
    matched: boolean;
  };
  aidash_program: {
    key: string;
    appDir: string;
    serverEntry: string;
    staticDir: string;
    source: string;
    matched: boolean;
    searched?: string[];
  };
  aidash_data: {
    key: string;
    dbPath: string;
    backupDir: string;
  };
  aidash_entry_exists: boolean;
  runner_entry: {
    path: string | null;
    command: string;
    args_prefix: string[];
    explicit: boolean;
    exists: boolean;
  };
  existing_files: string[];
}

export interface CreatePayload {
  type: ServiceType;
  name: string;
  cwd: string;
  spec: Record<string, unknown>;
  token?: string;
  useExistingConfig?: boolean;
}
