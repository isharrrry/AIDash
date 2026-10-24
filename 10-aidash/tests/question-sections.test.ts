import { afterEach, describe, expect, it } from 'vitest';
import { cardAskSchema, cardPostSchema } from '../src/shared/schemas.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import {
  api,
  createHarness,
  mcp,
  mcpToolData,
  questionOptions,
  questionPayload,
  seedTask,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

const CHANNEL = 'devhost/myproj/question-sections';

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

/** 取出校验失败的字段路径，便于断言“是缺字段本身报错”。 */
function issuePaths(result: ReturnType<typeof cardPostSchema.safeParse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('question 四段背景', () => {
  it('缺 goal_md / research_md / decision_md 任一字段都被拒绝', () => {
    for (const field of ['goal_md', 'research_md', 'decision_md'] as const) {
      const payload = questionPayload({ type: 'question' });
      delete payload[field];
      const result = cardPostSchema.safeParse(payload);
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain(field);
    }
  });

  it('REST 入口对缺段返回 VALIDATION_FAILED，且不落库', async () => {
    const { a } = await boot();
    const payload = questionPayload({ channel_key: CHANNEL, type: 'question' });
    delete payload.research_md;
    const rejected = await api(a, 'POST', '/api/cards', payload);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.message).toBe('VALIDATION_FAILED');

    const list = await api<{ total: number }>(a, 'GET', `/api/cards?project=myproj`);
    expect(list.body.data?.total).toBe(0);
  });
});

describe('question 选项规则', () => {
  it('任一选项缺 pros_md 或 cons_md 都被拒绝', () => {
    for (const field of ['pros_md', 'cons_md'] as const) {
      const options = questionOptions(['a', 'b']);
      delete options[0]![field];
      const result = cardPostSchema.safeParse(
        questionPayload({ type: 'question', options }),
      );
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain(`options.0.${field}`);
    }
  });

  it('主推荐不是恰好 1 个被拒绝', () => {
    const noPrimary = questionOptions(['a', 'b']).map((option) => ({
      ...option,
      recommendation_role: option.id === 'b' ? 'backup' : null,
    }));
    expect(cardPostSchema.safeParse(questionPayload({ options: noPrimary })).success).toBe(false);

    const twoPrimary = questionOptions(['a', 'b']).map((option) => ({
      ...option,
      recommendation_role: 'primary',
    }));
    expect(cardPostSchema.safeParse(questionPayload({ options: twoPrimary })).success).toBe(false);
  });

  it('备选推荐不是恰好 1 个被拒绝', () => {
    const noBackup = questionOptions(['a', 'b']).map((option) => ({
      ...option,
      recommendation_role: option.id === 'a' ? 'primary' : null,
    }));
    expect(cardPostSchema.safeParse(questionPayload({ options: noBackup })).success).toBe(false);

    const twoBackup = questionOptions(['a', 'b']).map((option) => ({
      ...option,
      recommendation_role: 'backup',
    }));
    expect(cardPostSchema.safeParse(questionPayload({ options: twoBackup })).success).toBe(false);
  });

  it('card.ask 复用同一套规则，缺段时 MCP 返回 isError', async () => {
    const { a } = await boot();
    const payload = questionPayload({ channel_key: CHANNEL });
    delete payload.goal_md;
    const result = await mcp(a, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'card.ask', arguments: { ...payload, wait_seconds: 0 } },
    });
    expect(result.result).toMatchObject({ isError: true });
    expect((result.result as { content: Array<{ text: string }> }).content[0]?.text).toContain(
      'goal_md',
    );
  });
});

describe('卡片读取与 project 过滤', () => {
  it('card.get 返回四段背景与选项的 pros_md/cons_md/recommendation_role', async () => {
    const { h } = await boot();
    const input = cardPostSchema.parse(
      questionPayload({
        channel_key: CHANNEL,
        type: 'question',
        options: questionOptions(['rollback', 'fix']),
      }),
    ) as CardPostInput;
    const card = h.ctx.services.cards.post(input, testCtx()).card;

    const view = h.ctx.services.cards.get(card.id);
    expect(view.background_md).toContain('背景');
    expect(view.goal_md).toContain('目标');
    expect(view.research_md).toContain('调查参考');
    expect(view.decision_md).toContain('决策项');
    expect(view.options[0]).toMatchObject({
      id: 'rollback',
      pros_md: expect.stringContaining('优点'),
      cons_md: expect.stringContaining('缺点'),
      recommendation_role: 'primary',
    });
    expect(view.options[1]?.recommendation_role).toBe('backup');
  });

  it('card.list 按 project 过滤，REST 与 MCP 口径一致', async () => {
    const { h, a } = await boot();
    const info = (channelKey: string) => ({
      channel_key: channelKey,
      type: 'info',
      title: channelKey,
      body_md: '正文',
      severity: 'info',
      task_id: seedTask(h, channelKey, `${channelKey} 的承载任务`),
    });
    await api(a, 'POST', '/api/cards', info('devhost/proj-a/topic-one'));
    await api(a, 'POST', '/api/cards', info('devhost/proj-b/topic-one'));

    const rest = await api<{ total: number; items: Array<{ channel_key: string }> }>(
      a,
      'GET',
      '/api/cards?project=proj-a',
    );
    expect(rest.body.data?.total).toBe(1);
    expect(rest.body.data?.items[0]?.channel_key).toBe('devhost/proj-a/topic-one');

    const mcpResult = await mcp(a, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'card.list', arguments: { project: 'proj-b' } },
    });
    const page = mcpToolData(mcpResult) as {
      total: number;
      items: Array<{ channel_key: string }>;
    };
    expect(page.total).toBe(1);
    expect(page.items[0]?.channel_key).toBe('devhost/proj-b/topic-one');
  });
});
