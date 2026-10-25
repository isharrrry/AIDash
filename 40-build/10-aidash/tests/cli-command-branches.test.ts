import fs from 'node:fs';
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultStatusConfig, type CommandRule, type WatchConfig } from '../src/cli/config.js';
import {
  AuthError,
  BusinessError,
  CliError,
  ConfigError,
  TransportError,
  isCliError,
} from '../src/cli/errors.js';
import { executeCommand, type ExecResult } from '../src/cli/exec.js';
import type { Logger } from '../src/cli/log.js';
import { AidashMcpClient } from '../src/cli/mcp-client.js';
import type { TaskItem } from '../src/cli/mcp-parse.js';
import { buildFailReason, postStatusCard, releaseQuietly } from '../src/cli/report.js';
import { listTasks, runWatch, type RunContext } from '../src/cli/runner.js';
import { main, parseArgs } from '../src/cli/index.js';
import {
  TEST_TOKEN,
  captureCliError,
  captureError,
  cleanupCliFixtures,
  emptyDir,
  fakeLogger,
  isRecord,
  makeConfig,
  makeExecResult,
  makeTask,
  scriptedClient,
  startFakeMcp,
  tempConfig,
  withFakeMcp,
} from './fakes/cli-fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupCliFixtures();
});

/**
 * CLI 命令层（exec / report / index）错误分支。
 *
 * 由 cli-branches 按主题拆出：子进程截断与中断、卡片文案与释放、
 * 入口参数/令牌校验/status/dry-run。断言保持原样，仅搬移分组。
 */

// ---------------------------------------------------------------------------
// exec：截断、spawn 失败、运行中中断
// ---------------------------------------------------------------------------

describe('CLI 分支：子进程执行', () => {
  it('stdout/stderr 超过 16KB 时截断并标记（含“先写满再加一段”分支）', async () => {
    const fillThenOverflow = await executeCommand({
      command:
        'node -e "process.stdout.write(\'a\'.repeat(16384));setTimeout(()=>process.stdout.write(\'tail\'),20)"',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(fillThenOverflow.exitCode).toBe(0);
    expect(fillThenOverflow.stdout.length).toBe(16384);
    expect(fillThenOverflow.stdoutTruncated).toBe(true);

    const bigChunk = await executeCommand({
      command:
        'node -e "process.stdout.write(\'b\'.repeat(20000));process.stderr.write(\'c\'.repeat(20000))"',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(bigChunk.stdout.length).toBe(16384);
    expect(bigChunk.stdoutTruncated).toBe(true);
    expect(bigChunk.stderr.length).toBe(16384);
    expect(bigChunk.stderrTruncated).toBe(true);
  }, 20_000);

  it.skipIf(process.platform !== 'win32')('spawn ENOENT（shell 不存在）→ error 有值、不标记超时', async () => {
    // Windows 下 shell 取自 ComSpec；指向不存在的可执行文件即可稳定触发 ENOENT。
    vi.stubEnv('ComSpec', path.join(os.tmpdir(), 'aidash-no-such-shell-xyz.exe'));
    const result = await executeCommand({
      command: 'echo hi',
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(result.error).not.toBeNull();
    expect(String(result.error)).toContain('ENOENT');
    expect(result.exitCode).toBeNull();
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  }, 20_000);

  it('命令运行中收到中断：终止进程树并返回 aborted=true', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = executeCommand({
      command: 'node -e "setTimeout(()=>{},5000)"',
      timeoutMs: 15_000,
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 120);
    try {
      const result = await pending;
      expect(result.aborted).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      clearTimeout(timer);
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// report：卡片与释放
// ---------------------------------------------------------------------------

describe('CLI 分支：任务回报', () => {
  const rule: CommandRule = { command: 'echo ok', tags: [], match_all: true };
  const ctxFor = (client: AidashMcpClient, logger: Logger): RunContext => ({
    client,
    config: makeConfig(),
    logger,
    signal: new AbortController().signal,
  });

  it('任务缺 channel_key 时拒绝发卡（不发任何请求）', async () => {
    const { client, calls } = scriptedClient(() => ({ card_id: 'cd_x' }));
    const error = await captureCliError(
      postStatusCard(
        ctxFor(client, fakeLogger().logger),
        makeTask({ channel_key: '' }),
        rule,
        makeExecResult(),
        true,
      ),
    );
    expect(error).toBeInstanceOf(BusinessError);
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('缺少 channel_key');
    expect(calls).toHaveLength(0);
  });

  it('失败卡：超时/启动错误/信号/未知原因文案、优先级归一化、截断标记', async () => {
    const { client, calls } = scriptedClient(() => ({ card_id: 'cd_fail' }));
    const timedOut = makeExecResult({
      exitCode: null,
      stdout: '',
      stderr: '\n  boom first line  \nsecond line',
      stdoutTruncated: true,
      timedOut: true,
      durationMs: 2500,
    });
    const cardId = await postStatusCard(
      ctxFor(client, fakeLogger().logger),
      makeTask({ id: 'tk_fail', priority: 'P9' }),
      rule,
      timedOut,
      false,
    );
    expect(cardId).toBe('cd_fail');

    const card = calls.find((call) => call.name === 'card.post')!;
    expect(card.args).toMatchObject({
      type: 'status',
      result: 'failed',
      priority: 'P2',
      task_id: 'tk_fail',
    });
    expect(String(card.args.title)).toBe('任务 tk_fail 执行失败');
    expect(String(card.args.summary)).toContain('执行超时，已终止进程树');
    expect(String(card.args.summary)).toContain('stderr 首行：boom first line');
    expect(String(card.args.detail_md)).toContain('超时：是');
    expect(String(card.args.detail_md)).toContain('stdout：已截断到 16KB');
    expect(String(card.args.detail_md)).toContain('(空)');
    expect(String(card.args.idempotency_key)).toMatch(/^watch-tk_fail-/);

    // failureLabel 的其余分支（启动失败 / 仅信号 / 未知原因）直接走 buildFailReason。
    expect(buildFailReason('cmd', makeExecResult({ error: 'spawn ENOENT' }))).toContain(
      '进程启动失败：spawn ENOENT',
    );
    expect(
      buildFailReason('cmd', makeExecResult({ exitCode: null, signal: 'SIGKILL' })),
    ).toContain('被信号 SIGKILL 终止');
    expect(
      buildFailReason('cmd', makeExecResult({ exitCode: null, signal: null })),
    ).toContain('未知原因');
    expect(buildFailReason('cmd', makeExecResult({ exitCode: 2 }))).toContain('退出码 2');
  });

  it('成功卡使用 P0 优先级，并对命令中的令牌脱敏', async () => {
    const secret = 'super-secret-token-123';
    vi.stubEnv('AIDASH_TOKEN', secret);
    const { client, calls } = scriptedClient(() => ({ card_id: 'cd_ok' }));
    const longCommand = `echo ${secret} ${'x'.repeat(3000)}`;
    const cardId = await postStatusCard(
      ctxFor(client, fakeLogger().logger),
      makeTask({ id: 'tk_ok', priority: 'P0' }),
      { command: longCommand, tags: [], match_all: true },
      makeExecResult({ exitCode: 0, stdout: 'done' }),
      true,
    );
    expect(cardId).toBe('cd_ok');
    const card = calls.find((call) => call.name === 'card.post')!;
    expect(card.args.priority).toBe('P0');
    expect(card.args.result).toBe('success');
    expect(String(card.args.title)).toBe('任务 tk_ok 执行成功');
    expect(String(card.args.summary)).toContain('命令执行成功');
    expect(String(card.args.summary)).not.toContain(secret);
    expect(String(card.args.detail_md)).not.toContain(secret);
    expect(String(card.args.detail_md)).toContain('***');
    // schema 上限：summary 2000、detail_md 64000、idempotency_key 128。
    expect(String(card.args.summary).length).toBeLessThanOrEqual(2_000);
    expect(String(card.args.detail_md).length).toBeLessThanOrEqual(64_000);
    expect(String(card.args.idempotency_key).length).toBeLessThanOrEqual(128);
  });

  it('releaseQuietly：成功记 info，失败只记 warn 不抛错', async () => {
    const ok = scriptedClient(() => ({ ok: true, data: {} }));
    const okLog = fakeLogger();
    await releaseQuietly(
      ctxFor(ok.client, okLog.logger),
      'tk_1',
      'cl_1',
      '收到中断',
    );
    expect(ok.calls[0]).toMatchObject({
      name: 'task.release',
      args: { task_id: 'tk_1', claim_token: 'cl_1', reason: '收到中断' },
    });
    expect(okLog.entries.some((entry) => entry.level === 'info' && entry.message.includes('已释放任务'))).toBe(
      true,
    );

    const failing = scriptedClient(() => {
      throw new TransportError('release 端口断了');
    });
    const failLog = fakeLogger();
    await expect(
      releaseQuietly(ctxFor(failing.client, failLog.logger), 'tk_2', 'cl_2', 'x'.repeat(5000)),
    ).resolves.toBeUndefined();
    expect(failLog.entries.some((entry) => entry.level === 'warn' && entry.message.includes('释放任务 tk_2 失败'))).toBe(
      true,
    );
    // reason 在落请求前截断到 4000。
    expect(String(failing.calls[0]!.args.reason).length).toBeLessThanOrEqual(4_000);
  });
});

// ---------------------------------------------------------------------------
// index：入口参数、令牌校验、status / dry-run 只读路径
// ---------------------------------------------------------------------------

describe('CLI 分支：入口', () => {
  it('parseArgs 跳过 undefined 元素，空 --config= 报配置错误', () => {
    expect(parseArgs([undefined as unknown as string, 'run'])).toMatchObject({ command: 'run' });
    expect(() => parseArgs(['--config='])).toThrow(ConfigError);
    expect(() => parseArgs(['once', '--config='])).toThrow(ConfigError);
    expect(parseArgs(['status', '--help'])).toMatchObject({ command: 'status', help: true });
  });

  it('令牌缺失 / 超长都按配置错误拒绝（不发起连接）', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const file = tempConfig({ harness_id: 'h-token', name: 'token 测试' });

    vi.stubEnv('AIDASH_TOKEN', '');
    const missing = await captureError(main(['status', '--config', file]));
    expect(missing).toBeInstanceOf(ConfigError);
    expect(missing.message).toContain('缺少 AIDASH_TOKEN');

    vi.stubEnv('AIDASH_TOKEN', 'x'.repeat(4097));
    const tooLong = await captureError(main(['status', '--config', file]));
    expect(tooLong).toBeInstanceOf(ConfigError);
    expect(tooLong.message).toContain('长度超过 4096');
  });

  it('无配置文件时 status 使用只读默认配置：打印统计、我的状态、无任务提示', async () => {
    const server = await startFakeMcp((method, params) => {
      // initialize 等协议方法交给假服务默认实现。
      if (method !== 'tools/call') return undefined;
      const name = String(params.name);
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name === 'digest.get') {
        // MCP 工具结果包络：toolResult 里再放 {ok:true,data}，客户端会剥两层壳。
        return {
          result: {
            toolResult: {
              ok: true,
              data: {
                pending_decisions: 3,
                p0_cards: 2,
                p1_cards: 1,
                channels_active: 4,
              },
            },
          },
        };
      }
      if (name === 'task.list' && args.status === 'pending') {
        return { result: { toolResult: { ok: true, data: { items: [], has_more: false } } } };
      }
      if (name === 'task.list' && args.assignee === 'aidash-watch') {
        return {
          result: {
            toolResult: {
              ok: true,
              data: {
                items: [
                  { id: 'tk_m1', status: 'done' },
                  { id: 'tk_m2', status: 'in_progress' },
                ],
                has_more: false,
              },
            },
          },
        };
      }
      return undefined;
    });
    const workdir = emptyDir();
    const previous = process.cwd();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubEnv('AIDASH_TOKEN', TEST_TOKEN);
    vi.stubEnv('AIDASH_URL', server.endpoint);
    vi.stubEnv('AIDASH_WATCH_LOG_LEVEL', 'error');
    process.chdir(workdir);
    try {
      await expect(main(['status'])).resolves.toBe(0);
      const output = stdout.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('AIDash 值守状态');
      expect(output).toContain('待决策      3');
      expect(output).toContain('P0 / P1 卡  2 / 1');
      expect(output).toContain('活跃通道    4');
      expect(output).toContain('待认领任务  0');
      expect(output).toContain('我的任务    2');
      expect(output).toContain('我的状态    done=1 in_progress=1');
      expect(output).toContain('暂无可认领任务');
      // defaultStatusConfig 的 config_path 为空，因此不打印“配置”行。
      expect(output).not.toContain('  配置');
    } finally {
      process.chdir(previous);
      await server.close();
    }
  });

  it('status 有待认领任务时逐条列出（最多 20 个）', async () => {
    const server = await startFakeMcp((method, params) => {
      if (method !== 'tools/call') return undefined;
      const name = String(params.name);
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name === 'digest.get') {
        return { result: { toolResult: { ok: true, data: { pending_decisions: 0 } } } };
      }
      if (name === 'task.list' && args.status === 'pending') {
        return {
          result: {
            toolResult: {
              ok: true,
              data: {
                items: [
                  { id: 'tk_pending', status: 'pending', title: '待办任务', channel_key: 'devhost/x' },
                ],
                has_more: false,
              },
            },
          },
        };
      }
      return { result: { toolResult: { ok: true, data: { items: [], has_more: false } } } };
    });
    const workdir = emptyDir();
    const previous = process.cwd();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubEnv('AIDASH_TOKEN', TEST_TOKEN);
    vi.stubEnv('AIDASH_URL', server.endpoint);
    vi.stubEnv('AIDASH_WATCH_LOG_LEVEL', 'error');
    process.chdir(workdir);
    try {
      await expect(main(['status'])).resolves.toBe(0);
      const output = stdout.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('待认领任务  1');
      expect(output).toContain('可认领任务（最多显示 20 个）：');
      expect(output).toContain('- tk_pending [pending] 待办任务（devhost/x）');
      // mine 为空 → 不打印“我的状态”统计行。
      expect(output).not.toContain('我的状态');
      expect(output).not.toContain('暂无可认领任务');
    } finally {
      process.chdir(previous);
      await server.close();
    }
  });

  it('dry-run：分别说明 assignee / 通道 / 无规则导致的跳过，以及无 commands 提示', async () => {
    const server = await startFakeMcp((method, params) => {
      if (method !== 'tools/call' || String(params.name) !== 'task.list') return undefined;
      return {
        result: {
          toolResult: {
            ok: true,
            data: {
              items: [
                { id: 'tk_a', title: 'A', channel_key: 'devhost/x', assignee: 'h-other' },
                { id: 'tk_b', title: 'B', channel_key: 'weird/x', assignee: null },
                { id: 'tk_c', title: 'C', channel_key: 'devhost/x', assignee: null },
              ],
              has_more: false,
            },
          },
        },
      };
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubEnv('AIDASH_TOKEN', TEST_TOKEN);
    vi.stubEnv('AIDASH_WATCH_LOG_LEVEL', 'error');
    const withRules = tempConfig({
      aidash_url: server.endpoint,
      harness_id: 'h1',
      name: 'dry-run 测试',
      channels: ['devhost/*'],
      commands: [{ command: 'echo ok', match_all: true }],
    });
    try {
      await expect(main(['dry-run', '--config', withRules])).resolves.toBe(0);
      let output = stdout.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('[跳过]   tk_a A：assignee=h-other 不是 h1');
      expect(output).toContain('[跳过]   tk_b B：通道 weird/x 不在 channels 内');
      expect(output).toContain('[将认领] tk_c C -> echo ok');
      expect(output).toContain('命中 1 个任务。');

      stdout.mockClear();
      const withoutRules = tempConfig({
        aidash_url: server.endpoint,
        harness_id: 'h1',
        name: 'dry-run 无规则',
        channels: ['devhost/*'],
      });
      await expect(main(['dry-run', '--config', withoutRules])).resolves.toBe(0);
      output = stdout.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('配置中没有 commands 规则：所有任务都会被跳过。');
      expect(output).toContain('[跳过]   tk_c C：没有匹配的 command 规则');
      expect(output).toContain('命中 0 个任务。');
    } finally {
      await server.close();
    }
  });
});
