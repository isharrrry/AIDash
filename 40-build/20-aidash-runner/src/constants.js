import fs from 'node:fs';
import os from 'node:os';

/**
 * 版本从 package.json 读，而不是在代码里再写一份常量。
 * 双真源的后果是发布后 `--version` 与 npm 包版本对不上，排障时最难发现。
 */
function readVersion() {
  try {
    const url = new URL('../package.json', import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(url, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    // package.json 缺失属于打包事故；退回 0.0.0 让程序还能报错退出，而不是启动即崩。
    return '0.0.0';
  }
}

export const VERSION = readVersion();

export const DEFAULT_MCP_ENDPOINT = 'http://127.0.0.1:8787/mcp';
export const DEFAULT_CONFIG_FILENAME = 'aidash-runner.json';
export const HOME_CONFIG_RELATIVE = 'runner.json';
export const DAEMON_READY_TIMEOUT_MS = 15_000;
export const CONTROL_REQUEST_TIMEOUT_MS = 3_000;
export const HEALTH_CHECK_TIMEOUT_MS = 1_200;
export const CONTROL_BODY_LIMIT_BYTES = 64 * 1024;
export const CONTROL_TOKEN_BYTES = 32;

/** 首尾各 8KB：错误通常在尾部，线索通常在头部，中间大段日志对卡片没有价值。 */
export const OUTPUT_EDGE_BYTES = 8 * 1024;
export const CARD_SUMMARY_LIMIT = 2_000;
export const CARD_DETAIL_LIMIT = 64 * 1024;
export const FAIL_REASON_LIMIT = 4_000;
export const COMMAND_DISPLAY_LIMIT = 160;

export const DEFAULT_POLL_SECONDS = 5;
export const DEFAULT_LEASE_SECONDS = 900;
export const DEFAULT_HEARTBEAT_SECONDS = 60;
export const DEFAULT_GAP_SECONDS = 2;
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 1_800;

export const MAX_TASK_LIST_PAGES = 10;
export const TASK_LIST_PAGE_SIZE = 100;

/**
 * 子进程环境白名单的默认值。
 *
 * 为什么不是“继承全部再删几个”：环境变量里可能有云厂商凭据、git token、
 * 代理口令，删不过来。白名单的失效模式是“命令缺一个变量报错”，用户看得见；
 * 黑名单的失效模式是“令牌被第三方工具打到日志里”，用户看不见。
 * 这里在规格示例的五个变量之外补了 PATHEXT/WINDIR/TEMP/TMP：
 * 没有 PATHEXT 时 Windows 上很多命令无法解析，属于“白名单过窄直接不可用”。
 */
export const DEFAULT_ENV_PASSTHROUGH = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
  'TEMP',
  'TMP',
]);

/** 任何情况下都不交给 harness 的两个变量。 */
export const FORBIDDEN_ENV_KEYS = Object.freeze(['AIDASH_TOKEN', 'AIDASH_LLM_API_KEY']);

/**
 * 通用敏感键：值不继承、配置里也不允许设置。
 * 用后缀而不是包含匹配，避免把 `KEYBOARD_LAYOUT` 这类正常变量误伤。
 */
export const SENSITIVE_ENV_SUFFIX = Object.freeze(['_TOKEN', '_SECRET', '_KEY', '_PASSWORD']);

export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
export const HARNESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function defaultHarnessId() {
  return `watch-${os.hostname().replace(/[^A-Za-z0-9._:-]/g, '-')}`.slice(0, 64);
}

export function defaultInstanceName() {
  return os.hostname() || 'aidash-runner';
}
