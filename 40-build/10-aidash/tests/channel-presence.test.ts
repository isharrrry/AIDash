import { afterEach, describe, expect, it } from 'vitest';
import { taskCreateSchema } from '../src/shared/schemas.js';
import {
  api,
  createHarness,
  mcp,
  mcpToolData,
  seedTask,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

const CHANNEL = 'devhost/presence/topic';

let harness: TestHarness | null = null;
let app: RunningApp | null = null;

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

async function callTool(
  a: RunningApp,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await mcp(a, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return mcpToolData(result);
}

interface ChannelRow {
  channel_key: string;
  open_task_count: number;
  last_mcp_at: string | null;
  agent_online: boolean;
}

async function readChannel(a: RunningApp): Promise<ChannelRow> {
  const res = await api<{ items: ChannelRow[] }>(a, 'GET', '/api/channels?q=presence');
  const row = res.body.data?.items.find((item) => item.channel_key === CHANNEL);
  if (!row) throw new Error('测试通道未创建');
  return row;
}

/** 让入口的 0ms 补记定时器跑完（首次建通道时执行前查不到 id）。 */
function flushTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('通道在线判定', () => {
  it('有未结束任务但没有 MCP 活动时，仍显示已停止', async () => {
    const { h, a } = await boot();

    // 模拟“上次会话排了活但没做”：通道和 pending 任务都存在，却没有 MCP 调用。
    h.ctx.services.channels.ensure({ channel_key: CHANNEL, title: '上轮遗留' }, testCtx());
    h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '排期但未开始' }),
      testCtx(),
      { submit: true },
    );

    const row = await readChannel(a);
    expect(row.open_task_count).toBe(1);
    expect(row.last_mcp_at).toBeNull();
    // 核心回归点：未结束任务 ≠ agent 在线。
    expect(row.agent_online).toBe(false);
  });

  it('MCP 调用刷新在线；超过阈值自动停止；再调用恢复在线', async () => {
    const { h, a } = await boot();

    await callTool(a, 'channel.upsert', { channel_key: CHANNEL, title: '在线测试' });
    await flushTimers();

    const online = await readChannel(a);
    expect(online.last_mcp_at).not.toBeNull();
    expect(online.agent_online).toBe(true);

    // 阈值边界：恰好 180 秒仍算在线，多 1 毫秒就算停止。
    h.clock.advance(180_000);
    expect((await readChannel(a)).agent_online).toBe(true);
    h.clock.advance(1);
    expect((await readChannel(a)).agent_online).toBe(false);

    // 读操作也算活动：task.list 没有写任何数据，但证明 agent 还连着。
    await callTool(a, 'task.list', { channel_key: CHANNEL });
    expect((await readChannel(a)).agent_online).toBe(true);
  });

  it('只带 card_id 的读取也能反查到通道', async () => {
    const { h, a } = await boot();

    await callTool(a, 'channel.upsert', { channel_key: CHANNEL });
    await flushTimers();
    const taskId = seedTask(h, CHANNEL, '承载卡片的草稿');
    const posted = (await callTool(a, 'card.post', {
      channel_key: CHANNEL,
      type: 'info',
      title: '一条信息',
      body_md: '正文',
      severity: 'info',
      task_id: taskId,
    })) as { card: { id: string } };

    h.clock.advance(181_000);
    expect((await readChannel(a)).agent_online).toBe(false);

    // card.get 只带 card_id；入口必须通过卡片反查通道，否则读操作永远不算在线。
    await callTool(a, 'card.get', { card_id: posted.card.id });
    expect((await readChannel(a)).agent_online).toBe(true);
  });
});
