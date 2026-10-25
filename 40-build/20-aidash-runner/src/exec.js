import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isSensitiveEnvKey } from './config-parse.js';

/**
 * 子进程执行。
 *
 * 两个关键决定：
 * 1. stdio 用 ['ignore','pipe','pipe']。'inherit' 会让 runner 无法脱敏、无法写日志、
 *    无法进环形缓冲——三者都是规格要求，所以哪怕前台模式也不能继承。
 * 2. 终止必须杀进程树。shell/包装器只是父节点，真正干活的是子孙；只杀父进程会留下
 *    孤儿占端口/锁文件，下一轮任务会以“莫名其妙失败”出现。
 */

const KILL_GRACE_MS = 2_000;
const TASKKILL_TIMEOUT_MS = 5_000;
const FORCE_FINISH_MS = 3_000;

/**
 * runner 自己注入给 harness 的元数据键。
 *
 * 为什么要单独放行：敏感键过滤用后缀启发式（*_KEY 等），
 * AIDASH_CHANNEL_KEY 是“通道标识”不是凭据，却会被 *_KEY 误判成密钥而丢掉，
 * 结果 harness 拿不到 channel_key 且没有任何报错——这种静默缺失最难排查。
 * 放行范围只限这些固定名字；规则 env 在配置解析阶段已拒绝敏感键。
 */
const TRUSTED_EXTRA_ENV_KEYS = new Set([
  'AIDASH_RUNNER',
  'AIDASH_HARNESS_ID',
  'AIDASH_TASK_ID',
  'AIDASH_TASK_TITLE',
  'AIDASH_CHANNEL_KEY',
]);

/**
 * 构造子进程环境：默认白名单。
 *
 * 白名单 vs 黑名单的失效模式不同：
 * - 白名单漏了变量 → 命令立刻报“找不到 XX”，用户看得见并能补；
 * - 黑名单漏了变量 → 凭据被第三方工具打进日志，用户往往几个月后才知道。
 * 所以即使 AIDASH_TOKEN 被显式写进 env_passthrough，这里也会再过滤一次。
 */
export function buildChildEnv({ passthrough = [], extraEnv = {}, baseEnv = process.env } = {}) {
  const allowed = new Set(passthrough.map((key) => String(key).toLowerCase()));
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!allowed.has(key.toLowerCase())) continue;
    if (isSensitiveEnvKey(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) continue;
    if (isSensitiveEnvKey(key) && !TRUSTED_EXTRA_ENV_KEYS.has(key)) continue;
    env[key] = String(value);
  }
  return env;
}

/**
 * @returns {Promise<{
 *   started: boolean, pid: number|null, exitCode: number|null, signal: string|null,
 *   timedOut: boolean, aborted: boolean, abortedReason: string, spawnError: string|null,
 *   durationMs: number
 * }>}
 */
export function executeCommand({
  argv,
  cwd = null,
  env = {},
  shell = false,
  timeoutMs = 1_800_000,
  signal,
  onOutput,
  onSpawn,
  forceKill = false,
  stdinPayload = null,
}) {
  const startedAt = Date.now();

  if (!Array.isArray(argv) || argv.length === 0) {
    return Promise.resolve(result(false, null, null, null, false, false, 'argv 为空', null, 0));
  }
  if (signal?.aborted) {
    return Promise.resolve(result(false, null, null, null, false, true, reasonOf(signal), null, 0));
  }

  return new Promise((resolve) => {
    let child;
    try {
      const prepared = prepareSpawn(argv, shell);
      child = spawn(prepared.command, prepared.args, {
        cwd: cwd ?? undefined,
        env,
        shell,
        // .cmd/.bat 必须经 cmd.exe；由我们自己拼命令行，避免 Node 再套一层引号。
        windowsVerbatimArguments: prepared.verbatim === true,
        // POSIX 下 detached 让子进程成为新进程组组长，终止时对 -pid 发信号能覆盖整棵树；
        // Windows 不需要（也不能）这样做，taskkill /T 负责遍历。
        detached: process.platform !== 'win32',
        windowsHide: true,
        // input=stdin 时才开 stdin 管道；其余情况保持 ignore，防止 harness 等键盘输入。
        stdio: [stdinPayload === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(result(false, null, null, null, false, false, '', errorText(error), Date.now() - startedAt));
      return;
    }

    const pid = child.pid ?? null;
    let started = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let abortedReason = '';
    let spawnError = null;
    let exitCode = null;
    let exitSignal = null;
    let killStarted = false;
    let timeoutTimer = null;
    let forceTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        started,
        pid,
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        abortedReason,
        spawnError,
        durationMs: Date.now() - startedAt,
      });
    };

    const beginKill = () => {
      if (killStarted || !pid) return;
      killStarted = true;
      void terminateProcessTree(pid, { force: forceKill }).finally(() => {
        // taskkill/SIGKILL 都失败时也不能让值守壳永久等 close。
        if (!settled) forceTimer = setTimeout(finish, FORCE_FINISH_MS);
      });
    };

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      abortedReason = reasonOf(signal);
      beginKill();
    };

    child.once('spawn', () => {
      started = true;
      if (typeof onSpawn === 'function') {
        try {
          onSpawn(pid);
        } catch {
          // 记录 PID 失败只影响强制终止的精度，不影响任务本身。
        }
      }
      if (stdinPayload !== null && child.stdin) {
        try {
          // 子进程可能不读 stdin 就退出；EPIPE 不能变成未处理异常。
          child.stdin.on('error', () => undefined);
          child.stdin.end(stdinPayload);
        } catch {
          // 写 stdin 失败按“命令自己没读输入”处理，不额外终止任务。
        }
      }
    });
    child.stdout?.on('data', (chunk) => emit(onOutput, 'stdout', chunk));
    child.stderr?.on('data', (chunk) => emit(onOutput, 'stderr', chunk));
    child.once('error', (error) => {
      spawnError = errorText(error);
      started = false;
      finish();
    });
    child.once('close', (code, signalName) => {
      exitCode = code;
      exitSignal = signalName;
      finish();
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    // 注册监听与初始检查之间可能刚好被中断，补一次。
    if (signal?.aborted) onAbort();

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      beginKill();
    }, Math.max(1, timeoutMs));
  });
}

function emit(callback, stream, chunk) {
  if (typeof callback !== 'function') return;
  try {
    callback(stream, chunk);
  } catch {
    // 输出回调失败不能杀死子进程或值守壳；丢这一块输出比中断任务安全。
  }
}

function reasonOf(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return '收到停止信号';
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Windows 下 Node 的 spawn(shell:false) 不会按 PATHEXT 找 .cmd/.bat。
 *
 * Claude Code 官方安装通常生成 `claude.cmd`；直接 spawn('claude') 会 ENOENT。
 * 这里按 PATHEXT 解析真实文件：.exe/.com 直接执行，.cmd/.bat 经 cmd.exe。
 */
function prepareSpawn(argv, shell) {
  if (shell || process.platform !== 'win32') {
    return { command: argv[0], args: argv.slice(1) };
  }
  const resolved = resolveWindowsCommand(argv[0]);
  if (!resolved) return { command: argv[0], args: argv.slice(1) };
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...argv.slice(1)].map(quoteCmdArg).join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      verbatim: true,
    };
  }
  return { command: resolved, args: argv.slice(1) };
}

function resolveWindowsCommand(command) {
  const text = String(command);
  const hasDir = /[\\/]/.test(text);
  const hasExt = path.extname(text) !== '';
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const isFile = (candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  const probe = (base) => {
    if (hasExt) return isFile(base) ? base : null;
    for (const ext of exts) {
      const candidate = base + ext;
      if (isFile(candidate)) return candidate;
    }
    return isFile(base) ? base : null;
  };

  if (hasDir) return probe(text);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const hit = probe(path.join(dir, text));
    if (hit) return hit;
  }
  return null;
}

/** cmd.exe 参数引号：只对包含空白/元字符的参数加引号，内部双引号双写。 */
function quoteCmdArg(value) {
  const text = String(value);
  if (text === '') return '""';
  return /[\s"&|<>^()%!]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function result(started, pid, exitCode, signalName, timedOut, aborted, abortedReason, spawnError, durationMs) {
  return { started, pid, exitCode, signal: signalName, timedOut, aborted, abortedReason, spawnError, durationMs };
}

/**
 * 终止整棵进程树。
 *
 * Windows 没有进程组信号，taskkill /T /F 是系统提供的树遍历；POSIX 用
 * detached 建立的进程组：先 SIGTERM 给清理机会，宽限后 SIGKILL。
 * force=true 时跳过宽限，供 `kill --force` 使用。
 */
export function terminateProcessTree(pid, { force = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') return runTaskkill(pid);

  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      return Promise.resolve();
    }
  }
  if (force) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 已经退出。
        }
      }
      resolve();
    }, KILL_GRACE_MS);
  });
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('close', finish);
    killer.once('error', finish);
    timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // 忽略：直接结束等待。
      }
      finish();
    }, TASKKILL_TIMEOUT_MS);
  });
}
