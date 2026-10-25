import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '../src/shared/errors.js';
import { cardPostSchema, taskCreateSchema } from '../src/shared/schemas.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import { startFakeLlm, type FakeLlm } from './fakes/fake-llm.js';
import { createHarness, testCtx, type TestHarness } from './helpers.js';

/**
 * LLM 失败路径。
 *
 * 为什么单独一个文件：
 * 顺利路径（请求形状、档位、提示词选择）已经在 llm-config.test.ts 里测过了。
 * 这里只回答一个问题——**上游出各种幺蛾子时，系统会不会把脏东西漏给用户。**
 *
 * 每条用例都对应一个真实可能发生的故障：
 * - 429：DeepSeek 限流，高峰期很常见；
 * - 坏 JSON：网关 502 时回一坨 HTML，content-type 还写着 application/json；
 * - 空 choices：模型被安全策略拦了，返回结构合法但内容为空；
 * - 连接重置：公司网络/代理中途掐断；
 * - 挂死：上游不返回也不断开，只有客户端超时能救。
 */

const CHANNEL = 'devhost/myproj/llm-faults';
const CARD_TITLE = '登录 500 排查';

let harness: TestHarness | null = null;
const fakes: FakeLlm[] = [];

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  harness?.close();
  harness = null;
});

async function newFake(content?: string): Promise<FakeLlm> {
  const fake = await startFakeLlm(content);
  fakes.push(fake);
  return fake;
}

function configure(h: TestHarness, fake: FakeLlm): void {
  h.ctx.services.settings.update(
    {
      llm_endpoint: fake.base,
      llm_model: 'deepseek-flash',
      llm_mode: 'max',
      llm_api_key: 'sk-page-key',
    },
    testCtx(),
  );
}

/** 取出抛出的 AppError；没抛就直接失败，避免用例在「居然成功了」时静默通过。 */
async function capture(run: Promise<unknown>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('期望这次调用失败，但它成功了');
}

/** 建一条承载卡片的任务 + 一张 info 卡，返回卡片 id。 */
function seedCard(h: TestHarness): string {
  const taskId = h.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: CHANNEL, title: '承载卡片' }),
    testCtx(),
  ).task.id;
  return h.ctx.services.cards.post(
    cardPostSchema.parse({
      channel_key: CHANNEL,
      type: 'info',
      title: CARD_TITLE,
      background_md: '网关白名单未放行，登录接口持续 500',
      body_md: '10:20 起登录接口 500',
      severity: 'info',
      task_id: taskId,
    }) as CardPostInput,
    testCtx(),
  ).card.id;
}

/**
 * 让增强真的跑一次。
 *
 * 顺序有讲究：先建卡（此时还没配 key，后台调度只会标 unavailable，不发请求），
 * 再配 key，再把状态掰回 pending，最后手动 runOne——这样「只跑一次请求」是确定的。
 */
async function runEnrichment(h: TestHarness, fake: FakeLlm) {
  const cardId = seedCard(h);
  configure(h, fake);
  h.ctx.repos.cards.setEnrichment(cardId, 'pending', null);
  await h.ctx.services.enrichment.runOne(cardId);
  return h.ctx.repos.cards.get(cardId)!;
}

describe('LLM 失败路径：错误码收敛', () => {
  it('429 只暴露状态码，不把上游响应体带进错误', async () => {
    const fake = await newFake();
    fake.setStatus(429);
    const h = createHarness();
    harness = h;
    configure(h, fake);

    const error = await capture(h.ctx.services.llm.chat({ system: 's', user: 'u' }));
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('LLM_HTTP_ERROR');
    expect(error.details).toEqual({ status: 429 });
    // 假网关的 429 响应体里故意回显了 Bearer 密钥；它一个字都不许进错误详情。
    expect(JSON.stringify(error.toBody())).not.toContain('sk-leak-canary');
  });

  it('200 但响应体不是 JSON：报 LLM_INVALID_RESPONSE', async () => {
    const fake = await newFake();
    fake.setFault({ kind: 'invalid-json' });
    const h = createHarness();
    harness = h;
    configure(h, fake);

    const error = await capture(h.ctx.services.llm.chat({ system: 's', user: 'u' }));
    expect(error.message).toBe('LLM_INVALID_RESPONSE');
  });

  it('choices 为空：报 LLM_EMPTY_RESPONSE，而不是返回空字符串', async () => {
    const fake = await newFake();
    fake.setFault({ kind: 'empty' });
    const h = createHarness();
    harness = h;
    configure(h, fake);

    const error = await capture(h.ctx.services.llm.chat({ system: 's', user: 'u' }));
    expect(error.message).toBe('LLM_EMPTY_RESPONSE');
    expect(error.details).toMatchObject({ finish_reason: 'unknown' });
  });

  it('空响应可按调用方要求重试一次；未要求时仍立即失败', async () => {
    const fake = await newFake('重试后的回答');
    fake.failNext({ kind: 'empty' });
    const h = createHarness();
    harness = h;
    configure(h, fake);

    await expect(
      h.ctx.services.llm.chat({ system: 's', user: 'u', retryOnEmpty: 1 }),
    ).resolves.toBe('重试后的回答');
    // 第一次空响应 + 第二次成功：必须真的重发了请求，而不是本地伪造结果。
    expect(fake.requests).toHaveLength(2);

    fake.failNext({ kind: 'empty' });
    const error = await capture(h.ctx.services.llm.chat({ system: 's', user: 'u' }));
    expect(error.message).toBe('LLM_EMPTY_RESPONSE');
  });

  it('连接被重置：报 LLM_UNREACHABLE，并带上网络层错误名', async () => {
    const fake = await newFake();
    fake.setFault({ kind: 'reset' });
    const h = createHarness();
    harness = h;
    configure(h, fake);

    const error = await capture(h.ctx.services.llm.chat({ system: 's', user: 'u' }));
    expect(error.message).toBe('LLM_UNREACHABLE');
    expect(typeof error.details?.reason).toBe('string');
    expect(String(error.details?.reason).length).toBeGreaterThan(0);
  });

  it('上游挂死：超时后报 LLM_TIMEOUT，并记录等了多久', async () => {
    const fake = await newFake();
    fake.setFault({ kind: 'hang' });
    const h = createHarness();
    harness = h;
    configure(h, fake);

    const startedAt = Date.now();
    const error = await capture(
      h.ctx.services.llm.chat({ system: 's', user: 'u', timeoutMs: 150 }),
    );
    const elapsed = Date.now() - startedAt;
    expect(error.message).toBe('LLM_TIMEOUT');
    // 真的等到了超时线，不是提前失败；同时留出宽松上限，避免慢机器假红。
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(5000);
    expect(error.details?.elapsed_ms).toBeGreaterThanOrEqual(100);
  });

  it('用户主动取消优先于超时：报 LLM_CANCELLED，不误报成超时', async () => {
    const fake = await newFake();
    fake.setFault({ kind: 'hang' });
    const h = createHarness();
    harness = h;
    configure(h, fake);

    const controller = new AbortController();
    // 超时给足 10 秒，确保最终触发的一定是「取消」而不是「超时」。
    const pending = h.ctx.services.llm.chat({
      system: 's',
      user: 'u',
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    const error = await capture(pending);
    expect(error.message).toBe('LLM_CANCELLED');
  });

  it('failNext 只让一次请求失败，下一次自动恢复', async () => {
    const fake = await newFake('可用');
    fake.failNext({ kind: 'status', status: 503 });
    const h = createHarness();
    harness = h;
    configure(h, fake);

    const first = await capture(h.ctx.services.llm.chat({ system: 's', user: 'u' }));
    expect(first.message).toBe('LLM_HTTP_ERROR');
    // 恢复后拿到正常内容，证明故障是「偶发」而不是「永久」——重试链路才有意义。
    await expect(h.ctx.services.llm.chat({ system: 's', user: 'u' })).resolves.toBe('可用');
  });
});

describe('增强链路离线可测：失败不污染卡片', () => {
  it('模型输出不是 JSON：卡片落 unavailable，原因可读，卡片本体完好', async () => {
    const fake = await newFake('抱歉，我无法回答这个问题。');
    const h = createHarness({ enrichmentEnabled: true });
    harness = h;

    const card = await runEnrichment(h, fake);

    expect(card.enrichment_status).toBe('unavailable');
    expect(JSON.parse(card.enrichment_json ?? '{}')).toEqual({
      status: 'unavailable',
      reason: 'LLM_OUTPUT_NOT_JSON',
    });
    // 增强失败绝不能连带破坏卡片本身。
    expect(card.title).toBe(CARD_TITLE);
    // info 卡的正文落在 body_md；background_md 只属于 question 卡，这里本就是 null。
    expect(card.body_md).toContain('登录接口 500');
    expect(fake.requests.length).toBeGreaterThanOrEqual(1);
  });

  it('网关 429：卡片落 unavailable，上游响应体里的密钥不进卡片', async () => {
    const fake = await newFake();
    fake.setStatus(429);
    const h = createHarness({ enrichmentEnabled: true });
    harness = h;

    const card = await runEnrichment(h, fake);

    expect(card.enrichment_status).toBe('unavailable');
    expect(JSON.parse(card.enrichment_json ?? '{}')).toEqual({
      status: 'unavailable',
      reason: 'LLM_HTTP_ERROR',
    });
    // 关键断言：上游把 Bearer 密钥回显在错误页里，卡片里一个字都不能有。
    expect(card.enrichment_json ?? '').not.toContain('sk-leak-canary');
  });

  it('增强关闭时不发请求，直接标 skipped', async () => {
    const fake = await newFake();
    // harness 默认 enrichmentEnabled: false；这里显式写出来，避免默认值变化让用例失去意义。
    const h = createHarness({ enrichmentEnabled: false });
    harness = h;

    const card = await runEnrichment(h, fake);

    expect(card.enrichment_status).toBe('skipped');
    expect(JSON.parse(card.enrichment_json ?? '{}')).toMatchObject({
      reason: 'enrichment_disabled',
    });
    expect(fake.requests).toHaveLength(0);
  });
});
