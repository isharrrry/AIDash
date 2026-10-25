import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cardPostSchema, taskCreateSchema } from '../src/shared/schemas.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import { chatUrl } from '../src/server/services/llm-service.js';
import { sanitizeDigestLines } from '../src/server/services/memory-digest-service.js';
import { startFakeLlm, type FakeLlm } from './fakes/fake-llm.js';
import {
  api,
  createHarness,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

const CHANNEL = 'devhost/myproj/auth-bug';

let harness: TestHarness | null = null;
let app: RunningApp | null = null;
const cleanupDirs: string[] = [];
/**
 * 本文件启动过的假 LLM 服务。
 *
 * 为什么不能只在用例末尾 `await fake.close()`：断言失败会直接抛出，
 * 后面的 close 永远执行不到，回环端口与 keep-alive 连接就留给了整个进程。
 * 以前这种泄漏只在「测试恰好失败」时出现，最难排查——失败的那条看起来
 * 只是断言错，实际还附带一个没关的服务。统一登记后由 afterEach 兜底，
 * 用例内仍可显式 close（重复 close 是安全的），失败时也不会漏。
 */
const activeFakes: FakeLlm[] = [];

/** 登记并返回假 LLM；所有用例都应走这个包装，而不是直接 startFakeLlm。 */
async function trackedFakeLlm(
  ...args: Parameters<typeof startFakeLlm>
): ReturnType<typeof startFakeLlm> {
  const fake = await startFakeLlm(...args);
  activeFakes.push(fake);
  return fake;
}

afterEach(async () => {
  await app?.close();
  app = null;
  harness?.close();
  harness = null;
  // 先关假 LLM 再删临时目录：失败的用例可能还有挂起连接指向目录里的东西。
  for (const fake of activeFakes.splice(0)) await fake.close();
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function post(h: TestHarness, input: Record<string, unknown>) {
  return h.ctx.services.cards.post(cardPostSchema.parse(input) as CardPostInput, testCtx());
}

function seedTask(h: TestHarness, title = '承载卡片的测试任务'): string {
  return h.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: CHANNEL, title }),
    testCtx(),
  ).task.id;
}

function configure(h: TestHarness, base: string, mode: 'fast' | 'standard' | 'max' = 'max'): void {
  h.ctx.services.settings.update(
    {
      llm_endpoint: base,
      llm_model: 'deepseek-flash',
      llm_mode: mode,
      llm_api_key: 'sk-page-key',
    },
    testCtx(),
  );
}

function expectErrorMessage(fn: () => unknown, code: string, message: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected ${code}/${message}`);
}

describe('LLM 配置', () => {
  it('默认指向 deepseek-flash 的 max 模式，并自带五类提示词', () => {
    const h = createHarness();
    harness = h;
    const view = h.ctx.services.settings.view();
    expect(view.enrichment.llm).toMatchObject({
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-flash',
      mode: 'max',
      has_api_key: false,
      configured: false,
      key_source: null,
    });
    expect(view.prompts.map((item) => item.key)).toEqual([
      'card_analysis',
      'kb_suggestion',
      'memory_digest',
      'report',
      'assistant_memory',
    ]);
    for (const prompt of view.prompts) {
      expect(prompt.system.trim().length).toBeGreaterThan(0);
      expect(prompt.system).toBe(prompt.default_system);
    }
    // 知识库没配、模型也没配时不能宣称“建议已就绪”。
    expect(view.enrichment.kb_suggestion_ready).toBe(false);
  });

  it('base 地址补全 /chat/completions，已是完整地址则原样使用', () => {
    expect(chatUrl('https://api.deepseek.com/v1')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(chatUrl('https://api.deepseek.com/v1/chat/completions')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(chatUrl('https://api.deepseek.com/v1///')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
  });

  it('测试连接走真实 HTTP，档位决定 max_tokens 与温度', async () => {
    const fake = await trackedFakeLlm('可用');
    const h = createHarness();
    harness = h;
    configure(h, fake.base, 'max');
    app = await startApp(h);

    const result = await api<{ ok: boolean; model: string; mode: string; reply: string }>(
      app,
      'POST',
      '/api/llm/test',
    );
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      ok: true,
      model: 'deepseek-flash',
      mode: 'max',
      reply: '可用',
    });
    expect(fake.requests[0]?.url).toBe('/v1/chat/completions');
    expect(fake.requests[0]?.auth).toBe('Bearer sk-page-key');
    // 测试连接只花 32 token，不碰用户配置的档位预算。
    expect(fake.requests[0]?.body.max_tokens).toBe(32);

    for (const [mode, maxTokens, temperature] of [
      ['fast', 2048, 0.1],
      ['standard', 4096, 0.2],
      ['max', 8192, 0.2],
    ] as const) {
      configure(h, fake.base, mode);
      await h.ctx.services.llm.chat({ system: 's', user: 'u' });
      const body = fake.requests.at(-1)?.body;
      expect(body?.max_tokens).toBe(maxTokens);
      expect(body?.temperature).toBe(temperature);
      expect(body?.model).toBe('deepseek-flash');
    }
    await fake.close();
  });

  it('提示词可覆盖、可恢复默认，空提示词被拒绝', () => {
    const h = createHarness();
    harness = h;
    const defaults = h.ctx.services.settings.view().prompts;
    const defaultReport = defaults.find((item) => item.key === 'report')!.default_system;

    h.ctx.services.settings.update({ prompts: { report: '只写结论' } }, testCtx());
    expect(h.ctx.services.llm.prompt('report')).toBe('只写结论');
    // 没改的能力保持默认，避免“改一个把其他清空”。
    expect(h.ctx.services.llm.prompt('card_analysis')).toBe(
      defaults.find((item) => item.key === 'card_analysis')!.default_system,
    );

    h.ctx.services.settings.update({ prompts: { report: defaultReport } }, testCtx());
    expect(h.ctx.services.llm.prompt('report')).toBe(defaultReport);

    expectErrorMessage(
      () => h.ctx.services.settings.update({ prompts: { report: '  ' } }, testCtx()),
      'INVALID_ARGUMENT',
      'PROMPT_EMPTY',
    );
  });

  it('没配 key 时测试连接明确报 LLM_NOT_CONFIGURED', async () => {
    const h = createHarness();
    harness = h;
    app = await startApp(h);
    const result = await api(app, 'POST', '/api/llm/test');
    expect(result.status).toBe(400);
    expect(result.body.error?.message).toBe('LLM_NOT_CONFIGURED');
  });

  it('能力开关由 key 与知识库共同决定', async () => {
    const fake = await trackedFakeLlm();
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-kb-ready-'));
    cleanupDirs.push(kbDir);
    fs.writeFileSync(
      path.join(kbDir, 'login.md'),
      '# 登录排查\n\n网关白名单未放行会导致登录 500。\n',
    );
    // 就绪状态还要求增强开关打开：harness 默认关掉增强以免后台任务干扰，
    // 这里显式打开，才是在验证“开关 + KB + key”三者同时满足。
    const h = createHarness({ kbRoot: kbDir, enrichmentEnabled: true });
    harness = h;

    expect(h.ctx.services.settings.view().enrichment.kb_suggestion_ready).toBe(false);
    configure(h, fake.base);
    expect(h.ctx.services.settings.view().enrichment.kb_suggestion_ready).toBe(true);
    await fake.close();
  });
});

describe('知识库建议与自动增强', () => {
  it('多词查询走 FTS 而不是静默退化成 LIKE', () => {
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-kb-fts-'));
    cleanupDirs.push(kbDir);
    fs.writeFileSync(
      path.join(kbDir, 'login.md'),
      '# 登录排查\n\n网关白名单未放行会导致登录 500。\n',
    );
    const h = createHarness({ kbRoot: kbDir });
    harness = h;
    h.ctx.services.kb.index();

    // 回归点：`WHERE f MATCH ?` 曾因别名报错被 catch 吞掉，退化成整串 LIKE，
    // 导致“登录 500”这类正常多词查询 0 命中。
    const hits = h.ctx.services.kb.search('登录 500').items;
    expect(hits[0]?.path).toBe('login.md');
    // snippet 不应把索引期的逐字空格原样漏给用户/模型。
    expect(hits[0]?.snippet).toContain('网关白名单');
  });

  it('命中知识库用 kb_suggestion，未命中退回 card_analysis', async () => {
    const fake = await trackedFakeLlm(
      '{"analysis_md":"先确认白名单","suggestions":[{"text":"查网关白名单","rationale":"与日志一致","confidence":0.8}],"confidence":0.7}',
    );
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-kb-enrich-'));
    cleanupDirs.push(kbDir);
    fs.writeFileSync(
      path.join(kbDir, 'login.md'),
      '# 登录排查\n\n网关白名单未放行会导致登录 500。\n',
    );

    const h = createHarness({ kbRoot: kbDir, enrichmentEnabled: true });
    harness = h;
    // 先把提示词换成标记串，才能从请求体里确认“用了哪一套能力”。
    h.ctx.services.settings.update(
      { prompts: { kb_suggestion: 'KB-MARKER', card_analysis: 'CARD-MARKER' } },
      testCtx(),
    );
    h.ctx.services.kb.index();
    const taskId = seedTask(h);

    // 先把两张卡建出来：此时还没配 key，自动增强只会标 unavailable，
    // 不会真的发请求，后面的手动 runOne 才是唯一一次调用。
    const hit = post(h, {
      channel_key: CHANNEL,
      type: 'info',
      title: '登录 500 排查',
      background_md: '网关白名单未放行，登录接口持续 500',
      body_md: '10:20 起登录接口 500',
      severity: 'info',
      task_id: taskId,
    }).card;
    const miss = post(h, {
      channel_key: CHANNEL,
      type: 'info',
      title: '季度团建预算',
      body_md: '下周三下午定场地',
      severity: 'info',
      task_id: taskId,
    }).card;

    configure(h, fake.base);
    h.ctx.repos.cards.setEnrichment(hit.id, 'pending', null);
    h.ctx.repos.cards.setEnrichment(miss.id, 'pending', null);

    await h.ctx.services.enrichment.runOne(hit.id);
    expect(fake.requests[0]?.body.messages?.[0]?.content).toBe('KB-MARKER');
    expect(fake.requests[0]?.body.messages?.[1]?.content).toContain('网关白名单');

    await h.ctx.services.enrichment.runOne(miss.id);
    expect(fake.requests[1]?.body.messages?.[0]?.content).toBe('CARD-MARKER');

    const hitCard = h.ctx.repos.cards.get(hit.id)!;
    const hitView = JSON.parse(hitCard.enrichment_json ?? '{}') as {
      status: string;
      has_kb_basis: boolean;
      suggestions: Array<{ text: string }>;
    };
    expect(hitView.status).toBe('done');
    expect(hitView.has_kb_basis).toBe(true);
    expect(hitView.suggestions[0]?.text).toBe('查网关白名单');

    const missView = JSON.parse(h.ctx.repos.cards.get(miss.id)!.enrichment_json ?? '{}') as {
      has_kb_basis: boolean;
    };
    expect(missView.has_kb_basis).toBe(false);
    await fake.close();
  });
});

describe('自动记忆归纳', () => {
  function seedSources(h: TestHarness): void {
    const taskId = h.ctx.services.tasks.create(
      taskCreateSchema.parse({
        channel_key: CHANNEL,
        title: '发布前先备份数据库',
        description_md: '上次迁移忘了备份，回滚花了半小时',
      }),
      testCtx(),
    ).task.id;
    h.ctx.services.tasks.create(
      taskCreateSchema.parse({
        channel_key: CHANNEL,
        title: '网关白名单未放行',
        description_md: '登录接口 500 的根因',
      }),
      testCtx(),
    );
    post(h, {
      channel_key: CHANNEL,
      type: 'status',
      summary: '已恢复登录，根因是白名单',
      result: 'success',
      task_id: taskId,
      detail_md: '10:20 起 500 集中在 192.0.2.15 出口',
    });
  }

  it('手动归纳写入记忆并记录运行历史，第二次去重', async () => {
    const line = '- [2026-10-24] [deploy] 发布前先备份数据库，再跑迁移';
    const fake = await trackedFakeLlm(JSON.stringify({ lines: [line] }));
    const h = createHarness();
    harness = h;
    configure(h, fake.base);
    seedSources(h);

    const first = await h.ctx.services.memoryDigest.run('myproj', 'manual');
    expect(first.result).toBe('ok');
    expect(first.appended).toBe(1);
    expect(first.source_count).toBeGreaterThanOrEqual(3);
    expect(h.ctx.services.memory.get('myproj').content_md).toContain(line);

    const second = await h.ctx.services.memoryDigest.run('myproj', 'manual');
    expect(second.result).toBe('empty');
    expect(second.appended).toBe(0);
    expect(second.skipped_duplicates).toBe(1);
    // 第二次的提示词里要带已有记忆，模型才知道“不要重复”。
    expect(fake.requests[1]?.body.messages?.[1]?.content).toContain(line);

    const runs = h.ctx.services.memoryDigest.listRuns('myproj');
    expect(runs).toHaveLength(2);
    expect(runs[0]?.trigger).toBe('manual');
    expect(runs[0]?.lines).toEqual([line]);
    await fake.close();
  });

  it('素材不足与模型未配置都留下可追溯的运行记录', async () => {
    const fake = await trackedFakeLlm('{"lines":["- [x] [y] 不该被写到记忆"]}');
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const empty = await h.ctx.services.memoryDigest.run('myproj', 'manual');
    expect(empty.result).toBe('empty');
    expect(empty.source_count).toBe(0);
    expect(fake.requests).toHaveLength(0);
    await fake.close();

    const h2 = createHarness();
    try {
      const unavailable = await h2.ctx.services.memoryDigest.run('other', 'manual');
      expect(unavailable.result).toBe('unavailable');
      expect(unavailable.error_message).toBe('llm_not_configured');
      expect(h2.ctx.services.memoryDigest.listRuns('other')[0]?.result).toBe('unavailable');
    } finally {
      h2.close();
    }
  });

  it('模型输出被收敛：只保留合规格式、最多 5 行', () => {
    const content = JSON.stringify({
      lines: [
        '发布前先备份数据库，再跑迁移',
        '[2026-10-24] [auth] 网关白名单未放行会 500',
        '[2026-10-24] [deploy] A',
        '[2026-10-24] [deploy] B',
        '[2026-10-24] [deploy] C',
        '[2026-10-24] [deploy] D',
        '[2026-10-24] [deploy] E',
      ],
    });
    const lines = sanitizeDigestLines(content);
    expect(lines).toHaveLength(5);
    // 没有第二组 [key] 的行被丢弃，而不是强行编一个 key。
    expect(lines.every((line) => /^-\s*\[[^\]]+\]\s*\[[^\]]+\]\s+.+$/.test(line))).toBe(true);
    expect(lines[0]).toBe('- [2026-10-24] [auth] 网关白名单未放行会 500');
    expect(sanitizeDigestLines('不是 JSON')).toEqual([]);
  });
});
