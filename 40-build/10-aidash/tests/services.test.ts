import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { cardAskSchema, cardPostSchema, taskCreateSchema } from '../src/shared/schemas.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import type { CardAskInput } from '../src/server/services/decision-service.js';
import { WaitRegistry } from '../src/server/services/decision-service.js';
import { sanitizeOutput } from '../src/server/services/enrichment-service.js';
import { KbService } from '../src/server/services/kb-service.js';
import { KbRepo } from '../src/server/repos/support-repos.js';
import {
  createHarness,
  questionOptions,
  questionPayload,
  testCtx,
  type TestHarness,
} from './helpers.js';

const CHANNEL = 'devhost/myproj/auth-bug';

function post(h: TestHarness, input: Record<string, unknown>) {
  return h.ctx.services.cards.post(cardPostSchema.parse(input) as CardPostInput, testCtx());
}

/**
 * 给非 question 卡准备一个承载任务。
 *
 * 本版起 info/handoff/suggestion/status/artifact 必须挂任务（信息流归到任务下），
 * 测试里先建一条草稿任务再发卡；任务是否提交不影响发卡校验，只要求同通道且存在。
 */
function seedTask(h: TestHarness, title = '承载卡片的测试任务'): string {
  return h.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: CHANNEL, title }),
    testCtx(),
  ).task.id;
}

function expectAppError(fn: () => unknown, code: string): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }
  throw new Error(`expected AppError(${code})`);
}

let harness: TestHarness | null = null;
afterEach(() => {
  harness?.close();
  harness = null;
});

describe('卡片服务', () => {
  it('发 info 卡会自动建通道，幂等键复用同一张卡', () => {
    const h = createHarness();
    harness = h;
    const input = {
      channel_key: CHANNEL,
      type: 'info',
      title: '部署完成',
      body_md: '版本已上线',
      severity: 'info',
      task_id: seedTask(h),
      idempotency_key: 'idem-1',
    };
    const first = post(h, input);
    expect(first.created).toBe(true);
    expect(first.card.channel_key).toBe(CHANNEL);

    const second = post(h, input);
    expect(second.created).toBe(false);
    expect(second.card.id).toBe(first.card.id);

    expect(h.ctx.services.channels.getByKey(CHANNEL)?.channel_key).toBe(CHANNEL);
    expect(h.ctx.services.cards.get(first.card.id).title).toBe('部署完成');
  });

  it('卡片正文命中令牌模式时整单拒绝，且错误里不回显原文', () => {
    const h = createHarness();
    harness = h;
    const error = expectAppError(
      () =>
        post(h, {
          channel_key: CHANNEL,
          type: 'info',
          title: '配置',
          body_md: 'api_key: abcdefghijklmnop123',
          severity: 'warn',
          task_id: seedTask(h),
        }),
      'INVALID_ARGUMENT',
    );
    expect(error.details?.pattern).toBe('generic_token');
    expect(JSON.stringify(error.details)).not.toContain('abcdefghijklmnop123');
  });

  it('回答文本命中令牌模式时拒绝，且不改变卡片状态', () => {
    const h = createHarness();
    harness = h;
    const { card } = post(
      h,
      questionPayload({
        channel_key: CHANNEL,
        type: 'question',
        allow_free_text: true,
      }),
    );

    const error = expectAppError(
      () =>
        h.ctx.services.cards.answer(
          card.id,
          { free_text: 'api_key: abcdefghijklmnop123' },
          testCtx(),
        ),
      'INVALID_ARGUMENT',
    );
    expect(error.details?.pattern).toBe('generic_token');
    // 校验发生在写库前：不能出现“回答被拒绝但卡片已被标记为 answered”。
    expect(h.ctx.services.cards.get(card.id).status).toBe('open');
  });

  it('question 卡：选项校验、自由文本开关、并发回答只成功一次', () => {
    const h = createHarness();
    harness = h;
    const { card } = post(
      h,
      questionPayload({
        channel_key: CHANNEL,
        type: 'question',
        title: '先回滚还是先修？',
        options: questionOptions(['rollback', 'fix']),
        priority: 'P0',
      }),
    );

    expectAppError(
      () => h.ctx.services.cards.answer(card.id, { option_id: 'nope' }, testCtx()),
      'INVALID_ARGUMENT',
    );
    expectAppError(
      () => h.ctx.services.cards.answer(card.id, { free_text: '随便' }, testCtx()),
      'INVALID_ARGUMENT',
    );

    const answered = h.ctx.services.cards.answer(
      card.id,
      { option_id: 'rollback', note: '先恢复' },
      testCtx(),
    );
    expect(answered.status).toBe('answered');
    expect(answered.answer?.option_id).toBe('rollback');

    expectAppError(
      () => h.ctx.services.cards.answer(card.id, { option_id: 'fix' }, testCtx()),
      'CONFLICT',
    );
  });

  it('交接卡状态可推进；非交接卡拒绝该操作', () => {
    const h = createHarness();
    harness = h;
    const handoff = post(h, {
      channel_key: CHANNEL,
      type: 'handoff',
      recipient: '运维同学',
      channel_kind: 'wechat',
      reason: '确认白名单',
      message_md: '运维同学您好，请确认 192.0.2.15 是否放行。',
      task_id: seedTask(h),
    }).card;
    expect(handoff.handoff_state).toBe('draft');
    expect(h.ctx.services.cards.setHandoffState(handoff.id, 'sent', testCtx()).handoff_state).toBe(
      'sent',
    );

    const info = post(h, {
      channel_key: CHANNEL,
      type: 'info',
      title: 't',
      body_md: 'b',
      severity: 'info',
      task_id: seedTask(h),
    }).card;
    expectAppError(
      () => h.ctx.services.cards.setHandoffState(info.id, 'sent', testCtx()),
      'INVALID_ARGUMENT',
    );
  });

  it('摘要按 P0/P1 与最近状态聚合', () => {
    const h = createHarness();
    harness = h;
    post(
      h,
      questionPayload({
        channel_key: CHANNEL,
        type: 'question',
        title: 'P0 决策',
        priority: 'P0',
      }),
    );
    post(h, {
      channel_key: CHANNEL,
      type: 'status',
      summary: '已定位',
      result: 'success',
      task_id: seedTask(h),
    });
    const digest = h.ctx.services.cards.digest(CHANNEL);
    expect(digest.pending_decisions).toBe(1);
    expect(digest.p0_cards).toHaveLength(1);
    expect(digest.recent_status[0]?.summary).toBe('已定位');
  });
});

describe('任务服务', () => {
  function registerHarness(h: TestHarness, id: string): void {
    h.ctx.repos.harnesses.upsert({
      harness_id: id,
      name: id,
      host: null,
      capabilities_json: null,
      now: h.clock.now(),
    });
  }

  it('完整生命周期：submit → claim → start → 证据 → complete', () => {
    const h = createHarness();
    harness = h;
    registerHarness(h, 'h1');
    const created = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '修白名单' }),
      testCtx(),
      { submit: true },
    );
    expect(created.task.status).toBe('pending');

    const claim = h.ctx.services.tasks.claim(
      { task_id: created.task.id, harness_id: 'h1' },
      testCtx(),
    );
    expect(claim.task.status).toBe('claimed');
    expect(claim.claim_token).toMatch(/^cl_/);

    h.ctx.services.tasks.update(
      { task_id: created.task.id, event: 'start', claim_token: claim.claim_token },
      testCtx(),
    );

    // 状态机只允许 in_progress 完成；先 start 才能验证“没证据不许完成”。
    expectAppError(
      () =>
        h.ctx.services.tasks.update(
          { task_id: created.task.id, event: 'complete', claim_token: claim.claim_token },
          testCtx(),
        ),
      'EVIDENCE_REQUIRED',
    );
    post(h, {
      channel_key: CHANNEL,
      type: 'status',
      summary: '白名单已放行',
      result: 'success',
      task_id: created.task.id,
    });

    const done = h.ctx.services.tasks.update(
      { task_id: created.task.id, event: 'complete', claim_token: claim.claim_token },
      testCtx(),
    );
    expect(done.status).toBe('done');
    expect(done.evidence_ids).toHaveLength(1);
    expect(h.ctx.repos.tasks.get(created.task.id)?.claim_token).toBeNull();
  });

  it('任务描述与状态原因同样做敏感模式扫描', () => {
    const h = createHarness();
    harness = h;

    const createError = expectAppError(
      () =>
        h.ctx.services.tasks.create(
          taskCreateSchema.parse({
            channel_key: CHANNEL,
            title: '配置任务',
            description_md: 'secret: abcdefghijklmnop123',
          }),
          testCtx(),
        ),
      'INVALID_ARGUMENT',
    );
    expect(createError.details?.pattern).toBe('generic_token');

    const { task } = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '正常任务' }),
      testCtx(),
      { submit: true },
    );
    expectAppError(
      () =>
        h.ctx.services.tasks.update(
          {
            task_id: task.id,
            event: 'block',
            reason: 'token: abcdefghijklmnop123',
          },
          testCtx(),
        ),
      'INVALID_ARGUMENT',
    );
    // 原因被拒绝时状态机不能先走一步：任务仍是 pending。
    expect(h.ctx.services.tasks.get(task.id).status).toBe('pending');
  });

  it('并发认领第二个 harness 得到 ALREADY_CLAIMED', () => {
    const h = createHarness();
    harness = h;
    registerHarness(h, 'h1');
    registerHarness(h, 'h2');
    const { task } = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: 't' }),
      testCtx(),
      { submit: true },
    );
    h.ctx.services.tasks.claim({ task_id: task.id, harness_id: 'h1' }, testCtx());
    expectAppError(
      () => h.ctx.services.tasks.claim({ task_id: task.id, harness_id: 'h2' }, testCtx()),
      'ALREADY_CLAIMED',
    );
  });

  it('block/fail 必须给原因；移动与复制保持树结构', () => {
    const h = createHarness();
    harness = h;
    registerHarness(h, 'h1');
    const root = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: 'root' }),
      testCtx(),
      { submit: true },
    ).task;
    const child = h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: 'child', parent_id: root.id }),
      testCtx(),
      { submit: true },
    ).task;

    const claim = h.ctx.services.tasks.claim(
      { task_id: root.id, harness_id: 'h1' },
      testCtx(),
    );
    h.ctx.services.tasks.update(
      { task_id: root.id, event: 'start', claim_token: claim.claim_token },
      testCtx(),
    );
    expectAppError(
      () =>
        h.ctx.services.tasks.update(
          { task_id: root.id, event: 'block', claim_token: claim.claim_token },
          testCtx(),
        ),
      'INVALID_ARGUMENT',
    );

    const moved = h.ctx.services.tasks.move(child.id, null, testCtx());
    expect(moved.parent_id).toBeNull();

    const copied = h.ctx.services.tasks.copy(child.id, root.id, testCtx());
    expect(copied.copied).toBe(1);
    expect(copied.task.status).toBe('draft');
    expect(h.ctx.services.tasks.tree(CHANNEL)).toHaveLength(2);
  });
});

describe('有界等待', () => {
  it('ask 在等待期内被回答后返回 answered', async () => {
    const h = createHarness();
    harness = h;
    const input = cardAskSchema.parse(
      questionPayload({
        channel_key: CHANNEL,
        options: questionOptions(['a', 'b']),
        wait_seconds: 5,
      }),
    ) as CardAskInput;
    const pending = h.ctx.services.decisions.ask(input, testCtx());

    // 等卡片落库后从 open question 列表拿到 id。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const open = h.ctx.services.cards.list({
      channelKey: CHANNEL,
      types: ['question'],
      statuses: ['open'],
    });
    const cardId = open.items[0]?.id;
    expect(cardId).toBeTruthy();
    h.ctx.services.cards.answer(cardId!, { option_id: 'a' }, testCtx());

    const result = await pending;
    expect(result.status).toBe('answered');
    expect(result.answer?.option_id).toBe('a');
  });

  it('wait_seconds=0 立即返回 pending，不替用户做决定', async () => {
    const h = createHarness();
    harness = h;
    const input = cardAskSchema.parse(
      questionPayload({ channel_key: CHANNEL, wait_seconds: 0 }),
    ) as CardAskInput;
    const result = await h.ctx.services.decisions.ask(input, testCtx());
    expect(result.status).toBe('pending');
    expect(result.poll_after_ms).toBeGreaterThan(0);
  });

  it('等待者数量达到上限时返回 BUSY', () => {
    const registry = new WaitRegistry(1);
    const first = registry.wait('cd_1', 10_000);
    expectAppError(() => registry.wait('cd_2', 10_000), 'BUSY');
    expect(registry.size()).toBe(1);
    registry.cancelAll();
    return first.then((answer) => expect(answer).toBeNull());
  });
});

describe('知识库', () => {
  it('索引中文文档、按字粒度检索、拒绝路径穿越', () => {
    const h = createHarness();
    harness = h;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-kb-'));
    fs.mkdirSync(path.join(root, 'wiki'));
    fs.writeFileSync(
      path.join(root, 'wiki', 'login.md'),
      '---\ntype: runbook\ntags: [auth]\n---\n# 登录排查\n\n登录接口失败时先查网关白名单。\n',
      'utf8',
    );
    const kb = new KbService(() => root, new KbRepo(h.db), h.clock);

    expect(kb.isConfigured()).toBe(true);
    const report = kb.index();
    expect(report.indexed).toBe(1);
    expect(kb.index().unchanged).toBe(1);

    const hits = kb.search('登录');
    expect(hits.items[0]?.path).toBe('wiki/login.md');
    expect(hits.items[0]?.title).toBe('登录排查');

    expect(kb.get('wiki/login.md').tags).toEqual(['auth']);
    expectAppError(() => kb.get('../outside.md'), 'INVALID_ARGUMENT');
    expect(kb.stats().docs).toBe(1);
    expect(kb.listDocs().items).toHaveLength(1);
  });

  it('中文数字混排按类别分词，FTS 特殊字符不会造成降级', () => {
    const h = createHarness();
    harness = h;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-kb-mixed-'));
    try {
      fs.writeFileSync(
        path.join(root, 'login.md'),
        [
          '---',
          'type: runbook',
          'tags: [auth]',
          '---',
          '# 登录排查',
          '',
          '登录500 表示登录接口返回 500。',
          'login 失败时先查网关白名单。',
          'C++ "quoted" * 只是特殊字符样例。',
        ].join('\n'),
        'utf8',
      );
      const kb = new KbService(() => root, new KbRepo(h.db), h.clock);
      expect(kb.index().indexed).toBe(1);

      // 旧实现把“登录500”整段逐字拆成短语 "登 录 5 0 0"，而索引 token 是 500，必然 0 命中。
      expect(kb.search('登录500').items.map((item) => item.path)).toContain('login.md');
      // 空白只是分隔符：带不带空格应命中同一篇文档。
      expect(kb.search('登录 500').items.map((item) => item.path)).toContain('login.md');
      // 纯中文、纯英文查询不回归；degraded=false 证明走的是 FTS 而不是 LIKE 兜底。
      const chinese = kb.search('登录');
      expect(chinese.items.map((item) => item.path)).toContain('login.md');
      expect(chinese.degraded).toBe(false);
      const english = kb.search('login');
      expect(english.items.map((item) => item.path)).toContain('login.md');
      expect(english.degraded).toBe(false);
      // 引号、加号、星号都是 FTS5 语法字符：分词时丢弃，不能抛语法错误降级到 LIKE。
      const special = kb.search('C++ "quoted" *');
      expect(special.degraded).toBe(false);
      expect(special.items.map((item) => item.path)).toContain('login.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('设置与增强', () => {
  it('页面写 llm_api_key 只落加密文件，视图只回是否已配置', () => {
    const h = createHarness();
    harness = h;
    const saved = h.ctx.services.settings.update(
      { llm_api_key: 'sk-should-not-be-stored' },
      testCtx(),
    );
    expect(saved.enrichment.llm).toMatchObject({
      has_api_key: true,
      configured: true,
      key_source: 'file',
    });

    const view = h.ctx.services.settings.view();
    // 06 SAFE-002：只回 configured，掩码的尾号也属于泄露。
    expect(view.token).toEqual({ label: 'tester', configured: true });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('test-token-for-aidash');
    expect(serialized).not.toContain('sk-should-not-be-stored');

    // 磁盘上也是密文：否则“加密存储”只是说法。
    const secrets = fs.readFileSync(path.join(h.config.secretDir, 'secrets.json'), 'utf8');
    expect(secrets).not.toContain('sk-should-not-be-stored');
  });

  it('模型输出被严格收敛，非 JSON 直接失败', () => {
    const parsed = sanitizeOutput(
      '说明文字 {"analysis_md":"分析","suggestions":[{"text":"建议","confidence":2}],"confidence":0.6}',
    );
    expect(parsed.analysis_md).toBe('分析');
    expect(parsed.suggestions[0]?.confidence).toBeNull();
    expect(parsed.confidence).toBe(0.6);
    expect(() => sanitizeOutput('没有 JSON')).toThrow(AppError);
  });
});
