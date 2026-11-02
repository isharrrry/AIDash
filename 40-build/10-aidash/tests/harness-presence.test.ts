import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  createHarness,
  mcp,
  mcpToolData,
  startApp,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

/**
 * harness 运行态（busy/idle）与在线状态（online/offline/disabled）是两轴。
 *
 * 这些用例盯的是“runner 阻塞执行时仍能显示正确状态”的契约：
 * - 心跳 status_hint 必须落库，并由 /api/harnesses 暴露成 presence；
 * - 不传 status_hint 的老客户端不能把已有的 busy 抹掉；
 * - 人工 disabled、离线回收、重新注册都要把运行态清干净。
 */

let harness: TestHarness | null = null;
let app: RunningApp | null = null;
let rpcId = 0;

async function boot(): Promise<{ h: TestHarness; a: RunningApp }> {
  harness = createHarness();
  app = await startApp(harness);
  return { h: harness, a: app };
}

afterEach(async () => {
  if (app) await app.close();
  harness?.close();
  app = null;
  harness = null;
});

async function callTool(a: RunningApp, name: string, args: Record<string, unknown>) {
  const payload = await mcp(a, {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return mcpToolData(payload) as Record<string, unknown>;
}

async function heartbeat(a: RunningApp, args: Record<string, unknown>) {
  return (await callTool(a, 'harness.heartbeat', args)) as {
    status: string;
    busy: boolean;
    presence: string;
    last_seen: number;
    server_time: number;
  };
}

interface HarnessApiRow {
  harness_id: string;
  status: string;
  busy: boolean;
  busy_at: string | null;
  presence: string;
}

async function listHarnesses(a: RunningApp): Promise<HarnessApiRow[]> {
  const res = await api<HarnessApiRow[]>(a, 'GET', '/api/harnesses');
  return res.body.data ?? [];
}

describe('harness 运行态', () => {
  it('busy/idle 心跳落库并通过 API 暴露四态', async () => {
    const { h, a } = await boot();
    await callTool(a, 'harness.register', { harness_id: 'h-presence', name: 'Presence' });

    // 注册后默认空闲在线。
    let row = (await listHarnesses(a))[0]!;
    expect(row.presence).toBe('idle');
    expect(row.busy).toBe(false);

    const now = h.clock.now();
    const busy = await heartbeat(a, { harness_id: 'h-presence', status_hint: 'busy' });
    expect(busy.presence).toBe('busy');
    expect(busy.busy).toBe(true);
    expect(busy.last_seen).toBe(now);

    expect(h.ctx.repos.harnesses.get('h-presence')?.busy).toBe(1);
    expect(h.ctx.repos.harnesses.get('h-presence')?.busy_at).toBe(now);

    h.clock.advance(60_000);
    row = (await listHarnesses(a))[0]!;
    expect(row.presence).toBe('busy');
    expect(row.busy).toBe(true);
    expect(row.busy_at).toBe(new Date(now).toISOString());

    const idle = await heartbeat(a, { harness_id: 'h-presence', status_hint: 'idle' });
    expect(idle.presence).toBe('idle');
    expect(idle.busy).toBe(false);
    expect(h.ctx.repos.harnesses.get('h-presence')?.busy).toBe(0);
  });

  it('省略 status_hint 时保留上一次 busy，不把执行中的执行器误标成空闲', async () => {
    const { h, a } = await boot();
    await callTool(a, 'harness.register', { harness_id: 'h-old-client', name: 'Old' });
    await heartbeat(a, { harness_id: 'h-old-client', status_hint: 'busy' });

    const plain = await heartbeat(a, { harness_id: 'h-old-client' });
    expect(plain.busy).toBe(true);
    expect(plain.presence).toBe('busy');
    expect(h.ctx.repos.harnesses.get('h-old-client')?.busy).toBe(1);
  });

  it('disabled 优先于 busy；心跳只刷新 last_seen，不解除封禁', async () => {
    const { a } = await boot();
    await callTool(a, 'harness.register', { harness_id: 'h-ban', name: 'Ban' });
    await heartbeat(a, { harness_id: 'h-ban', status_hint: 'busy' });
    await api(a, 'PATCH', '/api/harnesses/h-ban', { status: 'disabled' });

    const beat = await heartbeat(a, { harness_id: 'h-ban', status_hint: 'busy' });
    expect(beat.status).toBe('disabled');
    expect(beat.presence).toBe('disabled');

    const row = (await listHarnesses(a))[0]!;
    expect(row.status).toBe('disabled');
    expect(row.presence).toBe('disabled');
  });

  it('重新注册与离线回收都会清空 busy', async () => {
    const { h, a } = await boot();
    await callTool(a, 'harness.register', { harness_id: 'h-reset', name: 'Reset' });
    await heartbeat(a, { harness_id: 'h-reset', status_hint: 'busy' });
    expect(h.ctx.repos.harnesses.get('h-reset')?.busy).toBe(1);

    await callTool(a, 'harness.register', { harness_id: 'h-reset', name: 'Reset' });
    expect(h.ctx.repos.harnesses.get('h-reset')?.busy).toBe(0);
    expect(h.ctx.repos.harnesses.get('h-reset')?.busy_at).toBeNull();

    await heartbeat(a, { harness_id: 'h-reset', status_hint: 'busy' });
    const now = h.clock.now();
    expect(h.ctx.repos.harnesses.markOffline(now + 1, now + 2)).toBe(1);
    const row = h.ctx.repos.harnesses.get('h-reset')!;
    expect(row.status).toBe('offline');
    expect(row.busy).toBe(0);
  });
});
