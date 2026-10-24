import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 子进程执行与进程树终止。
 *
 * 为什么必须杀进程树：
 * 我们用 shell 启动命令（Windows cmd /c，POSIX sh -c）。shell 本身只是一个父节点，
 * 真正干活的是它的子孙进程（node、测试运行器、编译器…）。只 kill shell，子孙会变成孤儿，
 * 继续占端口、占文件锁，下一轮任务就会莫名其妙失败。所以：
 * - Windows：taskkill /PID <pid> /T /F；
 * - POSIX：spawn 时 detached:true 建立新进程组，对 -pid 先 SIGTERM，宽限后 SIGKILL。
 *
 * 为什么从子进程环境变量里删除令牌：
 * 本地 harness 不需要 AIDash 面板的令牌。继承它只会扩大泄露面（命令、脚本、崩溃报告、
 * 第三方工具都可能把环境变量打出来）。最小权限原则：子进程只拿到执行任务必需的信息。
 */

const OUTPUT_LIMIT_BYTES = 16 * 1024;
const KILL_GRACE_MS = 2_000;
const TASKKILL_TIMEOUT_MS = 5_000;
const FORCE_FINISH_MS = 3_000;
const SENSITIVE_ENV_KEYS = new Set(['AIDASH_TOKEN', 'AIDASH_LLM_API_KEY']);

export interface ExecOptions {
  command: string;
  cwd?: string;
  /** 追加环境变量；敏感键会被二次过滤（配置加载时也会拦）。 */
  env?: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** 启动失败（如 cwd 不存在、shell 不可执行）；成功启动后为 null。 */
  error: string | null;
}

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEYS.has(key.toUpperCase());
}

/** 构造子进程环境：继承父环境，但抹掉 AIDash 令牌与 LLM key。 */
export function buildChildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isSensitiveEnvKey(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (isSensitiveEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}

export function executeCommand(options: ExecOptions): Promise<ExecResult> {
  const startedAt = Date.now();
  const stdout = new BoundedBuffer(OUTPUT_LIMIT_BYTES);
  const stderr = new BoundedBuffer(OUTPUT_LIMIT_BYTES);

  if (options.signal.aborted) {
    return Promise.resolve(emptyAbortedResult());
  }

  return new Promise<ExecResult>((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
    // cmd 的 /d 关闭 AutoRun，/s 保留命令字符串的引号语义；等价于用户熟悉的 cmd /c。
    const shellArgs = isWindows ? ['/d', '/s', '/c', options.command] : ['-c', options.command];

    let child: ChildProcess;
    try {
      child = spawn(shell, shellArgs, {
        cwd: options.cwd,
        env: buildChildEnv(options.env),
        // POSIX 下 detached 让 shell 成为新进程组组长，便于整组终止；
        // Windows 不需要 detached，taskkill /T 会遍历进程树。
        detached: !isWindows,
        windowsHide: true,
        // cmd /c 按“命令行原文”解析剩余部分；让 Node 再给参数加一层引号转义，
        // 会把 node -e "console.log('x')" 里的双引号变成 \"，cmd 与 node 都可能误解。
        windowsVerbatimArguments: isWindows,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ...emptyAbortedResult(),
        aborted: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killStarted = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let forceTimer: NodeJS.Timeout | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: string | null = null;

    function finish(): void {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal: exitSignal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        error: spawnError,
      });
    }

    function beginKill(): void {
      if (killStarted) return;
      killStarted = true;
      void terminateTree(child, isWindows).finally(() => {
        // 极端情况下 taskkill/SIGKILL 都没能触发 close：强行结束等待，避免值守壳卡死。
        if (!settled) forceTimer = setTimeout(finish, FORCE_FINISH_MS);
      });
    }

    function onAbort(): void {
      if (settled) return;
      aborted = true;
      beginKill();
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));
    child.on('error', (error) => {
      spawnError = error.message;
      finish();
    });
    child.on('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finish();
    });

    options.signal.addEventListener('abort', onAbort, { once: true });
    // 初始检查与监听注册之间可能刚好被中断；补一次，避免命令在“已取消”状态下继续跑。
    if (options.signal.aborted) onAbort();
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      beginKill();
    }, Math.max(1, options.timeoutMs));
  });
}

function emptyAbortedResult(): ExecResult {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: true,
    durationMs: 0,
    error: null,
  };
}

async function terminateTree(child: ChildProcess, isWindows: boolean): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;

  if (isWindows) {
    await runTaskkill(pid);
    return;
  }

  // 先温和后强硬：给进程一次清理临时文件/释放端口的机会。
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // 已经退出，无需处理。
    }
  }
  await delay(KILL_GRACE_MS);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已经退出，无需处理。
    }
  }
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('close', finish);
    killer.on('error', finish);
    timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // 忽略：下面直接结束等待。
      }
      finish();
    }, TASKKILL_TIMEOUT_MS);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 有上限的输出缓冲：超过 16KB 只保留前 16KB，并标记截断。 */
class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.limit - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size += remaining;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
