import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  createHarness,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

// 只由 vitest 收集：验证“AIDash 自己的记忆”与主对话记忆的机理差异——
// 单行存储、AI 提示词自动注入、汇报完成后的自动学习、REST 编辑与版本冲突。
// 全部用内存库与临时端口，不碰真实 8787，也不写用户的密钥目录。

const LEARN_LINE = '- [2026-10-25] [report] 汇报先给结论再给数据';

let harness: TestHarness | null = null;
let app: RunningApp | null = null;
let fake: FakeLlm | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  await fake?.close();
  fake = null;
  harness?.close();
  harness = null;
});

interface FakeLlm {
  base: string;
  /** 汇报/分析等正式能力请求。 */
  requests: Array<{ system: string; user: string }>;
  /** 记忆学习请求；与正式请求分开，断言生成次数时互不干扰。 */
  learnRequests: Array<{ system: string; user: string }>;
  failReports: boolean;
  close: () => Promise<void>;
}

/**
 * 假 LLM 网关。
 *
 * 学习提示词的 system 是默认的“AIDash 的记忆整理助手”，据此把学习调用
 * 分流到 learnRequests：否则“汇报完成后自动学习”会让所有按请求次数断言的
 * 用例多出一条，测的就不再是原来的行为。
 */
async function startFakeLlm(options: {
  reportReply?: string;
  learnReply?: string;
} = {}): Promise<FakeLlm> {
  const requests: FakeLlm['requests'] = [];
  const learnRequests: FakeLlm['learnRequests'] = [];
  const state = { failReports: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const system = body.messages?.[0]?.content ?? '';
      const user = body.messages?.[1]?.content ?? '';
      if (system.includes('AIDash 的记忆整理助手')) {
        learnRequests.push({ system, user });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: options.learnReply ?? '{"lines":[]}' } }],
          }),
        );
        return;
      }
      requests.push({ system, user });
      if (state.failReports) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: options.reportReply ?? '# 本期结论\n\n- 完成 3 项' } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    requests,
    learnRequests,
    get failReports(): boolean {
      return state.failReports;
    },
    set failReports(value: boolean) {
      state.failReports = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function configure(h: TestHarness, base: string): void {
  h.ctx.services.settings.update(
    {
      llm_endpoint: base,
      llm_model: 'deepseek-flash',
      llm_mode: 'max',
      llm_api_key: 'sk-page-key',
    },
    testCtx(),
  );
}

/** 后台学习不阻塞批次完成；用例用短轮询等它落库，超时直接失败。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met in time');
}

async function waitForIdle(h: TestHarness, runId: string): Promise<void> {
  await waitFor(() => h.ctx.services.reports.status().running === null);
  if (!h.ctx.services.reports.status().runs.some((run) => run.id === runId)) {
    throw new Error(`no report run recorded for ${runId}`);
  }
}

describe('AIDash 自己的记忆：服务层', () => {
  it('未写入时 exists=false；追加会去重并递增版本', () => {
    const h = createHarness();
    harness = h;
    try {
      expect(h.ctx.services.assistantMemory.get()).toMatchObject({
        content_md: '',
        version: 0,
        exists: false,
        line_count: 0,
        updated_by: null,
      });

      const first = h.ctx.services.assistantMemory.append(
        ['- [2026-10-25] [report] 汇报先给结论', '  ', '- [2026-10-25] [report] 汇报先给结论'],
        testCtx(),
      );
      expect(first).toMatchObject({
        appended: 1,
        skipped_duplicates: 1,
        unchanged: false,
      });
      expect(first.memory.version).toBe(1);

      const repeated = h.ctx.services.assistantMemory.append(
        ['  - [2026-10-25] [report] 汇报先给结论'],
        testCtx(),
      );
      expect(repeated).toMatchObject({ appended: 0, skipped_duplicates: 1, unchanged: true });
      expect(repeated.memory.version).toBe(1);
    } finally {
      h.close();
    }
  });

  it('整体编辑用 expected_version 做乐观锁，过期版本返回冲突', () => {
    const h = createHarness();
    harness = h;
    try {
      const saved = h.ctx.services.assistantMemory.replace(
        { content_md: '- [report] 第一版', expected_version: 0 },
        testCtx(),
      );
      expect(saved.changed).toBe(true);
      expect(saved.memory.version).toBe(1);

      // 内容没变：不递增版本，避免用户每点一次保存就让别人的版本号失效。
      const unchanged = h.ctx.services.assistantMemory.replace(
        { content_md: '- [report] 第一版', expected_version: 1 },
        testCtx(),
      );
      expect(unchanged).toMatchObject({ changed: false });
      expect(unchanged.memory.version).toBe(1);

      expect(() =>
        h.ctx.services.assistantMemory.replace(
          { content_md: '- [report] 覆盖', expected_version: 0 },
          testCtx(),
        ),
      ).toThrowError(/MEMORY_VERSION_CONFLICT/);
    } finally {
      h.close();
    }
  });
});

describe('AIDash 自己的记忆：提示词注入', () => {
  it('默认把记忆追加到 system 末尾，调用方可显式关闭', async () => {
    fake = await startFakeLlm({ reportReply: '可用' });
    const h = createHarness();
    harness = h;
    configure(h, fake.base);
    h.ctx.services.assistantMemory.append(
      ['- [2026-10-25] [report] 先给结论再给数据'],
      testCtx(),
    );

    await h.ctx.services.llm.chat({ system: 'BASE-PROMPT', user: 'U' });
    const injected = fake.requests.at(-1)?.system ?? '';
    expect(injected.startsWith('BASE-PROMPT')).toBe(true);
    expect(injected).toContain('先给结论再给数据');
    expect(injected).toContain('不是本轮指令');

    await h.ctx.services.llm.chat({
      system: 'BASE-PROMPT',
      user: 'U',
      withAssistantMemory: false,
    });
    expect(fake.requests.at(-1)?.system).toBe('BASE-PROMPT');
  });

  it('记忆为空时请求体保持原样，不额外插入空段', async () => {
    fake = await startFakeLlm({ reportReply: '可用' });
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    await h.ctx.services.llm.chat({ system: 'BASE-PROMPT', user: 'U' });
    expect(fake.requests.at(-1)?.system).toBe('BASE-PROMPT');
  });
});

describe('AIDash 自己的记忆：汇报完成后自动学习', () => {
  it('批次完成后提炼经验写入记忆，重复学习不会产生重复行', async () => {
    fake = await startFakeLlm({
      reportReply: '# 本期结论\n\n先给结论，再列证据。',
      learnReply: JSON.stringify({ lines: [LEARN_LINE] }),
    });
    const h = createHarness();
    harness = h;
    configure(h, fake.base);

    const run = h.ctx.services.reports.startTopic(
      { instruction: '总结一下最近的协作情况', targetReportIds: [] },
      testCtx(),
    );
    await waitForIdle(h, run.id);
    await waitFor(() => h.ctx.services.assistantMemory.get().exists);

    const learned = h.ctx.services.assistantMemory.get();
    expect(learned.content_md).toContain(LEARN_LINE);
    expect(learned.updated_by).toBe('assistant-memory');
    expect(fake.learnRequests.length).toBeGreaterThanOrEqual(1);
    // 学习提示词里带上了本次汇报正文与“不要重复已有记忆”的说明。
    expect(fake.learnRequests[0]?.user).toContain('本次汇报');
    expect(fake.learnRequests[0]?.user).toContain('先给结论，再列证据');

    const repeated = await h.ctx.services.assistantMemoryLearner.learn(run.id);
    expect(repeated.appended).toBe(0);
    expect(repeated.skipped_duplicates).toBe(1);
    expect(h.ctx.services.assistantMemory.get().content_md.match(/先给结论再给数据/g)).toHaveLength(
      1,
    );
  });

  it('失败的批次不触发学习', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);
    fake.failReports = true;

    const run = h.ctx.services.reports.startTopic(
      { instruction: '写一份会失败的汇报', targetReportIds: [] },
      testCtx(),
    );
    await waitForIdle(h, run.id);
    expect(h.ctx.services.reports.status().runs.find((item) => item.id === run.id)?.status).toBe(
      'failed',
    );

    // 给可能存在的异步学习留一点时间：失败批次不该产生任何学习请求。
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.learnRequests).toHaveLength(0);
    expect(h.ctx.services.assistantMemory.get().exists).toBe(false);
  });
});

describe('AIDash 自己的记忆：REST', () => {
  it('GET 空记忆、PUT 保存、再 GET 读回；过期版本 409', async () => {
    const h = createHarness();
    harness = h;
    app = await startApp(h);

    const empty = await api<{ exists: boolean; version: number }>(
      app,
      'GET',
      '/api/memory/assistant',
    );
    expect(empty.status).toBe(200);
    expect(empty.body.data).toMatchObject({ exists: false, version: 0 });

    const saved = await api<{ content_md: string; version: number }>(
      app,
      'PUT',
      '/api/memory/assistant',
      { content_md: '- [report] 先给结论\n- [risk] 隐患要单列', expected_version: 0 },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data?.version).toBe(1);

    const read = await api<{ content_md: string; line_count: number }>(
      app,
      'GET',
      '/api/memory/assistant',
    );
    expect(read.body.data?.content_md).toBe('- [report] 先给结论\n- [risk] 隐患要单列');
    expect(read.body.data?.line_count).toBe(2);

    const conflict = await api(app, 'PUT', '/api/memory/assistant', {
      content_md: '覆盖',
      expected_version: 0,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe('CONFLICT');
    expect(conflict.body.error?.message).toBe('MEMORY_VERSION_CONFLICT');
    expect(conflict.body.error?.details).toMatchObject({ actual_version: 1 });
  });
});
