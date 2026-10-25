import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_MEMORY_LINE_CHARS } from '../src/shared/constants.js';
import { AppError } from '../src/shared/errors.js';
import {
  cardAskSchema,
  cardPostSchema,
  memoryAppendSchema,
  taskCreateSchema,
} from '../src/shared/schemas.js';
import type { Db } from '../src/server/db/connection.js';
import type { AssistantMemoryService } from '../src/server/services/assistant-memory-service.js';
import { buildLearnPrompt } from '../src/server/services/assistant-memory-learner.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import type { CardAskInput } from '../src/server/services/decision-service.js';
import { WaitRegistry } from '../src/server/services/decision-service.js';
import { buildKbQueries, sanitizeOutput } from '../src/server/services/enrichment-service.js';
import { KbService, normalizeRelative, safeJoin } from '../src/server/services/kb-service.js';
import { LlmService } from '../src/server/services/llm-service.js';
import { sanitizeDigestLines } from '../src/server/services/memory-digest-service.js';
import { SecretStore } from '../src/server/services/secret-store.js';
import { DEFAULT_PROMPTS, SettingsService } from '../src/server/services/settings-service.js';
import { startFakeLlm, type FakeLlm } from './fakes/fake-llm.js';
import {
  auditResults,
  boot,
  captureAppError,
  captureRejection,
  cleanupFixtures,
  configureLlm,
  insertReadyReport,
  newFake,
  postCard,
  postQuestion,
  runScheduledNow,
  seedDigestTasks,
  seedMemory,
  tempDir,
  waitFor,
} from './fakes/memory-settings-fixtures.js';
import {
  createHarness,
  questionPayload,
  seedTask,
  testCtx,
  type TestHarness,
} from './helpers.js';

afterEach(cleanupFixtures);

/**
 * 设置 / 知识库 / 增强 / LLM 服务分支。
 *
 * 由 memory-settings-branches 按主题拆出：设置校验与密钥来源、KB 路径与索引、
 * 增强队列与失败隔离、LLM 服务响应形状。断言保持原样，仅搬移分组。
 */

describe('设置：非法值、持久化与密钥来源', () => {
  it('逐项校验失败：范围、模式、URL、提示词与密钥形状', () => {
    const h = boot();
    const cases: Array<{ patch: Record<string, unknown>; message: string; key?: string }> = [
      { patch: { enrichment_timeout_ms: 4_999 }, message: 'SETTING_OUT_OF_RANGE', key: 'enrichment_timeout_ms' },
      { patch: { enrichment_timeout_ms: Number.NaN }, message: 'SETTING_OUT_OF_RANGE', key: 'enrichment_timeout_ms' },
      { patch: { memory_digest_interval_hours: 0 }, message: 'SETTING_OUT_OF_RANGE', key: 'memory_digest_interval_hours' },
      { patch: { memory_digest_window_days: 91 }, message: 'SETTING_OUT_OF_RANGE', key: 'memory_digest_window_days' },
      { patch: { card_retention_days: 29 }, message: 'SETTING_OUT_OF_RANGE', key: 'card_retention_days' },
      { patch: { card_retention_days: 3_651 }, message: 'SETTING_OUT_OF_RANGE', key: 'card_retention_days' },
      { patch: { audit_min_retention_days: 29 }, message: 'SETTING_OUT_OF_RANGE', key: 'audit_min_retention_days' },
      { patch: { log_retention_days: 6 }, message: 'SETTING_OUT_OF_RANGE', key: 'log_retention_days' },
      { patch: { llm_mode: 'turbo' }, message: 'INVALID_LLM_MODE' },
      { patch: { llm_endpoint: '不是 URL' }, message: 'INVALID_URL' },
      { patch: { llm_endpoint: 'ftp://example.com/v1' }, message: 'UNSAFE_URL_SCHEME' },
      { patch: { prompts: { report: 'x'.repeat(8_001) } }, message: 'PROMPT_TOO_LARGE', key: 'report' },
      { patch: { prompts: { report: '   ' } }, message: 'PROMPT_EMPTY', key: 'report' },
      { patch: { llm_api_key: 'short' }, message: 'INVALID_LLM_API_KEY' },
      { patch: { llm_api_key: 'has space inside' }, message: 'INVALID_LLM_API_KEY' },
      { patch: { llm_api_key: 123 }, message: 'INVALID_LLM_API_KEY' },
    ];
    for (const item of cases) {
      const error = captureAppError(() =>
        h.ctx.services.settings.update(item.patch as never, testCtx()),
      );
      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toBe(item.message);
      if (item.key) expect(error.details).toMatchObject({ key: item.key });
    }
    // 校验失败不改运行时：默认 60 秒、24 小时间隔仍然生效。
    expect(h.ctx.services.settings.current()).toMatchObject({
      enrichmentTimeoutMs: 60_000,
      memoryDigestIntervalHours: 24,
      memoryDigestWindowDays: 7,
      llmMode: 'max',
    });
  });

  it('合法更新落库并生效；提示词只改指定 key；密钥永不进 setting 表', () => {
    const h = boot();
    const view = h.ctx.services.settings.update(
      {
        enrichment_enabled: false,
        enrichment_timeout_ms: 120_000,
        llm_endpoint: 'https://example.com/v1',
        llm_model: '',
        llm_mode: 'fast',
        prompts: { report: '只写结论' },
        memory_digest_enabled: false,
        memory_digest_interval_hours: 12,
        memory_digest_window_days: 30,
        kb_root: '',
        card_retention_days: 90,
        // 审计保留期只允许调长：默认 730，这里必须往上调才算合法更新。
        audit_min_retention_days: 800,
        log_retention_days: 15,
        llm_api_key: 'sk-page-key-123',
      },
      testCtx(),
    );

    expect(view.enrichment).toMatchObject({
      enabled: false,
      timeout_ms: 120_000,
      // 空串表示放弃页面覆盖：model 立即回退到配置文件默认值，而不是变成 null。
      llm: { endpoint: 'https://example.com/v1', model: 'deepseek-flash', mode: 'fast' },
    });
    expect(view.memory_digest).toEqual({ enabled: false, interval_hours: 12, window_days: 30 });
    expect(view.kb).toEqual({ root: null, configured: false });
    expect(view.retention).toEqual({ card_days: 90, audit_days: 800, log_days: 15 });
    expect(view.prompts.find((item) => item.key === 'report')?.system).toBe('只写结论');
    // 没改的提示词继续用默认，避免“改一个清空其他”。
    expect(view.prompts.find((item) => item.key === 'card_analysis')?.system).toBe(
      DEFAULT_PROMPTS.card_analysis,
    );
    expect(view.server.schema_version).toBeGreaterThan(0);

    const persisted = h.ctx.repos.setting.get<Record<string, unknown>>('runtime') ?? {};
    expect(JSON.stringify(persisted)).not.toContain('llm_api_key');
    expect(JSON.stringify(persisted)).not.toContain('sk-page-key-123');
    expect(Object.keys(persisted)).toEqual(
      expect.arrayContaining([
        'prompts',
        'memory_digest_enabled',
        'memory_digest_interval_hours',
        'memory_digest_window_days',
        'kb_root',
        'card_retention_days',
        'audit_min_retention_days',
        'log_retention_days',
        'enrichment_timeout_ms',
        'llm_endpoint',
        'llm_model',
        'llm_mode',
      ]),
    );
    expect(auditResults(h, 'settings.update')).toContain('ok');
  });

  it('页面密钥 > 环境变量；清除页面密钥会回退到环境变量', () => {
    const h = boot();
    const config = {
      ...h.config,
      llm: { ...h.config.llm, apiKey: 'sk-env-key-123' },
    };
    const svc = new SettingsService(
      config,
      h.ctx.repos.setting,
      h.db,
      h.ctx.services.audit,
      h.clock,
      new SecretStore(h.config.secretDir),
    );
    expect(svc.current()).toMatchObject({
      llmApiKey: 'sk-env-key-123',
      llmApiKeySource: 'env',
    });

    svc.update({ llm_api_key: 'sk-page-key-456' }, testCtx());
    expect(svc.current()).toMatchObject({
      llmApiKey: 'sk-page-key-456',
      llmApiKeySource: 'file',
    });
    const ciphertext = fs.readFileSync(path.join(h.config.secretDir, 'secrets.json'), 'utf8');
    expect(ciphertext).not.toContain('sk-page-key-456');

    svc.update({ llm_api_key: '' }, testCtx());
    expect(svc.current()).toMatchObject({
      llmApiKey: 'sk-env-key-123',
      llmApiKeySource: 'env',
    });
    expect(svc.view().enrichment.llm.key_source).toBe('env');

    // 显式 undefined 也表示“清除页面密钥”，不应被当成未触碰。
    svc.update({ llm_api_key: undefined }, testCtx());
    expect(svc.current().llmApiKeySource).toBe('env');
    const keyAudits = h.db
      .prepare("SELECT result, detail_json FROM audit_log WHERE action = 'settings.llm_key' ORDER BY id")
      .all() as Array<{ result: string; detail_json: string | null }>;
    expect(keyAudits.map((row) => row.result)).toEqual(['ok', 'ok', 'ok']);
    expect(keyAudits.map((row) => JSON.parse(row.detail_json ?? '{}').action)).toEqual([
      'set',
      'clear',
      'clear',
    ]);
  });

  it('审计保留期只能调长：缩小请求直接拒绝，相等幂等放行', () => {
    const h = boot();
    const svc = h.ctx.services.settings;
    // 默认 730；先调大到 800 作为“当前值”。
    expect(svc.view().retention.audit_days).toBe(730);
    expect(svc.update({ audit_min_retention_days: 800 }, testCtx()).retention.audit_days).toBe(800);

    const error = captureAppError(() =>
      svc.update({ audit_min_retention_days: 799 }, testCtx()),
    );
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toBe('AUDIT_RETENTION_CANNOT_SHRINK');
    expect(error.details).toMatchObject({ current: 800, requested: 799 });
    // 拒绝后运行时与视图都保持原值：不能“报错了但还是改了”。
    expect(svc.view().retention.audit_days).toBe(800);
    expect(
      (h.ctx.repos.setting.get<Record<string, unknown>>('runtime') ?? {})
        .audit_min_retention_days,
    ).toBe(800);

    // 等于当前值是幂等提交（设置页保存整张表单时会重复带上），必须放行。
    expect(svc.update({ audit_min_retention_days: 800 }, testCtx()).retention.audit_days).toBe(800);
  });

  it('设置页视图区分「没配」与「解不开」：解不开时给出原因码', () => {
    const h = boot();
    const svc = h.ctx.services.settings;
    const store = new SecretStore(h.config.secretDir);
    expect(svc.view().enrichment.llm.key_state).toBe('not_configured');

    store.writeLlmKey('sk-page-key-xyz');
    expect(svc.view().enrichment.llm.key_state).toBe('ok');

    // 模拟换机/误删主密钥：视图必须说“解不开”，而不是安静地变回“没配”。
    fs.rmSync(path.join(h.config.secretDir, 'master.key'));
    const view = svc.view().enrichment.llm;
    expect(view.key_state).toBe('unreadable');
    expect(view.key_error).toBe('master_key_missing');
  });

  it('混合提交里有非法字段时，密钥不能被提前替换（D-5 回归守卫）', () => {
    const h = boot();
    const svc = new SettingsService(
      h.config,
      h.ctx.repos.setting,
      h.db,
      h.ctx.services.audit,
      h.clock,
      new SecretStore(h.config.secretDir),
    );
    svc.update({ llm_api_key: 'sk-old-key-123' }, testCtx());
    expect(svc.current()).toMatchObject({
      llmApiKey: 'sk-old-key-123',
      llmApiKeySource: 'file',
    });

    const error = captureAppError(() =>
      svc.update({ llm_api_key: 'sk-new-key-456', enrichment_timeout_ms: 4_999 }, testCtx()),
    );
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toBe('SETTING_OUT_OF_RANGE');

    // 整单失败：磁盘上的密钥仍是旧的，运行时也不变。
    expect(new SecretStore(h.config.secretDir).readLlmKey()).toBe('sk-old-key-123');
    expect(svc.current()).toMatchObject({
      llmApiKey: 'sk-old-key-123',
      llmApiKeySource: 'file',
      enrichmentTimeoutMs: 60_000,
    });
    // 合法字段也不能被落库：校验失败即整单不生效。
    const persisted = h.ctx.repos.setting.get<Record<string, unknown>>('runtime') ?? {};
    expect(persisted).not.toHaveProperty('enrichment_timeout_ms');
  });

  it('启动时对持久化的坏值做归一化：非法模式回退、空提示词忽略', () => {
    const h = boot();
    h.ctx.repos.setting.set(
      'runtime',
      {
        llm_mode: 'turbo',
        prompts: { report: '   ', kb_suggestion: 'CUSTOM-KB' },
        memory_digest_enabled: false,
      },
      h.clock.now(),
    );
    const svc = new SettingsService(
      h.config,
      h.ctx.repos.setting,
      h.db,
      h.ctx.services.audit,
      h.clock,
      new SecretStore(h.config.secretDir),
    );
    const runtime = svc.current();
    expect(runtime.llmMode).toBe(h.config.llm.mode);
    expect(runtime.prompts.report).toBe(DEFAULT_PROMPTS.report);
    expect(runtime.prompts.kb_suggestion).toBe('CUSTOM-KB');
    expect(runtime.memoryDigestEnabled).toBe(false);
  });

  it('schema 版本读取失败时降级为 0，而不是让设置页整体 500', () => {
    const h = boot();
    const brokenDb = {
      prepare: () => {
        throw new Error('no such table: schema_migration');
      },
    } as unknown as Db;
    const svc = new SettingsService(
      h.config,
      h.ctx.repos.setting,
      brokenDb,
      h.ctx.services.audit,
      h.clock,
      new SecretStore(h.config.secretDir),
    );
    expect(svc.view().server.schema_version).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 知识库
 * ------------------------------------------------------------------ */

describe('知识库：路径越界、坏 frontmatter 与索引容错', () => {
  it('未配置 / 文档缺失 / 目录当文档都明确报错；穿越路径拒绝', () => {
    const unconfigured = boot({ kbRoot: null });
    expect(unconfigured.ctx.services.kb.isConfigured()).toBe(false);
    expect(unconfigured.ctx.services.kb.stats()).toMatchObject({ configured: false, root: null });
    expect(captureAppError(() => unconfigured.ctx.services.kb.get('a.md')).message).toBe(
      'KB_NOT_CONFIGURED',
    );
    expect(captureAppError(() => unconfigured.ctx.services.kb.index()).message).toBe(
      'KB_NOT_CONFIGURED',
    );

    const dir = tempDir('aidash-kb-branch-');
    fs.mkdirSync(path.join(dir, 'sub'));
    const h = boot({ kbRoot: dir });
    const missing = captureAppError(() => h.ctx.services.kb.get('missing.md'));
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.message).toBe('KB_DOC_NOT_FOUND');
    expect(captureAppError(() => h.ctx.services.kb.get('sub')).message).toBe('KB_DOC_NOT_FOUND');

    for (const unsafe of ['../outside.md', '/etc/passwd', 'a/../../outside.md', '']) {
      const error = captureAppError(() => safeJoin(dir, unsafe));
      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toBe('KB_PATH_UNSAFE');
    }
    expect(captureAppError(() => h.ctx.services.kb.get('../outside.md')).message).toBe(
      'KB_PATH_UNSAFE',
    );
    expect(normalizeRelative('a\\b//c.md')).toBe('a/b/c.md');
    expect(normalizeRelative('./x.md')).toBe('x.md');
  });

  it('坏 frontmatter 不阻断索引；跳过目录/非 Markdown/超大文件；删除后索引清理', () => {
    const dir = tempDir('aidash-kb-index-');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.mkdirSync(path.join(dir, 'wiki'));
    fs.writeFileSync(
      path.join(dir, '.git', 'hidden.md'),
      '# 不该被索引\n',
    );
    fs.writeFileSync(path.join(dir, 'node_modules', 'skipped.md'), '# 也不该被索引\n');
    fs.writeFileSync(path.join(dir, 'note.txt'), '不是 Markdown\n');
    // 非法 YAML：整篇按正文处理，标题回退到一级标题。
    fs.writeFileSync(
      path.join(dir, 'bad-yaml.md'),
      '---\ntags: [unclosed\n---\n# Bad YAML\n\n正文仍然保留\n',
    );
    // 以 --- 开头但没有闭合分隔线：同样按正文处理。
    fs.writeFileSync(path.join(dir, 'unclosed.md'), '---\ntype: runbook\n# 未闭合标题\n\n正文\n');
    // frontmatter 解析出标量而不是对象：忽略元数据。
    fs.writeFileSync(path.join(dir, 'scalar.md'), '---\n42\n---\n# Scalar 标题\n\n内容\n');
    // 元数据类型不符合预期：各字段回退到默认。
    fs.writeFileSync(
      path.join(dir, 'weird.md'),
      [
        '---',
        'type: 123',
        'title: [数组标题]',
        'description: 5',
        'tags: [ops, 2026]',
        "doc_date: '2026-02-03'",
        '---',
        '正文没有标题',
      ].join('\n'),
    );
    // 字符串 tags：逗号、中文逗号、空白都算分隔符。
    fs.writeFileSync(
      path.join(dir, 'tags-string.md'),
      '---\ntags: auth, gateway　ui\n---\n# Tags String\n',
    );
    // 无 frontmatter、无标题。
    fs.writeFileSync(path.join(dir, 'untagged.md'), '没有标题也没有 frontmatter 的正文\n');
    // 超过 2MB：记录 file_too_large，不读入内存。
    fs.writeFileSync(path.join(dir, 'huge.md'), Buffer.alloc(2 * 1024 * 1024 + 10, 0x61));

    const h = boot({ kbRoot: dir });
    const report = h.ctx.services.kb.index();
    // 超大文件在收集阶段就记错误、不进待索引列表，因此 scanned 只数 6 个可读文件。
    expect(report.scanned).toBe(6);
    expect(report.indexed).toBe(6);
    expect(report.unchanged).toBe(0);
    expect(report.errors).toEqual([{ path: 'huge.md', message: 'file_too_large' }]);

    const docs = h.ctx.services.kb.listDocs().items;
    const byPath = new Map(docs.map((doc) => [doc.path, doc]));
    expect(byPath.get('bad-yaml.md')).toMatchObject({ type: 'doc', title: 'Bad YAML', tags: [] });
    expect(byPath.get('unclosed.md')?.title).toBe('未闭合标题');
    expect(byPath.get('scalar.md')?.title).toBe('Scalar 标题');
    expect(byPath.get('weird.md')).toMatchObject({
      type: 'doc',
      title: null,
      description: null,
      tags: ['ops', '2026'],
      doc_date: '2026-02-03',
    });
    expect(byPath.get('tags-string.md')?.tags).toEqual(['auth', 'gateway', 'ui']);
    expect(byPath.get('untagged.md')).toMatchObject({ title: null, tags: [] });
    expect(byPath.has('note.txt')).toBe(false);
    expect(byPath.has('.git/hidden.md')).toBe(false);

    // get 对坏 frontmatter 文档仍返回正文。
    expect(h.ctx.services.kb.get('bad-yaml.md').body).toContain('正文仍然保留');
    expect(h.ctx.services.kb.index().unchanged).toBe(6);

    fs.rmSync(path.join(dir, 'untagged.md'));
    const afterDelete = h.ctx.services.kb.index();
    expect(afterDelete.removed).toBe(1);
    expect(afterDelete.scanned).toBe(5);

    // 索引之外的脏数据不应让列表接口崩掉。
    h.db.prepare("UPDATE kb_doc SET tags_json = '{bad' WHERE path = 'tags-string.md'").run();
    h.db.prepare("UPDATE kb_doc SET tags_json = '{\"a\":1}' WHERE path = 'weird.md'").run();
    const corrupted = new Map(h.ctx.services.kb.listDocs().items.map((doc) => [doc.path, doc]));
    expect(corrupted.get('tags-string.md')?.tags).toEqual([]);
    expect(corrupted.get('weird.md')?.tags).toEqual([]);
  });

  it('根目录本身是文件时索引记录错误而不是崩溃；字符串根目录同样生效', () => {
    const h = boot();
    const notDir = path.join(tempDir('aidash-kb-file-root-'), 'root.md');
    fs.writeFileSync(notDir, '# 不是目录\n');
    const broken = new KbService(notDir, h.ctx.repos.kb, h.clock);
    const report = broken.index();
    expect(report.scanned).toBe(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.message.length).toBeGreaterThan(0);

    // 字符串形态的根目录（不是 getter）也必须工作：构造期固化也是一种合法用法。
    const dir = tempDir('aidash-kb-string-root-');
    fs.writeFileSync(path.join(dir, 'login.md'), '# 登录排查\n\n网关白名单未放行会导致登录 500。\n');
    const kb = new KbService(dir, h.ctx.repos.kb, h.clock);
    expect(kb.isConfigured()).toBe(true);
    expect(kb.index().indexed).toBe(1);
    expect(kb.search('登录').items[0]?.path).toBe('login.md');
  });
});

/* ------------------------------------------------------------------ *
 * 增强队列
 * ------------------------------------------------------------------ */

describe('增强：队列上限、停止与失败隔离', () => {
  it('队列最多 200 条；stop 清空队列并拒绝后续调度', async () => {
    const h = boot();
    const scheduler = h.ctx.services.enrichment as unknown as {
      queue: string[];
      queued: Set<string>;
    };
    for (let index = 0; index < 210; index += 1) {
      h.ctx.services.enrichment.schedule(`cd_queue_${index}`);
    }
    // 第一条已被 drain 同步取走，其余 200 条占满队列，后面的直接丢弃。
    expect(scheduler.queue).toHaveLength(200);
    expect(scheduler.queue[0]).toBe('cd_queue_1');
    expect(scheduler.queue.at(-1)).toBe('cd_queue_200');
    expect(scheduler.queued.size).toBe(200);

    h.ctx.services.enrichment.stop();
    expect(scheduler.queue).toHaveLength(0);
    expect(scheduler.queued.size).toBe(0);
    h.ctx.services.enrichment.schedule('cd_after_stop');
    expect(scheduler.queue).toHaveLength(0);
    // 让 drain 的微任务跑完，避免关闭数据库后还有 Promise 继续执行。
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('停止后 runOne 不再碰数据库；start 会把 pending 卡重新拉回队列', async () => {
    const h = boot();
    const card = postQuestion(h, 'devhost/enrich-start/x');
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.ctx.repos.cards.setEnrichment(card.id, 'pending', null);

    h.ctx.services.enrichment.stop();
    await h.ctx.services.enrichment.runOne(card.id);
    expect(h.ctx.repos.cards.get(card.id)?.enrichment_status).toBe('pending');

    h.ctx.repos.cards.setEnrichment(card.id, 'pending', null);
    h.ctx.services.enrichment.start();
    await waitFor(() => h.ctx.repos.cards.get(card.id)?.enrichment_status !== 'pending');
    expect(h.ctx.repos.cards.get(card.id)?.enrichment_status).toBe('skipped');
    const events = h.db
      .prepare('SELECT event, detail_json FROM card_event WHERE card_id = ? ORDER BY rowid')
      .all(card.id) as Array<{ event: string; detail_json: string | null }>;
    const skippedEvent = events.find((row) => row.event === 'enrichment_skipped');
    expect(skippedEvent).toBeTruthy();
    expect(JSON.parse(skippedEvent?.detail_json ?? '{}')).toMatchObject({
      reason: 'enrichment_disabled',
    });
    h.ctx.services.enrichment.stop();
  });

  it('start 会把上次进程残留的 running 卡重置为 pending 并重新排队', async () => {
    const h = boot();
    const card = postQuestion(h, 'devhost/enrich-recover/x');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 模拟“上一进程在模型调用中途被杀”：库里留下 running，但没有任何活着的任务。
    h.ctx.repos.cards.setEnrichment(card.id, 'running', null);

    h.ctx.services.enrichment.start();
    // enrichmentEnabled=false 时会落 skipped——能走到这一步就证明 running 被重新当作 pending 处理了。
    await waitFor(() => h.ctx.repos.cards.get(card.id)?.enrichment_status === 'skipped');

    h.ctx.services.enrichment.stop();
    await h.ctx.services.enrichment.waitForIdle();
  });

  it('模型未配置落 unavailable；不存在的卡与非 pending 卡直接早退', async () => {
    const h = boot({ enrichmentEnabled: true });
    const card = postQuestion(h, 'devhost/enrich-nokey/x');
    await waitFor(() => h.ctx.repos.cards.get(card.id)?.enrichment_status === 'unavailable');

    const saved = h.ctx.repos.cards.get(card.id);
    expect(JSON.parse(saved?.enrichment_json ?? '{}')).toEqual({
      status: 'unavailable',
      reason: 'llm_not_configured',
    });
    const events = h.db
      .prepare('SELECT event, detail_json FROM card_event WHERE card_id = ?')
      .all(card.id) as Array<{ event: string; detail_json: string }>;
    expect(events.some((row) => row.event === 'enrichment_unavailable')).toBe(true);

    // 不存在的卡不抛错；已落 unavailable 的卡不会被二次改写。
    await h.ctx.services.enrichment.runOne('cd_missing');
    await h.ctx.services.enrichment.runOne(card.id);
    expect(h.ctx.repos.cards.get(card.id)?.enrichment_json).toBe(saved?.enrichment_json);
  });

  it('知识库搜索抛错不阻断增强；问题卡把背景与选项带进提示词', async () => {
    const kbDir = tempDir('aidash-kb-enrich-branch-');
    const h = boot({ enrichmentEnabled: true, kbRoot: kbDir });
    const fake = await newFake(
      JSON.stringify({ analysis_md: '分析', suggestions: [{ text: '建议' }], confidence: 0.5 }),
    );
    const card = postQuestion(h, 'devhost/enrich-kb/x');
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.ctx.repos.cards.setEnrichment(card.id, 'pending', null);
    configureLlm(h, fake);

    const kb = h.ctx.services.kb as unknown as { search: (...args: unknown[]) => unknown };
    const originalSearch = kb.search;
    kb.search = () => {
      throw new Error('kb index broken');
    };
    try {
      await h.ctx.services.enrichment.runOne(card.id);
    } finally {
      kb.search = originalSearch;
    }

    const saved = h.ctx.repos.cards.get(card.id);
    const view = JSON.parse(saved?.enrichment_json ?? '{}') as {
      status: string;
      has_kb_basis: boolean;
      kb_refs: unknown[];
    };
    expect(view.status).toBe('done');
    expect(view.has_kb_basis).toBe(false);
    expect(view.kb_refs).toEqual([]);
    const user = fake.requests[0]?.body.messages?.[1]?.content ?? '';
    expect(user).toContain('背景：');
    expect(user).toContain('选项：');
    expect(user).toContain('知识库片段：无');
  });

  it('sanitizeOutput：字段类型/长度/取值范围逐项收敛', () => {
    const parsed = sanitizeOutput(
      `前言 ${JSON.stringify({
        analysis_md: 'a'.repeat(4_100),
        suggestions: [
          null,
          { text: '', rationale: '空正文应丢弃' },
          { text: 'ok', rationale: 7, confidence: -1 },
          { text: 'ok2', confidence: 0.5 },
        ],
        confidence: 2,
      })}`,
    );
    expect(parsed.analysis_md).toHaveLength(4_000);
    expect(parsed.suggestions.map((item) => item.text)).toEqual(['ok', 'ok2']);
    expect(parsed.suggestions[0]).toMatchObject({ rationale: null, confidence: null });
    expect(parsed.suggestions[1]?.confidence).toBe(0.5);
    expect(parsed.confidence).toBeNull();
    expect(sanitizeOutput('{"analysis_md":5}')).toEqual({
      analysis_md: '',
      suggestions: [],
      confidence: null,
    });
    expect(() => sanitizeOutput('没有 JSON')).toThrow(/LLM_OUTPUT_NOT_JSON/);
    expect(() => sanitizeOutput('{不是 JSON}')).toThrow(/LLM_OUTPUT_NOT_JSON/);
  });

  it('buildKbQueries：标点清洗、每字段前 4 词、重复查询合并', () => {
    expect(
      buildKbQueries({ title: '登录 500 排查', background_md: null, body_md: null }),
    ).toEqual(['登录 500 排查']);
    expect(
      buildKbQueries({ title: '，。；：', background_md: '   ', body_md: null }),
    ).toEqual([]);
    expect(
      buildKbQueries({
        title: 'A B C D E F',
        background_md: 'A B C D E F',
        body_md: null,
      }),
    ).toEqual(['A B C D']);
  });
});

/* ------------------------------------------------------------------ *
 * AIDash 记忆学习器
 * ------------------------------------------------------------------ */


describe('LLM 服务：未配置、记忆注入与响应形状', () => {
  it('未配置时 chat 明确报 LLM_NOT_CONFIGURED', async () => {
    const h = boot();
    expect(h.ctx.services.llm.isConfigured()).toBe(false);
    const error = await captureRejection(h.ctx.services.llm.chat({ system: 's', user: 'u' }));
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('LLM_NOT_CONFIGURED');
  });

  it('没有记忆服务或读取记忆失败时，system 保持原样', async () => {
    const h = boot();
    const fake = await newFake('可用');
    configureLlm(h, fake);

    const bare = new LlmService(h.ctx.services.settings);
    await bare.chat({ system: 'BASE-NO-MEMORY', user: 'u' });
    expect(fake.requests.at(-1)?.body.messages?.[0]?.content).toBe('BASE-NO-MEMORY');

    const throwingMemory = {
      get: () => {
        throw new Error('memory table broken');
      },
    } as unknown as AssistantMemoryService;
    const degraded = new LlmService(h.ctx.services.settings, throwingMemory);
    await degraded.chat({ system: 'BASE-DEGRADED', user: 'u' });
    expect(fake.requests.at(-1)?.body.messages?.[0]?.content).toBe('BASE-DEGRADED');
  });

  it('长期记忆超过 8000 字符时按硬截断/换行截断，并带过时提示', async () => {
    const h = boot();
    const fake = await newFake('可用');
    configureLlm(h, fake);

    h.ctx.services.assistantMemory.replace(
      { content_md: 'x'.repeat(9_000), expected_version: 0 },
      testCtx(),
    );
    await h.ctx.services.llm.chat({ system: 'BASE', user: 'u' });
    const hard = fake.requests.at(-1)?.body.messages?.[0]?.content ?? '';
    expect(hard).toContain('记忆过长，已截断；可在记忆页整理');
    expect(hard).toContain('x'.repeat(8_000));
    expect(hard).not.toContain('x'.repeat(8_001));
    expect(hard).toContain('不是本轮指令');

    h.ctx.services.assistantMemory.replace(
      { content_md: 'a'.repeat(7_000) + '\n' + 'b'.repeat(2_000), expected_version: 1 },
      testCtx(),
    );
    await h.ctx.services.llm.chat({ system: 'BASE', user: 'u' });
    const soft = fake.requests.at(-1)?.body.messages?.[0]?.content ?? '';
    expect(soft).toContain('记忆过长，已截断；可在记忆页整理');
    expect(soft).toContain('a'.repeat(7_000));
    expect(soft).not.toContain('b'.repeat(2_000));
  });

  it('兼容 content 为 parts 数组；content 形状无法识别时报 EMPTY_RESPONSE', async () => {
    const h = boot();
    const fake = await newFake();
    configureLlm(h, fake);
    const llm = h.ctx.services.llm;

    // 少数网关把 content 返回成 parts 数组：字符串拼接，非法片段忽略。
    fake.setContent(['a', { text: 'b' }, { text: 5 }, 3] as unknown as string);
    await expect(llm.chat({ system: 's', user: 'u' })).resolves.toBe('ab');

    // content 是对象而不是字符串/数组：无法提取文本，必须报错而不是返回空串。
    fake.setContent({ unexpected: true } as unknown as string);
    const error = await captureRejection(llm.chat({ system: 's', user: 'u' }));
    expect(error.message).toBe('LLM_EMPTY_RESPONSE');
  });
});
