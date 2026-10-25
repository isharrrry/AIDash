import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigError } from './errors.js';
import { atomicWriteFileSync, ensureDirSync, sha256Hex } from './util.js';

/**
 * Claude Code 按通道续会话。
 *
 * 本机实测（Claude Code 2.1.218）：
 *   claude --help 支持 -c/--continue、-r/--resume [value]、--session-id <uuid>、
 *   --output-format text|json|stream-json、--no-session-persistence。
 *
 * 选择 --session-id + --resume，而不是 --continue：
 * - --continue 只续“当前目录最近一次”，多个通道/任务会串；
 * - 先自己生成 UUID 并用 --session-id 落盘，再启动进程；即使进程被强杀，
 *   下一次也能用 --resume 回到同一个会话。
 *
 * 会话语义只在 --resume claude 显式开启、且命令看起来是 Claude 时生效。
 * 不存储令牌；文件只含通道、引擎、UUID 和时间戳。
 */

const SESSION_VERSION = 1;
const MAX_HEAD_CHARS = 2_000;
const SESSION_DIR = 'sessions';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// shell 字符串只检查“命令开头/分隔符后的第一个命令词”，避免 echo "claude"
// 这类把 claude 当普通参数的误判。命令词支持带引号的绝对路径。
const SHELL_COMMAND_TOKEN =
  /(?:^|&&|\|\||;|\|)\s*("[^"]*"|'[^']*'|[^\s"'`;&|()]+)(?=\s|$)/g;
const SHELL_MANAGED_FLAG =
  /(?:^|\s)(?:--resume|--session-id|--continue|--no-session-persistence|-r|-c)(?=\s|=|$)/;
const SCRIPT_LAUNCHERS = new Set([
  'node',
  'node.exe',
  'bun',
  'bun.exe',
  'deno',
  'deno.exe',
  'python',
  'python.exe',
  'python3',
]);
const PACKAGE_LAUNCHERS = new Set(['npx', 'npx.cmd', 'bunx', 'bunx.exe']);

const RESUME_FAILURE_PATTERNS = [
  /no conversation found with session id/i,
  /no conversation found to continue/i,
  /session not found/i,
  /no session found/i,
  /no such session/i,
  /session (?:id )?(?:does not exist|is invalid|unknown)/i,
  /invalid session id/i,
];

export function normalizeResumeEngine(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim().toLowerCase();
  if (value !== 'claude') throw new ConfigError('--resume 目前只支持 claude');
  return 'claude';
}

function isClaudeBase(token) {
  const base = path
    .basename(String(token))
    .toLowerCase()
    .replace(/\.(?:exe|cmd|ps1|js|mjs|cjs|ts)$/i, '');
  return base === 'claude' || base.startsWith('claude-');
}

/**
 * 判断命令是否“像 Claude”：
 * - argv：直接执行 claude/claude-*，或 node/npx/python 等启动器后的第一个脚本是 claude-*；
 * - shell：命令开头或 &&/||/;/| 之后的命令词是 claude/claude-*。
 */
export function isClaudeLikeCommand(argv, shell = false) {
  if (shell) {
    const command = Array.isArray(argv) ? argv.join(' ') : String(argv ?? '');
    SHELL_COMMAND_TOKEN.lastIndex = 0;
    let match;
    while ((match = SHELL_COMMAND_TOKEN.exec(command)) !== null) {
      const token = match[1].replace(/^["']|["']$/g, '');
      if (isClaudeBase(token)) return true;
    }
    return false;
  }
  const tokens = Array.isArray(argv) ? argv.map(String) : [String(argv ?? '')];
  if (tokens.length === 0) return false;
  if (isClaudeBase(tokens[0])) return true;
  const launcher = path.basename(tokens[0]).toLowerCase();
  if (SCRIPT_LAUNCHERS.has(launcher)) {
    // node/python 的 argv[1] 是脚本；不能扫全部参数，否则 `node -e claude` 会误判。
    return Boolean(tokens[1]) && !tokens[1].startsWith('-') && isClaudeBase(tokens[1]);
  }
  if (PACKAGE_LAUNCHERS.has(launcher)) {
    // npx -y claude 这类允许选项插在包名之前。
    return tokens.slice(1).some((token) => !token.startsWith('-') && isClaudeBase(token));
  }
  return false;
}

/** 已有 session 参数时不要叠加第二套，避免 --resume 与 --session-id 冲突。 */
export function findExistingSessionFlags(argv, shell = false) {
  if (shell) {
    const command = Array.isArray(argv) ? argv.join(' ') : String(argv ?? '');
    const match = SHELL_MANAGED_FLAG.exec(command);
    return match ? match[0].trim() : null;
  }
  const tokens = Array.isArray(argv) ? argv.map(String) : [String(argv ?? '')];
  return (
    tokens.find(
      (token) =>
        /^--(?:resume|session-id|continue|no-session-persistence)(?:=|$)/.test(token) ||
        token === '-r' ||
        token === '-c',
    ) ?? null
  );
}

export function sessionFilePath(dataDir, channelKey) {
  const safe =
    String(channelKey ?? '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[.-]+/, '_')
      .slice(0, 60) || 'channel';
  const digest = sha256Hex(String(channelKey ?? '')).slice(0, 12);
  return path.join(dataDir, SESSION_DIR, `${safe}-${digest}.json`);
}

export function readClaudeSession(dataDir, channelKey) {
  const file = sessionFilePath(dataDir, channelKey);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      raw?.version !== SESSION_VERSION ||
      raw?.engine !== 'claude' ||
      raw?.channel_key !== channelKey ||
      typeof raw?.session_id !== 'string' ||
      !UUID_PATTERN.test(raw.session_id)
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function writeClaudeSession(dataDir, channelKey, sessionId) {
  if (!UUID_PATTERN.test(String(sessionId))) {
    throw new Error('Claude session_id 不是合法 UUID');
  }
  const file = sessionFilePath(dataDir, channelKey);
  ensureDirSync(path.dirname(file), 0o700);
  atomicWriteFileSync(
    file,
    `${JSON.stringify(
      {
        version: SESSION_VERSION,
        engine: 'claude',
        channel_key: channelKey,
        session_id: sessionId,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    0o600,
  );
  return file;
}

export function clearClaudeSession(dataDir, channelKey) {
  try {
    fs.rmSync(sessionFilePath(dataDir, channelKey), { force: true });
    return true;
  } catch {
    return false;
  }
}

function appendArgs(argv, shell, extra) {
  if (shell) {
    const command = (Array.isArray(argv) ? argv.join(' ') : String(argv ?? '')).trimEnd();
    return [`${command} ${extra.join(' ')}`];
  }
  return [...(Array.isArray(argv) ? argv : [String(argv ?? '')]), ...extra];
}

/**
 * 返回本次调用的 argv/shell 与模式：
 * - none：未开启、非 Claude、已有手工 session 参数、或会话文件写失败；
 * - new：首次生成并落盘，追加 --session-id；
 * - resume：已有会话，追加 --resume。
 */
export function prepareClaudeInvocation({
  engine,
  argv,
  shell = false,
  channelKey,
  dataDir,
  logger = null,
}) {
  const normalized = normalizeResumeEngine(engine);
  if (!normalized || !isClaudeLikeCommand(argv, shell)) {
    return { argv, shell, mode: 'none', sessionId: null };
  }
  const conflict = findExistingSessionFlags(argv, shell);
  if (conflict) {
    logger?.warn?.(`命令已包含 ${conflict}，跳过 runner 的 Claude 会话管理`);
    return { argv, shell, mode: 'none', sessionId: null };
  }

  const existing = readClaudeSession(dataDir, channelKey);
  if (existing) {
    return {
      argv: appendArgs(argv, shell, ['--resume', existing.session_id]),
      shell,
      mode: 'resume',
      sessionId: existing.session_id,
    };
  }

  const sessionId = randomUUID();
  try {
    writeClaudeSession(dataDir, channelKey, sessionId);
  } catch (error) {
    logger?.warn?.(
      `Claude 会话文件写入失败，本次不启用自动续会话：${error instanceof Error ? error.message : String(error)}`,
    );
    return { argv, shell, mode: 'none', sessionId: null };
  }
  logger?.info?.(`Claude 新会话已落盘：通道 ${channelKey}（session=${sessionId.slice(0, 8)}…）`);
  return {
    argv: appendArgs(argv, shell, ['--session-id', sessionId]),
    shell,
    mode: 'new',
    sessionId,
  };
}

/** resume 失败后：清除旧 id，生成新 id 并落盘，回退一次“不带 --resume”的执行。 */
export function prepareClaudeFallback({
  argv,
  shell = false,
  channelKey,
  dataDir,
  logger = null,
}) {
  clearClaudeSession(dataDir, channelKey);
  const sessionId = randomUUID();
  try {
    writeClaudeSession(dataDir, channelKey, sessionId);
  } catch (error) {
    logger?.warn?.(
      `Claude 新会话文件写入失败，回退执行不带会话参数：${error instanceof Error ? error.message : String(error)}`,
    );
    return { argv, shell, mode: 'fallback-bare', sessionId: null };
  }
  logger?.warn?.(`Claude 会话不可用：已清除旧会话，使用新会话回退一次（不带 --resume）`);
  return {
    argv: appendArgs(argv, shell, ['--session-id', sessionId]),
    shell,
    mode: 'fallback',
    sessionId,
  };
}

/** 只把“会话不存在”当作可回退失败；超时/中止/普通业务失败都不重跑。 */
export function isClaudeResumeFailure(execResult, outputText = '') {
  if (!execResult || execResult.started !== true) return false;
  if (execResult.timedOut === true || execResult.aborted === true) return false;
  if (!Number.isInteger(execResult.exitCode) || execResult.exitCode === 0) return false;
  const text = String(outputText ?? '').slice(0, MAX_HEAD_CHARS * 2);
  return RESUME_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}
