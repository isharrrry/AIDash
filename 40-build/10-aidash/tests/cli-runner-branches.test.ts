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
 * CLI 值守主循环（runner）错误分支。
 *
 * 由 cli-branches 按主题拆出：认领/开工/续租/失败释放/轮询节奏/分页。
 * 断言保持原样，仅搬移分组。
 */

// ---------------------------------------------------------------------------
// runner：主循环状态机分支（scripted client）
// ---------------------------------------------------------------------------

describe('CLI 分支：值守主循环', () => {
  it('外部信号已中断：不注册、不发心跳、直接返回', async () => {
    const { client, calls } = scriptedClient(() => ({ ok: true, data: {} }));
    await runWatch(
      {
        client,
        config: makeConfig(),
        logger: fakeLogger().logger,
        signal: AbortSignal.abort(),
      },
      'once',
    );
    expect(calls).toHaveLength(0);
  });

  it('run 模式吞掉传输错误继续轮询，直到外部中断', async () => {
    const controller = new AbortController();
    let listCalls = 0;
    const { client } = scriptedClient((name) => {
      if (name === 'task.list') {
        listCalls += 1;
        if (listCalls === 1) throw new TransportError('连接被拒');
        return { items: [], has_more: false };
      }
      return { ok: true, data: {} };
    });
    const { logger, entries } = fakeLogger();
    const timer = setTimeout(() => controller.abort(), 60);
    try {
      await runWatch(
        { client, config: makeConfig({ poll_interval_seconds: 0.01 }), logger, signal: controller.signal },
        'run',
      );
    } finally {
      clearTimeout(timer);
    }
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(
      entries.some((entry) => entry.level === 'warn' && entry.message.includes('本轮通信失败')),
    ).toBe(true);
  });

  it('once 模式：列表阶段认证失败直接向上抛，不认领', async () => {
    const { client, calls } = scriptedClient((name) => {
      if (name === 'task.list') throw new AuthError('401 令牌失效');
      return { ok: true, data: {} };
    });
    await expect(
      runWatch(
        { client, config: makeConfig(), logger: fakeLogger().logger, signal: new AbortController().signal },
        'once',
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(calls.some((call) => call.name === 'task.claim')).toBe(false);
  });

  it('没有匹配任务（assignee 指向他人 / 通道不在白名单）时不认领', async () => {
    const tasks = [
      makeTask({ id: 'tk_other', assignee: 'other-harness' }),
      makeTask({ id: 'tk_channel', channel_key: 'other/proj' }),
    ];
    const { client, calls } = scriptedClient((name) =>
      name === 'task.list' ? { items: tasks, has_more: false } : { ok: true, data: {} },
    );
    await runWatch(
      {
        client,
        config: makeConfig({ channels: ['devhost/*'] }),
        logger: fakeLogger().logger,
        signal: new AbortController().signal,
      },
      'once',
    );
    expect(calls.some((call) => call.name === 'task.claim')).toBe(false);
  });

  it('ALREADY_CLAIMED 视为正常竞争：跳过并记录日志，不 start', async () => {
    const task = makeTask({ id: 'tk_race' });
    const { client, calls } = scriptedClient((name) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') throw new BusinessError('ALREADY_CLAIMED', '被抢走了');
      return { ok: true, data: {} };
    });
    const { logger, entries } = fakeLogger();
    await runWatch(
      { client, config: makeConfig(), logger, signal: new AbortController().signal },
      'once',
    );
    expect(calls.some((call) => call.name === 'task.update' && call.args.event === 'start')).toBe(false);
    expect(entries.some((entry) => entry.message.includes('已被其他 harness 认领'))).toBe(true);
  });

  it('认领遇到其他业务错误：向上抛，不释放（此时还没有 token）', async () => {
    const task = makeTask({ id: 'tk_gone' });
    const { client, calls } = scriptedClient((name) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') throw new BusinessError('NOT_FOUND', '任务不存在');
      return { ok: true, data: {} };
    });
    const error = await captureError(
      runWatch(
        { client, config: makeConfig(), logger: fakeLogger().logger, signal: new AbortController().signal },
        'once',
      ),
    );
    expect(error).toBeInstanceOf(BusinessError);
    expect((error as BusinessError).code).toBe('NOT_FOUND');
    expect(calls.some((call) => call.name === 'task.release')).toBe(false);
  });

  it('认领成功但 start 前被中断：走释放而不是开始执行', async () => {
    const controller = new AbortController();
    const task = makeTask({ id: 'tk_prestart' });
    const { client, calls } = scriptedClient((name) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') {
        controller.abort();
        return { task, claim_token: 'cl_pre' };
      }
      return { ok: true, data: {} };
    });
    await runWatch(
      { client, config: makeConfig(), logger: fakeLogger().logger, signal: controller.signal },
      'once',
    );
    const release = calls.find((call) => call.name === 'task.release');
    expect(release).toBeDefined();
    expect(String(release!.args.reason)).toContain('启动前收到中断信号');
    expect(calls.some((call) => call.name === 'task.update')).toBe(false);
  });

  it('列表返回后立即被中断：候选任务不进入执行', async () => {
    const controller = new AbortController();
    const task = makeTask({ id: 'tk_abort_before' });
    const { client, calls } = scriptedClient((name) => {
      if (name === 'task.list') {
        controller.abort();
        return { items: [task], has_more: false };
      }
      return { ok: true, data: {} };
    });
    await runWatch(
      { client, config: makeConfig(), logger: fakeLogger().logger, signal: controller.signal },
      'once',
    );
    expect(calls.some((call) => call.name === 'task.claim')).toBe(false);
  });

  it('成功链路：register(capabilities) → claim → start → 发卡 → complete(证据卡)', async () => {
    const task = makeTask({ id: 'tk_ok', title: '成功任务' });
    const { client, calls } = scriptedClient((name) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') return { task, claim_token: 'cl_ok' };
      if (name === 'card.post') return { card_id: 'cd_ok' };
      return { ok: true, data: {} };
    });
    const { logger, entries } = fakeLogger();
    await runWatch(
      {
        client,
        config: makeConfig({
          capabilities: ['dev'],
          commands: [
            {
              command: 'node -e "process.exit(0)"',
              tags: [],
              match_all: true,
              cwd: os.tmpdir(),
              env: { AIDASH_TEST_FLAG: '1' },
              timeout_seconds: 5,
            },
          ],
        }),
        logger,
        signal: new AbortController().signal,
      },
      'once',
    );
    const names = calls.map((call) => call.name);
    const register = calls.find((call) => call.name === 'harness.register')!;
    expect(register.args).toMatchObject({ harness_id: 'h-branch', capabilities: ['dev'] });
    expect(typeof register.args.host).toBe('string'); // host 缺省时回落 os.hostname()

    expect(names.indexOf('task.claim')).toBeLessThan(names.indexOf('task.update'));
    expect(calls.filter((call) => call.name === 'task.update')).toHaveLength(2);
    const complete = calls.find(
      (call) => call.name === 'task.update' && call.args.event === 'complete',
    )!;
    expect(complete.args).toMatchObject({
      task_id: 'tk_ok',
      claim_token: 'cl_ok',
      evidence_card_ids: ['cd_ok'],
    });
    const card = calls.find((call) => call.name === 'card.post')!;
    expect(card.args).toMatchObject({ type: 'status', result: 'success', task_id: 'tk_ok' });
    expect(String(card.args.summary)).toContain('命令执行成功');
    expect(entries.some((entry) => entry.message.includes('已完成（证据卡 cd_ok）'))).toBe(true);
  }, 20_000);

  it('失败命令：发失败卡并 fail（无 evidence）', async () => {
    const task = makeTask({ id: 'tk_bad' });
    const { client, calls } = scriptedClient((name) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') return { task, claim_token: 'cl_bad' };
      if (name === 'card.post') return { card_id: 'cd_bad' };
      return { ok: true, data: {} };
    });
    await runWatch(
      {
        client,
        config: makeConfig({
          commands: [{ command: 'node -e "process.exit(5)"', tags: [], match_all: true }],
        }),
        logger: fakeLogger().logger,
        signal: new AbortController().signal,
      },
      'once',
    );
    const fail = calls.find((call) => call.name === 'task.update' && call.args.event === 'fail')!;
    expect(fail).toBeDefined();
    expect(String(fail.args.reason)).toContain('退出码 5');
    expect(calls.some((call) => call.args.event === 'complete')).toBe(false);
  }, 20_000);

  it('发卡失败：释放任务并把错误向上抛（不会假完成）', async () => {
    const task = makeTask({ id: 'tk_card_fail' });
    const { client, calls } = scriptedClient((name) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') return { task, claim_token: 'cl_cf' };
      if (name === 'card.post') throw new TransportError('卡片服务不可用');
      return { ok: true, data: {} };
    });
    const error = await captureError(
      runWatch(
        { client, config: makeConfig(), logger: fakeLogger().logger, signal: new AbortController().signal },
        'once',
      ),
    );
    expect(error).toBeInstanceOf(TransportError);
    const release = calls.find((call) => call.name === 'task.release');
    expect(release).toBeDefined();
    expect(String(release!.args.reason)).toContain('值守壳异常');
    expect(calls.some((call) => call.name === 'task.update' && call.args.event === 'complete')).toBe(
      false,
    );
  }, 20_000);

  it('命令被外部中断：释放任务，不发卡', async () => {
    const controller = new AbortController();
    const task = makeTask({ id: 'tk_abort' });
    const { client, calls } = scriptedClient((name) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') return { task, claim_token: 'cl_abort' };
      return { ok: true, data: {} };
    });
    const timer = setTimeout(() => controller.abort(), 250);
    try {
      await runWatch(
        {
          client,
          config: makeConfig({
            commands: [{ command: 'node -e "setTimeout(()=>{},5000)"', tags: [], match_all: true }],
          }),
          logger: fakeLogger().logger,
          signal: controller.signal,
        },
        'once',
      );
    } finally {
      clearTimeout(timer);
    }
    const release = calls.find((call) => call.name === 'task.release');
    expect(release).toBeDefined();
    expect(String(release!.args.reason)).toContain('进程被中断');
    expect(calls.some((call) => call.name === 'card.post')).toBe(false);
  }, 20_000);

  it('心跳 401 导致命令中断时：不再释放（避免错误令牌继续打服务端）', async () => {
    let authFail = false;
    const task = makeTask({ id: 'tk_hb_auth' });
    const { client, calls } = scriptedClient((name, args) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') return { task, claim_token: 'cl_hb' };
      if (name === 'task.update') {
        if (args.event === 'start') authFail = true;
        return { ok: true, data: {} };
      }
      if (name === 'harness.heartbeat') {
        if (authFail) throw new AuthError('401 令牌失效');
        return { ok: true, data: {} };
      }
      return { ok: true, data: {} };
    });
    const error = await captureError(
      runWatch(
        {
          client,
          config: makeConfig({
            heartbeat_interval_seconds: 0.02,
            commands: [{ command: 'node -e "setTimeout(()=>{},5000)"', tags: [], match_all: true }],
          }),
          logger: fakeLogger().logger,
          signal: new AbortController().signal,
        },
        'once',
      ),
    );
    expect(error).toBeInstanceOf(AuthError);
    expect(calls.some((call) => call.name === 'task.release')).toBe(false);
  }, 20_000);

  it('续租返回 CONFLICT：终止命令并以 LEASE_LOST 退出（不释放）', async () => {
    const task = makeTask({ id: 'tk_lease_lost' });
    let leaseAttempts = 0;
    const { client, calls } = scriptedClient((name, args) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') {
        if (args.claim_token !== undefined) {
          leaseAttempts += 1;
          throw new BusinessError('CONFLICT', '租约已被回收');
        }
        return { task, claim_token: 'cl_lease' };
      }
      return { ok: true, data: {} };
    });
    const startedAt = Date.now();
    const error = await captureError(
      runWatch(
        {
          client,
          config: makeConfig({
            lease_seconds: 3,
            commands: [{ command: 'node -e "setTimeout(()=>{},5000)"', tags: [], match_all: true }],
          }),
          logger: fakeLogger().logger,
          signal: new AbortController().signal,
        },
        'once',
      ),
    );
    expect(error).toBeInstanceOf(BusinessError);
    expect((error as BusinessError).code).toBe('LEASE_LOST');
    expect(leaseAttempts).toBeGreaterThanOrEqual(1);
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(calls.some((call) => call.name === 'task.release')).toBe(false);
  }, 20_000);

  it('续租返回 401：以 AuthError 退出，不释放', async () => {
    const task = makeTask({ id: 'tk_lease_auth' });
    let leaseAttempts = 0;
    const { client, calls } = scriptedClient((name, args) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') {
        if (args.claim_token !== undefined) {
          leaseAttempts += 1;
          throw new AuthError('401 令牌失效');
        }
        return { task, claim_token: 'cl_lease_auth' };
      }
      return { ok: true, data: {} };
    });
    const error = await captureError(
      runWatch(
        {
          client,
          config: makeConfig({
            lease_seconds: 3,
            commands: [{ command: 'node -e "setTimeout(()=>{},5000)"', tags: [], match_all: true }],
          }),
          logger: fakeLogger().logger,
          signal: new AbortController().signal,
        },
        'once',
      ),
    );
    expect(error).toBeInstanceOf(AuthError);
    expect(leaseAttempts).toBeGreaterThanOrEqual(1);
    expect(calls.some((call) => call.name === 'task.release')).toBe(false);
  }, 20_000);

  it('续租遇到临时传输错误：只告警，命令继续并正常完成', async () => {
    const task = makeTask({ id: 'tk_lease_retry' });
    const { client, calls } = scriptedClient((name, args) => {
      if (name === 'task.list') return { items: [task], has_more: false };
      if (name === 'task.claim') {
        if (args.claim_token !== undefined) throw new TransportError('续租网络抖动');
        return { task, claim_token: 'cl_lease_retry' };
      }
      if (name === 'card.post') return { card_id: 'cd_lease_retry' };
      return { ok: true, data: {} };
    });
    const { logger, entries } = fakeLogger();
    await runWatch(
      {
        client,
        config: makeConfig({
          lease_seconds: 3,
          commands: [
            { command: 'node -e "setTimeout(()=>process.exit(0),1400)"', tags: [], match_all: true },
          ],
        }),
        logger,
        signal: new AbortController().signal,
      },
      'once',
    );
    expect(
      entries.some((entry) => entry.level === 'warn' && entry.message.includes('续租失败')),
    ).toBe(true);
    expect(calls.some((call) => call.name === 'task.update' && call.args.event === 'complete')).toBe(
      true,
    );
  }, 20_000);

  it('有活可干时下一轮按 gap_seconds 等待（而不是 poll_interval）', async () => {
    const task = makeTask({ id: 'tk_gap' });
    let listCalls = 0;
    let completeAt = 0;
    let secondListAt = 0;
    const { client } = scriptedClient((name, args) => {
      if (name === 'task.list') {
        listCalls += 1;
        if (listCalls === 1) return { items: [task], has_more: false };
        secondListAt = Date.now();
        throw new BusinessError('STOP', '结束计时');
      }
      if (name === 'task.claim') return { task, claim_token: 'cl_gap' };
      if (name === 'task.update') {
        if (args.event === 'complete') completeAt = Date.now();
        return { ok: true, data: {} };
      }
      if (name === 'card.post') return { card_id: 'cd_gap' };
      return { ok: true, data: {} };
    });
    const error = await captureError(
      runWatch(
        {
          client,
          config: makeConfig({ gap_seconds: 0.15, poll_interval_seconds: 5 }),
          logger: fakeLogger().logger,
          signal: new AbortController().signal,
        },
        'run',
      ),
    );
    expect((error as BusinessError).code).toBe('STOP');
    expect(completeAt).toBeGreaterThan(0);
    expect(secondListAt - completeAt).toBeGreaterThanOrEqual(120);
    // 若误用 poll_interval（5s），这里会明显超界。
    expect(secondListAt - completeAt).toBeLessThan(2_000);
  }, 20_000);

  it('无活可干时下一轮按 poll_interval_seconds 等待（而不是 gap）', async () => {
    let listCalls = 0;
    let firstListAt = 0;
    let secondListAt = 0;
    const { client } = scriptedClient((name) => {
      if (name === 'task.list') {
        listCalls += 1;
        if (listCalls === 1) {
          firstListAt = Date.now();
          return { items: [], has_more: false };
        }
        secondListAt = Date.now();
        throw new BusinessError('STOP', '结束计时');
      }
      return { ok: true, data: {} };
    });
    const error = await captureError(
      runWatch(
        {
          client,
          config: makeConfig({ gap_seconds: 5, poll_interval_seconds: 0.15 }),
          logger: fakeLogger().logger,
          signal: new AbortController().signal,
        },
        'run',
      ),
    );
    expect((error as BusinessError).code).toBe('STOP');
    expect(secondListAt - firstListAt).toBeGreaterThanOrEqual(120);
    expect(secondListAt - firstListAt).toBeLessThan(2_000);
  }, 20_000);

  it('listTasks：最多拉 10 页；空页提前停止；筛选参数按需附加', async () => {
    const alwaysMore = {
      call: vi.fn(async () => ({ items: [{ id: 'tk_page' }], has_more: true })),
    };
    const items = await listTasks(alwaysMore as unknown as AidashMcpClient, {
      status: 'pending',
      assignee: 'h1',
    });
    expect(items).toHaveLength(10);
    expect(alwaysMore.call).toHaveBeenCalledTimes(10);
    expect(alwaysMore.call.mock.calls[0]![1]).toMatchObject({
      page: 1,
      page_size: 100,
      status: 'pending',
      assignee: 'h1',
    });
    expect(alwaysMore.call.mock.calls[9]![1]).toMatchObject({ page: 10 });

    const emptyPage = {
      call: vi.fn(async () => ({ items: [], has_more: true })),
    };
    await expect(listTasks(emptyPage as unknown as AidashMcpClient)).resolves.toEqual([]);
    expect(emptyPage.call).toHaveBeenCalledTimes(1);

    const noFilter = {
      call: vi.fn(async () => ({ items: [], has_more: false })),
    };
    await listTasks(noFilter as unknown as AidashMcpClient);
    const args = noFilter.call.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('status');
    expect(args).not.toHaveProperty('assignee');
  });
});
