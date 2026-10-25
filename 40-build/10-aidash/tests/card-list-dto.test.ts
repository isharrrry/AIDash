import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  createHarness,
  mcp,
  mcpToolData,
  questionPayload,
  seedTask,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

const CHANNEL = 'devhost/myproj/card-list-dto';

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

/** 只列出本用例关心的字段，避免把 CardView 全量抄一遍。 */
interface ListedCard {
  id: string;
  body_md: string | null;
  background_md: string | null;
  goal_md: string | null;
  research_md: string | null;
  decision_md: string | null;
  message_md: string | null;
  preview_md: string | null;
}

interface CardPage {
  total: number;
  items: ListedCard[];
}

const HEAVY_FIELDS = [
  'body_md',
  'background_md',
  'goal_md',
  'research_md',
  'decision_md',
  'message_md',
] as const;

function expectHeavyNull(card: ListedCard): void {
  for (const field of HEAVY_FIELDS) expect(card[field]).toBeNull();
}

function infoPayload(taskId: string, bodyMd: string): Record<string, unknown> {
  return {
    channel_key: CHANNEL,
    type: 'info',
    title: '列表瘦身验证',
    body_md: bodyMd,
    severity: 'info',
    task_id: taskId,
  };
}

describe('卡片列表 DTO 瘦身', () => {
  it('默认列表重字段为 null，preview_md 保留 Markdown 并截断 240 字；详情仍完整', async () => {
    const { h, a } = await boot();
    const taskId = seedTask(h, CHANNEL);
    const body = `**摘要**\n${'甲'.repeat(300)}`;
    const created = await api<{ card: { id: string } }>(
      a,
      'POST',
      '/api/cards',
      infoPayload(taskId, body),
    );
    const cardId = created.body.data!.card.id;

    const listed = await api<CardPage>(
      a,
      'GET',
      `/api/cards?channel_key=${encodeURIComponent(CHANNEL)}`,
    );
    const card = listed.body.data!.items[0]!;
    expectHeavyNull(card);
    // 预览截断发生在服务层：保留 Markdown 符号，长度固定 240。
    expect(card.preview_md).toBe(body.slice(0, 240));
    expect(card.preview_md).toContain('**摘要**');
    expect(card.preview_md).toHaveLength(240);

    // 详情路径不瘦身：GET /api/cards/{id} 和服务层 get 都返回完整正文。
    const detail = await api<{ body_md: string | null; preview_md: string | null }>(
      a,
      'GET',
      `/api/cards/${cardId}`,
    );
    expect(detail.body.data?.body_md).toBe(body);
    expect(detail.body.data?.preview_md).toBe(body.slice(0, 240));
    expect(h.ctx.services.cards.get(cardId).body_md).toBe(body);
  });

  it('include_body=true 时 REST 返回完整重字段；默认 question 用 background 做预览', async () => {
    const { h, a } = await boot();
    const taskId = seedTask(h, CHANNEL);
    await api(a, 'POST', '/api/cards', infoPayload(taskId, '信息卡完整正文'));
    await api(
      a,
      'POST',
      '/api/cards',
      questionPayload({
        channel_key: CHANNEL,
        type: 'question',
        title: '默认预览从背景取',
        background_md: '背景：登录 500 持续 10 分钟',
        goal_md: '目标：10 分钟内恢复登录',
        research_md: '调查参考：回滚约 10 分钟',
        decision_md: '决策项：先回滚还是先修白名单',
      }),
    );
    await api(a, 'POST', '/api/cards', {
      channel_key: CHANNEL,
      type: 'handoff',
      title: '交接给运维',
      recipient: '运维同学',
      channel_kind: 'wechat',
      reason: '确认白名单',
      message_md: '运维同学您好，请确认 192.0.2.15 是否放行。',
      task_id: taskId,
    });

    const url = `/api/cards?channel_key=${encodeURIComponent(CHANNEL)}`;
    const defaultPage = await api<CardPage>(a, 'GET', url);
    const defaultQuestion = defaultPage.body.data!.items.find(
      (item) => item.background_md === null && item.preview_md?.startsWith('背景：'),
    );
    expect(defaultQuestion?.preview_md).toBe('背景：登录 500 持续 10 分钟');
    for (const card of defaultPage.body.data!.items) expectHeavyNull(card);

    const fullPage = await api<CardPage>(a, 'GET', `${url}&include_body=true`);
    const info = fullPage.body.data!.items.find((item) => item.body_md !== null)!;
    const question = fullPage.body.data!.items.find((item) => item.goal_md !== null)!;
    const handoff = fullPage.body.data!.items.find((item) => item.message_md !== null)!;
    expect(info.body_md).toBe('信息卡完整正文');
    expect(question.background_md).toBe('背景：登录 500 持续 10 分钟');
    expect(question.research_md).toBe('调查参考：回滚约 10 分钟');
    expect(question.decision_md).toBe('决策项：先回滚还是先修白名单');
    expect(handoff.message_md).toBe('运维同学您好，请确认 192.0.2.15 是否放行。');
  });

  it('MCP card.list 同样默认省略正文，include_body=true 才透传全文', async () => {
    const { a } = await boot();
    await api(
      a,
      'POST',
      '/api/cards',
      questionPayload({ channel_key: CHANNEL, type: 'question', title: 'MCP 参数透传' }),
    );

    const list = (arguments_: Record<string, unknown>) =>
      mcp(a, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'card.list', arguments: arguments_ },
      });

    const defaultPage = mcpToolData(await list({ channel_key: CHANNEL })) as CardPage;
    expect(defaultPage.items[0]?.preview_md).toBe('背景：登录 500 持续 10 分钟');
    expectHeavyNull(defaultPage.items[0]!);

    const fullPage = mcpToolData(
      await list({ channel_key: CHANNEL, include_body: true }),
    ) as CardPage;
    expect(fullPage.items[0]?.background_md).toBe('背景：登录 500 持续 10 分钟');
    expect(fullPage.items[0]?.goal_md).toBe('目标：10 分钟内恢复登录');
    expect(fullPage.items[0]?.research_md).toBe('调查参考：回滚约 10 分钟；修白名单约 30 分钟');
  });

  it('预览按 body → background → goal 回退，空白正文视为空，所有来源都空时为 null', async () => {
    const { h, a } = await boot();
    const { channel } = h.ctx.services.channels.ensure({ channel_key: CHANNEL }, testCtx());
    const now = h.clock.now();
    const insert = (id: string, overrides: Record<string, unknown>) => {
      // question 的库级约束只要求 background_md/options_json 非 NULL，
      // 这里用直接写库模拟历史数据的各种“空正文”形态。
      h.db
        .prepare(
          `INSERT INTO card
             (id, channel_id, type, title, body_md, background_md, goal_md,
              options_json, created_at, updated_at)
           VALUES (?, ?, 'question', ?, ?, ?, ?, '[]', ?, ?)`,
        )
        .run(
          id,
          channel.id,
          id,
          overrides.body_md ?? null,
          overrides.background_md ?? null,
          overrides.goal_md ?? null,
          now,
          now,
        );
    };
    insert('cd_preview_body_blank', {
      body_md: '   ',
      background_md: '背景正文',
      goal_md: '目标正文',
    });
    insert('cd_preview_goal_only', {
      body_md: null,
      background_md: '',
      goal_md: '目标正文',
    });
    insert('cd_preview_empty', { body_md: '\n\t', background_md: ' ', goal_md: '  ' });

    const listed = await api<CardPage>(
      a,
      'GET',
      `/api/cards?channel_key=${encodeURIComponent(CHANNEL)}&include_body=true`,
    );
    const byId = new Map(listed.body.data!.items.map((card) => [card.id, card]));
    // 空白 body 被跳过，回退到 background；Markdown 原文不被压平。
    expect(byId.get('cd_preview_body_blank')?.preview_md).toBe('背景正文');
    expect(byId.get('cd_preview_goal_only')?.preview_md).toBe('目标正文');
    expect(byId.get('cd_preview_empty')?.preview_md).toBeNull();
  });
});
