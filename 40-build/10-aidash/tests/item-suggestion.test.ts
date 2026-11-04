import { afterEach, describe, expect, it } from 'vitest';
import { taskCreateSchema } from '../src/shared/schemas.js';
import {
  grepCorpus,
  parseSuggestionAction,
  type SuggestionDoc,
} from '../src/server/services/item-suggestion-service.js';
import { startFakeLlm, type FakeLlm } from './fakes/fake-llm.js';
import { api, createHarness, startApp, testCtx, type RunningApp, type TestHarness } from './helpers.js';

/**
 * 事项 AI 建议。
 *
 * 重点不是“模型说了什么”，而是：
 *  - 生成前确实在本事项的数据里做了 grep，并把命中证据交给模型；
 *  - 模型只回一段建议时，能解析并落库到 channel.meta_json；
 *  - 没配 LLM 时明确失败，不悄悄返回空建议。
 */
const CHANNEL = 'devhost/suggestion-proj/item';

let harness: TestHarness | null = null;
let app: RunningApp | null = null;
const fakes: FakeLlm[] = [];

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  if (app) await app.close();
  harness?.close();
  app = null;
  harness = null;
});

function configure(h: TestHarness, fake: FakeLlm): void {
  h.ctx.services.settings.update(
    {
      llm_endpoint: fake.base,
      llm_model: 'deepseek-flash',
      llm_api_key: 'sk-page-key',
    },
    testCtx(),
  );
}

function seed(h: TestHarness): void {
  h.ctx.services.channels.ensure({ channel_key: CHANNEL, title: '登录改造' }, testCtx());
  h.ctx.services.tasks.create(
    taskCreateSchema.parse({
      channel_key: CHANNEL,
      title: '修复登录回调 500',
      description_md: '回调地址在白名单缺失，需要补上 staging 域名',
      submit: true,
    }),
    testCtx(),
  );
}

describe('grep 与模型输出解析', () => {
  const docs: SuggestionDoc[] = [
    {
      source: '任务',
      ref: 'tk_1',
      title: '修复登录回调',
      text: '修复登录回调 500。回调地址在白名单缺失',
    },
    {
      source: '卡片',
      ref: 'cd_1',
      title: '登录发布决策',
      text: '决定先修 staging 白名单，再发生产',
    },
  ];

  it('整词优先，整词不中时退到分词命中', () => {
    expect(grepCorpus(docs, '登录回调', 5)[0]?.ref).toBe('tk_1');
    expect(grepCorpus(docs, '白名单 staging', 5).length).toBeGreaterThan(0);
  });

  it('grep / final 两种 JSON 都能解析，散文建议也能兜底', () => {
    expect(
      parseSuggestionAction('{"action":"grep","queries":["白名单"," staging "]}'),
    ).toEqual({ action: 'grep', queries: ['白名单', 'staging'] });
    expect(
      parseSuggestionAction('```json\n{"action":"final","suggestion":"先补白名单"}\n```'),
    ).toEqual({ action: 'final', suggestion: '先补白名单' });
    expect(parseSuggestionAction('直接给出的建议')).toBeNull();
  });
});

describe('事项建议：服务与 REST', () => {
  it('先 grep 本事项数据，再用模型结果写回 meta_json', async () => {
    const h = createHarness();
    harness = h;
    seed(h);
    const fake = await startFakeLlm(
      '{"action":"final","suggestion":"先补齐 staging 回调白名单，再验证登录链路。"}',
    );
    fakes.push(fake);
    configure(h, fake);

    const result = await h.ctx.services.itemSuggestions.generate(CHANNEL);
    expect(result.suggestion).toContain('staging');
    expect(result.greps).toBeGreaterThan(0);
    expect(result.evidence_count).toBeGreaterThan(0);
    expect(result.model).toBe('deepseek-flash');
    // 初始关键词检索是服务端本地行为，模型只被调用一次（给最终建议）。
    expect(fake.requests).toHaveLength(1);
    const user = fake.requests[0]?.body.messages?.at(-1)?.content ?? '';
    expect(user).toContain(CHANNEL);
    expect(user).toContain('修复登录回调 500');
    expect(user).toContain('已执行 grep');

    const a = await startApp(h);
    app = a;
    const response = await api<{
      suggestion: string;
      channel: { meta: { ai_suggestion: string | null; ai_suggestion_at: string | null } };
    }>(a, 'POST', `/api/channels/${encodeURIComponent(CHANNEL)}/suggestion`);
    expect(response.status).toBe(200);
    expect(response.body.data?.channel.meta.ai_suggestion).toContain('staging');
    expect(response.body.data?.channel.meta.ai_suggestion_at).toBeTruthy();
  });

  it('没配 LLM 时明确报 LLM_NOT_CONFIGURED，不返回空建议', async () => {
    const h = createHarness();
    harness = h;
    seed(h);

    await expect(h.ctx.services.itemSuggestions.generate(CHANNEL)).rejects.toMatchObject({
      message: 'LLM_NOT_CONFIGURED',
    });
  });
});
