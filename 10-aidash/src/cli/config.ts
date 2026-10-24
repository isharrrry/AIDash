import { ConfigError } from './errors.js';

/**
 * 值守壳配置的公共部分：类型、端点归一化、令牌读取、安全默认。
 *
 * 配置解析拆在 config-load.ts，规则匹配拆在 match.ts：
 * 每个文件只承担一件事，避免 500 行的“上帝配置模块”；
 * 也避免自检时在一堆校验分支里找不到真正的安全边界。
 */

export const DEFAULT_MCP_ENDPOINT = 'http://127.0.0.1:8787/mcp';
export const DEFAULT_CONFIG_FILE = 'aidash-watch.json';

export interface CommandRule {
  /** 通过 shell 执行的命令行（Windows cmd /c，POSIX sh -c）。 */
  command: string;
  /** 任务必须同时具备这些标签（AND）；空数组表示不按标签过滤。 */
  tags: string[];
  /** 任务标题前缀，大小写不敏感。 */
  title_prefix?: string;
  /** 只对该通道（或 `前缀/*`）生效。 */
  channel_key?: string;
  /** 显式声明“匹配所有任务”；没有其他匹配条件时必须为 true。 */
  match_all?: boolean;
  /** 单条命令的超时；缺省用顶层 command_timeout_seconds。 */
  timeout_seconds?: number;
  /** 绝对路径（相对路径在加载时按配置文件目录解析）。 */
  cwd?: string;
  /** 追加给子进程的环境变量；禁止覆盖 AIDASH_TOKEN / AIDASH_LLM_API_KEY。 */
  env?: Record<string, string>;
}

export interface WatchConfig {
  /** 完整 MCP 端点（已归一化）。 */
  endpoint: string;
  harness_id: string;
  name: string;
  host: string | null;
  capabilities: string[];
  /** 空数组 = 不限制通道。支持精确匹配与 `前缀/*`。 */
  channels: string[];
  poll_interval_seconds: number;
  lease_seconds: number;
  heartbeat_interval_seconds: number;
  gap_seconds: number;
  command_timeout_seconds: number;
  commands: CommandRule[];
  config_path: string;
  config_dir: string;
}

export interface LoadedWatchConfig {
  /** 文件不存在且未显式指定时返回 null（调用方据此走“只读 status”安全默认）。 */
  config: WatchConfig | null;
  warnings: string[];
}

/**
 * 归一化端点：
 * - 接受根地址（http://host:8787）和完整地址（http://host:8787/mcp）；
 * - 根地址自动补 /mcp，避免用户把 REST 根误当 MCP 端点；
 * - 拒绝 URL 内嵌账号密码，避免“令牌被写进配置”这种低级泄露。
 */
export function normalizeEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`aidash_url 不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('aidash_url 只支持 http/https');
  }
  if (url.username || url.password) {
    throw new ConfigError('aidash_url 不能内嵌账号密码；令牌只从 AIDASH_TOKEN 读取');
  }
  url.hash = '';
  url.search = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/mcp')) pathname = `${pathname}/mcp`;
  url.pathname = pathname;
  return url.toString();
}

/** 令牌只从环境变量读；缺失/格式异常都按配置错误处理（exit 2）。 */
export function readToken(): string {
  const token = process.env.AIDASH_TOKEN?.trim();
  if (!token) {
    throw new ConfigError('缺少 AIDASH_TOKEN 环境变量：令牌只从环境读取，不写入配置文件、不打印');
  }
  if (token.length > 4096 || /\s/.test(token)) {
    throw new ConfigError('AIDASH_TOKEN 格式不合法（含空白或长度超过 4096）');
  }
  return token;
}

/** 没有配置文件时给 status 用的只读配置：commands 为空，天然不会执行任何命令。 */
export function defaultStatusConfig(): WatchConfig {
  return {
    endpoint: normalizeEndpoint(process.env.AIDASH_URL?.trim() || DEFAULT_MCP_ENDPOINT),
    harness_id: 'aidash-watch',
    name: 'AIDash 值守壳（无配置文件）',
    host: null,
    capabilities: [],
    channels: [],
    poll_interval_seconds: 60,
    lease_seconds: 900,
    heartbeat_interval_seconds: 30,
    gap_seconds: 2,
    command_timeout_seconds: 1800,
    commands: [],
    config_path: '',
    config_dir: process.cwd(),
  };
}
