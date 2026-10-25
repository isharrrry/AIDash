import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { cardPostSchema, taskCreateSchema, taskUpdateSchema } from '../src/shared/schemas.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import { TaskService } from '../src/server/services/task-service.js';
import { latestMigrationVersion, migrate, schemaVersion } from '../src/server/db/migrate.js';
import { openDb } from '../src/server/db/connection.js';
import {
  CHANNEL,
  HARNESS_ALT,
  HARNESS_ID,
  OTHER_CHANNEL,
  claimTask,
  createTask,
  expectAppError,
  postCard,
  registerHarness,
  seedCardTask,
  shallowDepthService,
  startTask,
  updateTask,
} from './fakes/core-fixtures.js';
import {
  createHarness,
  questionPayload,
  testCtx,
  type TestHarness,
} from './helpers.js';

/**
 * 卡片与支撑仓储的错误分支。
 *
 * 由 core-error-branches 按主题拆出：CardService 的回答/生命周期/发卡守卫、
 * 事件/审计/harness/知识库/设置仓储。断言保持原样，仅搬移分组。
 */

/* ------------------------------------------------------------------ *
 * CardService：回答守卫、生命周期、发卡守卫、到期
 * ------------------------------------------------------------------ */

describe('CardService 错误分支', () => {
  it('回答守卫：非 question/不存在/非 open/非法选项/自由文本开关逐项校验', () => {
    const h = createHarness();
    try {
      const taskId = seedCardTask(h);
      const info = postCard(h, {
        channel_key: CHANNEL,
        type: 'info',
        title: '不是决策卡',
        body_md: '正文',
        severity: 'info',
        task_id: taskId,
      });
      expectAppError(
        () => h.ctx.services.cards.answer(info.id, { option_id: 'yes' }, testCtx()),
        'INVALID_ARGUMENT',
        'CARD_NOT_QUESTION',
      );
      expectAppError(
        () => h.ctx.services.cards.answer('cd_missing', { option_id: 'yes' }, testCtx()),
        'NOT_FOUND',
        'CARD_NOT_FOUND',
      );

      const question = postCard(
        h,
        questionPayload({ channel_key: CHANNEL, type: 'question' }),
      );
      expectAppError(
        () => h.ctx.services.cards.answer(question.id, { option_id: 'nope' }, testCtx()),
        'INVALID_ARGUMENT',
        'OPTION_NOT_FOUND',
      );
      expectAppError(
        () => h.ctx.services.cards.answer(question.id, { free_text: '随便写' }, testCtx()),
        'INVALID_ARGUMENT',
        'FREE_TEXT_NOT_ALLOWED',
      );

      const freeTextCard = postCard(
        h,
        questionPayload({
          channel_key: CHANNEL,
          type: 'question',
          title: '允许自由文本',
          allow_free_text: true,
        }),
      );
      expectAppError(
        () => h.ctx.services.cards.answer(freeTextCard.id, { free_text: '   ' }, testCtx()),
        'INVALID_ARGUMENT',
        'ANSWER_REQUIRED',
      );
      const answered = h.ctx.services.cards.answer(
        freeTextCard.id,
        { free_text: '  先观察  ', note: '备注' },
        testCtx(),
      );
      expect(answered.status).toBe('answered');
      expect(answered.answer?.free_text).toBe('先观察');

      const chosen = h.ctx.services.cards.answer(
        question.id,
        { option_id: 'yes', note: '先恢复' },
        testCtx(),
      );
      expect(chosen.status).toBe('answered');
      expectAppError(
        () => h.ctx.services.cards.answer(question.id, { option_id: 'no' }, testCtx()),
        'CONFLICT',
        'CARD_NOT_OPEN',
      );
    } finally {
      h.close();
    }
  });

  it('批量回答部分成功：逐项错误码、计数正确，成功的卡落库、失败的保持原状', () => {
    const h = createHarness();
    try {
      const answerable = postCard(
        h,
        questionPayload({ channel_key: CHANNEL, type: 'question' }),
      );
      const already = postCard(
        h,
        questionPayload({ channel_key: CHANNEL, type: 'question', title: '已经答过的卡' }),
      );
      h.ctx.services.cards.answer(already.id, { option_id: 'yes' }, testCtx());

      const result = h.ctx.services.cards.batchAnswer(
        [
          { card_id: answerable.id, answer: { option_id: 'yes' } },
          { card_id: 'cd_missing', answer: { option_id: 'yes' } },
          { card_id: already.id, answer: { option_id: 'no' } },
        ],
        testCtx(),
      );

      expect(result.success_count).toBe(1);
      expect(result.failure_count).toBe(2);
      expect(result.results.map((item) => item.ok)).toEqual([true, false, false]);
      expect(result.results[1]!.error?.code).toBe('NOT_FOUND');
      expect(result.results[2]!.error?.code).toBe('CONFLICT');
      expect(h.ctx.services.cards.get(answerable.id).status).toBe('answered');
      expect(h.ctx.services.cards.get(answerable.id).answer?.option_id).toBe('yes');
      expect(h.ctx.services.cards.get(already.id).answer?.option_id).toBe('yes');
    } finally {
      h.close();
    }
  });

  it('回答竞态：读卡后被抢先答掉时返回 CARD_NOT_OPEN，不覆盖先到的答案', () => {
    const h = createHarness();
    try {
      const card = postCard(h, questionPayload({ channel_key: CHANNEL, type: 'question' }));
      // 模拟另一个请求在“读状态”和“原子更新”之间完成了回答。
      const spy = vi.spyOn(h.ctx.repos.cards, 'setAnswered').mockReturnValue(false);
      try {
        const error = expectAppError(
          () => h.ctx.services.cards.answer(card.id, { option_id: 'yes' }, testCtx()),
          'CONFLICT',
          'CARD_NOT_OPEN',
        );
        expect(error.details).toMatchObject({ guard: 'G-C03', status: 'answered' });
      } finally {
        spy.mockRestore();
      }

      // 竞态失败没有锁死卡片，恢复后仍可正常回答。
      expect(
        h.ctx.services.cards.answer(card.id, { option_id: 'yes' }, testCtx()).status,
      ).toBe('answered');
    } finally {
      h.close();
    }
  });

  it('建议卡与产物列表：kb_refs 参与敏感扫描，多产物取最新体积且不重复', () => {
    const h = createHarness();
    try {
      const taskId = seedCardTask(h);
      const suggestion = postCard(h, {
        channel_key: CHANNEL,
        type: 'suggestion',
        analysis_md: '建议先回滚',
        suggestions: [{ text: '回滚到上一版', rationale: '影响面最小' }],
        kb_refs: [{ path: 'wiki/runbook.md', title: '手册', excerpt: '回滚步骤' }],
        task_id: taskId,
      });
      expect(suggestion.type).toBe('suggestion');
      expect(suggestion.kb_refs[0]?.path).toBe('wiki/runbook.md');

      const artifact = postCard(h, {
        channel_key: CHANNEL,
        type: 'artifact',
        task_id: taskId,
        url: 'reports/build.log',
        kind: 'log',
        summary: '构建日志',
        size_bytes: 100,
      });
      // 同一张卡关联两条 artifact：列表只认最新一条的体积，不能重复计数。
      h.ctx.repos.artifacts.insert({
        id: 'ar_extra',
        card_id: artifact.id,
        kind: 'log',
        url: 'reports/build-newer.log',
        summary: null,
        size_bytes: 999,
        created_at: h.clock.now() + 1,
      });
      const artifacts = h.ctx.services.cards.list({
        channelKey: CHANNEL,
        types: ['artifact'],
      });
      expect(artifacts.items).toHaveLength(1);
      expect(artifacts.items[0]!.size_bytes).toBe(999);

      // 关键词筛选直接走 list：q 命中 summary。
      const found = h.ctx.services.cards.list({ channelKey: CHANNEL, q: '构建日志' });
      expect(found.items.map((item) => item.id)).toContain(artifact.id);
    } finally {
      h.close();
    }
  });

  it('卡片生命周期：不存在、重复 dismiss、重复 archive、归档后改 meta 均按约定报错', () => {
    const h = createHarness();
    try {
      const taskId = seedCardTask(h);
      expectAppError(
        () => h.ctx.services.cards.get('cd_missing'),
        'NOT_FOUND',
        'CARD_NOT_FOUND',
      );
      expectAppError(
        () => h.ctx.services.cards.markRead('cd_missing', testCtx()),
        'NOT_FOUND',
        'CARD_NOT_FOUND',
      );

      const card = postCard(h, {
        channel_key: CHANNEL,
        type: 'info',
        title: '生命周期卡',
        body_md: '正文',
        severity: 'info',
        task_id: taskId,
      });
      const firstRead = h.ctx.services.cards.markRead(card.id, testCtx());
      h.clock.advance(1_000);
      const secondRead = h.ctx.services.cards.markRead(card.id, testCtx());
      // 已读时间回答“第一次什么时候看到”，重复点击不刷新。
      expect(secondRead.read_at).toBe(firstRead.read_at);

      h.ctx.services.cards.dismiss(card.id, testCtx());
      expectAppError(
        () => h.ctx.services.cards.dismiss(card.id, testCtx()),
        'CONFLICT',
        'CARD_NOT_OPEN',
      );

      expect(h.ctx.services.cards.archive(card.id, testCtx()).status).toBe('archived');
      expect(h.ctx.services.cards.archive(card.id, testCtx()).status).toBe('archived');
      expectAppError(
        () => h.ctx.services.cards.updateMeta(card.id, { title: '改标题' }, testCtx()),
        'CONFLICT',
        'CARD_ARCHIVED',
      );
    } finally {
      h.close();
    }
  });

  it('发卡守卫：非 question 必须挂任务、任务不存在、链接/产物 URL 不安全', () => {
    const h = createHarness();
    try {
      // 绕过 zod 直接调 service，验证“唯一写入口”自己再守一次。
      const raw = {
        channel_key: CHANNEL,
        type: 'info',
        title: '无归属信息',
        body_md: '正文',
        severity: 'info',
        priority: 'P2',
        allow_free_text: false,
        blocking: false,
      } as unknown as CardPostInput;
      const noTask = expectAppError(
        () => h.ctx.services.cards.post(raw, testCtx()),
        'INVALID_ARGUMENT',
        'TASK_REQUIRED',
      );
      expect(noTask.details?.type).toBe('info');

      expectAppError(
        () =>
          postCard(h, {
            channel_key: CHANNEL,
            type: 'info',
            title: '任务不存在',
            body_md: '正文',
            severity: 'info',
            task_id: 'tk_missing',
          }),
        'NOT_FOUND',
        'TASK_NOT_FOUND',
      );

      const taskId = seedCardTask(h);
      // schema 之外的内部调用方也不能把 body_md 交给 status 卡：
      // 以前它会被静默丢弃，现在 service 自己也拒绝。
      const withBody = expectAppError(
        () =>
          h.ctx.services.cards.post(
            {
              channel_key: CHANNEL,
              type: 'status',
              summary: '状态卡',
              result: 'success',
              body_md: '会被吞掉的正文',
              task_id: taskId,
              priority: 'P2',
              allow_free_text: false,
              blocking: false,
            } as unknown as CardPostInput,
            testCtx(),
          ),
        'INVALID_ARGUMENT',
        'BODY_MD_NOT_SUPPORTED',
      );
      expect(withBody.details?.use).toBe('detail_md');

      const unsafeLink = expectAppError(
        () =>
          postCard(h, {
            channel_key: CHANNEL,
            type: 'info',
            title: '危险链接',
            body_md: '正文',
            severity: 'info',
            task_id: taskId,
            links: [{ label: '点我', url: 'javascript:alert(1)' }],
          }),
        'INVALID_ARGUMENT',
        'UNSAFE_URL_SCHEME',
      );
      expect(unsafeLink.details?.protocol).toBe('javascript:');

      expectAppError(
        () =>
          postCard(h, {
            channel_key: CHANNEL,
            type: 'artifact',
            task_id: taskId,
            url: 'data:text/plain,hello',
            kind: 'file',
            summary: 'data URL 产物',
          }),
        'INVALID_ARGUMENT',
        'UNSAFE_URL_SCHEME',
      );

      // 相对路径产物合法，体积落 artifact 表并回到视图。
      const artifact = postCard(h, {
        channel_key: CHANNEL,
        type: 'artifact',
        task_id: taskId,
        url: 'reports/build.log',
        kind: 'log',
        summary: '构建日志',
        size_bytes: 2048,
      });
      expect(artifact.size_bytes).toBe(2048);
      expect(h.ctx.services.cards.get(artifact.id).size_bytes).toBe(2048);
      expect(h.ctx.repos.artifacts.listByCard(artifact.id)).toHaveLength(1);
      expect(h.ctx.repos.artifacts.listByCard('cd_none')).toEqual([]);
      expect(h.ctx.repos.artifacts.get('ar_none')).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it('到期决策卡：到点标记 expired，重复扫描不重复计数，过期后不能回答', () => {
    const h = createHarness();
    try {
      const dueAt = new Date(h.clock.now() + 1_000).toISOString();
      const due = postCard(
        h,
        questionPayload({ channel_key: CHANNEL, type: 'question', due_at: dueAt }),
      );
      const noDue = postCard(
        h,
        questionPayload({
          channel_key: CHANNEL,
          type: 'question',
          title: '没有期限的决策',
        }),
      );

      expect(h.ctx.services.cards.expireDueQuestions(h.clock.now())).toBe(0);
      h.clock.advance(2_000);
      expect(h.ctx.services.cards.expireDueQuestions(h.clock.now())).toBe(1);
      expect(h.ctx.services.cards.get(due.id).status).toBe('expired');
      expect(h.ctx.services.cards.get(noDue.id).status).toBe('open');
      expect(h.ctx.services.cards.expireDueQuestions(h.clock.now())).toBe(0);
      expectAppError(
        () => h.ctx.services.cards.answer(due.id, { option_id: 'yes' }, testCtx()),
        'CONFLICT',
        'CARD_NOT_OPEN',
      );
    } finally {
      h.close();
    }
  });

  it('卡片视图容错：损坏的 JSON 列降级为空值，不把坏数据变成 500', () => {
    const h = createHarness();
    try {
      const taskId = seedCardTask(h);
      const card = postCard(h, {
        channel_key: CHANNEL,
        type: 'status',
        summary: '状态卡',
        result: 'success',
        task_id: taskId,
      });
      h.db
        .prepare(
          `UPDATE card SET options_json='{bad', answer_json='{bad', suggestions_json='{bad',
             kb_refs_json='{bad', links_json='{bad', enrichment_json='{bad'
           WHERE id = ?`,
        )
        .run(card.id);

      const view = h.ctx.services.cards.get(card.id);
      expect(view.options).toEqual([]);
      expect(view.answer).toBeNull();
      expect(view.suggestions).toEqual([]);
      expect(view.kb_refs).toEqual([]);
      expect(view.links).toEqual([]);
      expect(view.enrichment.status).toBe('skipped');
    } finally {
      h.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * support-repos：事件、审计、harness、知识库、设置
 * ------------------------------------------------------------------ */

describe('support-repos 错误与边界分支', () => {
  it('事件流水：detail 省略写 NULL，按时间倒序返回，未知对象为空', () => {
    const h = createHarness();
    try {
      const task = createTask(h, { submit: false });
      const card = postCard(h, {
        channel_key: CHANNEL,
        type: 'info',
        title: '事件测试卡',
        body_md: '正文',
        severity: 'info',
        task_id: task.id,
      });
      const events = h.ctx.repos.events;

      events.task(task.id, 'manual_a', 'tester', undefined, 1);
      events.task(task.id, 'manual_b', 'tester', { n: 1 }, 2);
      events.card(card.id, 'manual_c', null, { ok: true }, 1);

      const taskEvents = (events.listTask(task.id) as Array<{
        event: string;
        detail_json: string | null;
      }>).filter((event) => event.event.startsWith('manual'));
      expect(taskEvents.map((event) => event.event)).toEqual(['manual_b', 'manual_a']);
      expect(taskEvents[0]!.detail_json).toBe(JSON.stringify({ n: 1 }));
      expect(taskEvents[1]!.detail_json).toBeNull();

      const cardEvents = (events.listCard(card.id) as Array<{ event: string }>).filter((event) =>
        event.event.startsWith('manual'),
      );
      expect(cardEvents).toHaveLength(1);
      expect(events.listTask('tk_unknown')).toEqual([]);
      expect(events.listCard('cd_unknown')).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('审计：追加链接 prev_hash，筛选条件生效，断链能被 verifyChain 定位', () => {
    const h = createHarness();
    try {
      const audit = h.ctx.repos.audit;
      const channel = h.ctx.services.channels.ensure({ channel_key: CHANNEL }, testCtx()).channel;
      const now = h.clock.now();

      expect(audit.list({ since: now + 1 }).total).toBe(0);
      expect(audit.list({ until: now - 1 }).total).toBe(0);
      expect(audit.list({ action: 'channel.create' }).total).toBeGreaterThanOrEqual(1);
      expect(audit.list({ object_type: 'channel' }).total).toBeGreaterThanOrEqual(1);
      expect(audit.list({ object_id: channel.id }).total).toBeGreaterThanOrEqual(1);
      expect(audit.list({ result: 'denied' }).total).toBe(0);
      expect(audit.verifyChain()).toEqual({ ok: true });

      const before = audit.lastHash();
      const entry = audit.append({
        ts: now,
        actor_label: 'tester',
        action: 'test.manual',
        object_type: null,
        object_id: null,
        result: 'ok',
        request_id: null,
        detail_json: null,
      });
      expect(entry.prev_hash).toBe(before);
      expect(audit.verifyChain()).toEqual({ ok: true });

      // audit_log 的触发器只禁止 UPDATE/DELETE；直接插入一条断链记录模拟磁盘损坏。
      h.db
        .prepare(
          `INSERT INTO audit_log
             (ts, actor_label, action, object_type, object_id, result, request_id,
              detail_json, prev_hash, hash)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(now, 'tester', 'test.broken', null, null, 'ok', null, null, null, 'deadbeef');
      const broken = audit.verifyChain();
      expect(broken.ok).toBe(false);
      expect(broken.broken_at).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });

  it('harness：disabled 不被心跳/重新注册覆盖，离线回收只碰过期 online', () => {
    const h = createHarness();
    try {
      const repo = h.ctx.repos.harnesses;
      const now = h.clock.now();

      const created = repo.upsert({
        harness_id: 'h-a',
        name: 'A',
        host: 'host-a',
        capabilities_json: '["exec"]',
        now,
      });
      expect(created.status).toBe('online');
      expect(repo.get('h-missing')).toBeUndefined();

      repo.setStatus('h-a', 'disabled', now);
      const reRegistered = repo.upsert({
        harness_id: 'h-a',
        name: 'A2',
        host: null,
        capabilities_json: null,
        now: now + 1,
      });
      expect(reRegistered.name).toBe('A2');
      // 人工封禁是更高优先级的运维意图，重新注册不能把状态改回 online。
      expect(reRegistered.status).toBe('disabled');

      expect(repo.heartbeat('h-a', now + 2)).toBe(true);
      expect(repo.get('h-a')?.status).toBe('disabled');
      expect(repo.get('h-a')?.last_seen).toBe(now + 2);
      expect(repo.heartbeat('h-missing', now)).toBe(false);

      repo.upsert({
        harness_id: 'h-b',
        name: 'B',
        host: null,
        capabilities_json: null,
        now,
      });
      // cutoff 必须严格大于 last_seen 才算离线。
      expect(repo.markOffline(now, now + 1)).toBe(0);
      expect(repo.markOffline(now + 1, now + 2)).toBe(1);
      expect(repo.get('h-b')?.status).toBe('offline');
      expect(repo.markOffline(now + 3, now + 4)).toBe(0);

      repo.setStatus('h-b', 'online', now + 5);
      expect(repo.get('h-b')?.status).toBe('online');
      expect(repo.list().map((item) => item.harness_id).sort()).toEqual(['h-a', 'h-b']);
    } finally {
      h.close();
    }
  });

  it('知识库：类型/标签过滤、空查询降级 LIKE、删除与统计', () => {
    const h = createHarness();
    try {
      const kb = h.ctx.repos.kb;
      const now = h.clock.now();
      kb.upsertDoc(
        {
          path: 'wiki/login.md',
          type: 'runbook',
          title: '登录排查',
          description: '登录接口失败',
          tags_json: '["auth","login"]',
          doc_date: '2026-01-01',
          hash: 'h1',
          indexed_at: now,
        },
        '登录接口失败时先查网关白名单。',
      );
      kb.upsertDoc(
        {
          path: 'wiki/other.md',
          type: 'note',
          title: '其他文档',
          description: '无关内容',
          tags_json: '["misc"]',
          doc_date: null,
          hash: 'h2',
          indexed_at: now,
        },
        '其他内容',
      );

      expect(kb.search('登录', { type: 'runbook' }).map((hit) => hit.path)).toEqual([
        'wiki/login.md',
      ]);
      expect(kb.search('登录', { type: 'note' })).toEqual([]);
      expect(kb.search('登录', { tags: ['auth'] }).map((hit) => hit.path)).toEqual([
        'wiki/login.md',
      ]);
      expect(kb.search('登录', { tags: ['missing'] })).toEqual([]);

      // 空查询会让 FTS5 报语法错误，repo 必须降级为 LIKE 而不是 500。
      expect(
        kb
          .search('')
          .map((hit) => hit.path)
          .sort(),
      ).toEqual(['wiki/login.md', 'wiki/other.md']);

      // tags_json 损坏时搜索结果只丢标签，不能整个查询失败。
      kb.upsertDoc(
        {
          path: 'wiki/broken.md',
          type: 'note',
          title: '坏标签文档',
          description: null,
          tags_json: '{bad',
          doc_date: null,
          hash: 'h3',
          indexed_at: now,
        },
        '坏标签文档正文',
      );
      const broken = kb.search('坏标签');
      expect(broken).toHaveLength(1);
      expect(broken[0]!.tags).toEqual([]);

      expect(kb.getByPath('wiki/missing.md')).toBeUndefined();
      expect(kb.removeByPath('wiki/missing.md')).toBe(false);
      expect(kb.removeByPath('wiki/other.md')).toBe(true);
      expect(kb.removeByPath('wiki/broken.md')).toBe(true);
      expect(kb.listPaths()).toEqual(['wiki/login.md']);
      expect(kb.listDocs({ type: 'runbook' }).total).toBe(1);
      expect(kb.listDocs().items).toHaveLength(1);
      expect(kb.stats()).toMatchObject({ docs: 1, last_indexed_at: now });
      expect(kb.stats().types).toEqual([{ type: 'runbook', count: 1 }]);
    } finally {
      h.close();
    }
  });

  it('设置：缺失键、损坏 JSON 读取降级，写入可覆盖', () => {
    const h = createHarness();
    try {
      const setting = h.ctx.repos.setting;
      expect(setting.get('missing')).toBeUndefined();
      setting.set('k', { a: 1 }, h.clock.now());
      expect(setting.get('k')).toEqual({ a: 1 });

      h.db
        .prepare("INSERT INTO setting(key, value_json, updated_at) VALUES ('broken', '{oops', ?)")
        .run(h.clock.now());
      expect(setting.get('broken')).toBeUndefined();
      expect(setting.all()).toMatchObject({ k: { a: 1 }, broken: null });

      setting.set('k', [1, 2], h.clock.now());
      expect(setting.get('k')).toEqual([1, 2]);
    } finally {
      h.close();
    }
  });
});
