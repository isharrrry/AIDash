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
  fakes,
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
 * 记忆相关分支。
 *
 * 由 memory-settings-branches 按主题拆出：自动归纳并发/时间窗/素材收敛、
 * 记忆乐观锁、记忆学习器、决策等待。断言保持原样，仅搬移分组。
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * 「等模型超时」类用例的等待预算。
 *
 * 这类用例故意把 enrichment_timeout_ms 设成允许的最小值 5000，再让假模型挂死，
 * 断言超时后落 failed。vitest 默认单测超时也是 5000 —— 两者相等时，
 * 用例自己的预算会先耗尽，失败点从「断言 LLM_TIMEOUT」漂移成「测试超时」。
 * 因此显式给这类用例更长的预算，让被测逻辑先跑完。
 */
const LLM_TIMEOUT_TEST_BUDGET_MS = 15_000;

describe('自动记忆归纳：并发、时间窗与素材收敛', () => {
  it('同项目并发归纳报 DIGEST_RUNNING；失败的上一轮不吃掉时间窗', async () => {
    const h = boot();
    const fake = await newFake();
    configureLlm(h, fake, 5_000);
    seedDigestTasks(h, 'devhost/digest-conflict/x');
    const project = 'digest-conflict';
    const now = h.clock.now();
    const earliest = new Date(now - 7 * DAY_MS).toISOString();

    // 第一次归纳挂死在上游；running 集合里的项目必须拒绝第二次请求。
    fake.setFault({ kind: 'hang' });
    const first = h.ctx.services.memoryDigest.run(project, 'manual');
    const conflict = await captureRejection(
      h.ctx.services.memoryDigest.run(project, 'manual'),
    );
    expect(conflict.code).toBe('CONFLICT');
    expect(conflict.message).toBe('DIGEST_RUNNING');
    expect(conflict.details).toMatchObject({ project });

    const failed = await first;
    expect(failed.result).toBe('failed');
    expect(failed.error_message).toBe('LLM_TIMEOUT');
    expect(failed.window_start).toBe(earliest);

    // 失败记录 created_at 更近，但它不能把时间窗往前推，否则用户配好 key 后
    // 之前那批素材会永远错过归纳。
    fake.setFault(null);
    const line = '- [2026-10-25] [digest] 归纳失败不占用时间窗';
    fake.setContent(JSON.stringify({ lines: [line] }));
    const recovered = await h.ctx.services.memoryDigest.run(project, 'manual');
    expect(recovered.result).toBe('ok');
    expect(recovered.window_start).toBe(earliest);
    expect(h.ctx.services.memoryDigest.listRuns(project)).toHaveLength(2);
  }, LLM_TIMEOUT_TEST_BUDGET_MS);

  it('上一轮成功时，时间窗从上次成功点起算', async () => {
    const h = boot();
    const fake = await newFake(JSON.stringify({ lines: ['- [2026-10-25] [x] 新增约束'] }));
    configureLlm(h, fake);
    seedDigestTasks(h, 'devhost/digest-window/x');
    const project = 'digest-window';
    const now = h.clock.now();
    h.ctx.repos.memoryDigest.insert({
      id: 'dg_prev_ok',
      project,
      trigger: 'manual',
      windowStart: now - 2 * DAY_MS,
      windowEnd: now - HOUR_MS,
      sourceCount: 3,
      appended: 0,
      skippedDuplicates: 0,
      result: 'ok',
      errorMessage: null,
      lines: [],
      createdAt: now - HOUR_MS,
    });

    const run = await h.ctx.services.memoryDigest.run(project, 'manual');
    expect(run.result).toBe('ok');
    expect(run.window_start).toBe(new Date(now - HOUR_MS).toISOString());
  });

  it('模型失败落 failed 并记审计 error；随后成功记 ok', async () => {
    const h = boot();
    const fake = await newFake();
    configureLlm(h, fake);
    seedDigestTasks(h, 'devhost/digest-audit/x');
    const project = 'digest-audit';
    const now = h.clock.now();

    fake.setStatus(500);
    const failed = await h.ctx.services.memoryDigest.run(project, 'manual');
    expect(failed.result).toBe('failed');
    expect(failed.error_message).toBe('LLM_HTTP_ERROR');
    expect(failed.appended).toBe(0);
    expect(auditResults(h, 'memory.digest', project)).toEqual(['error']);

    fake.setFault(null);
    fake.setContent(JSON.stringify({ lines: ['- [2026-10-25] [audit] 恢复后成功'] }));
    const ok = await h.ctx.services.memoryDigest.run(project, 'manual');
    expect(ok.result).toBe('ok');
    // 失败那一轮同样不能提前时间窗。
    expect(ok.window_start).toBe(new Date(now - 7 * DAY_MS).toISOString());
    expect(auditResults(h, 'memory.digest', project)).toEqual(['error', 'ok']);

    // 审计行的 request_id 必须能关联回具体的归纳批次；
    // 空串会让手动归纳和定时归纳的审计记录无法区分、也无法按批次追踪。
    const requestIds = (
      h.db
        .prepare(
          `SELECT request_id FROM audit_log
            WHERE action = 'memory.digest' AND object_id = ?
            ORDER BY id`,
        )
        .all(project) as Array<{ request_id: string | null }>
    ).map((row) => row.request_id);
    expect(requestIds).toEqual([`digest_${failed.id}`, `digest_${ok.id}`]);
  });

  it('模型返回空 lines 时记 empty；空记忆在提示词里显示“（空）”', async () => {
    const h = boot();
    const fake = await newFake(JSON.stringify({ lines: [] }));
    configureLlm(h, fake);
    seedDigestTasks(h, 'devhost/digest-empty/x');

    const run = await h.ctx.services.memoryDigest.run('digest-empty', 'manual');
    expect(run.result).toBe('empty');
    expect(run.lines).toEqual([]);
    expect(run.source_count).toBe(3);
    const user = fake.requests[0]?.body.messages?.[1]?.content ?? '';
    expect(user).toContain('已有记忆（不要重复）');
    expect(user).toContain('（空）');
  });

  it('已有记忆与素材都超长时，提示词按上限截断', async () => {
    const h = boot();
    const fake = await newFake(JSON.stringify({ lines: ['- [2026-10-25] [long] 截断测试'] }));
    configureLlm(h, fake);
    const channel = 'devhost/digest-long/x';
    const taskId = seedTask(h, channel);
    for (let index = 0; index < 26; index += 1) {
      postCard(h, {
        channel_key: channel,
        type: 'info',
        title: `长卡-${index}`,
        body_md: `卡${index} ` + '细'.repeat(600),
        severity: 'info',
        task_id: taskId,
      });
    }
    h.ctx.services.memory.replace(
      { project: 'digest-long', content_md: 'x'.repeat(6_500), expected_version: 0 },
      testCtx(),
    );

    const run = await h.ctx.services.memoryDigest.run('digest-long', 'manual');
    expect(run.result).toBe('ok');
    expect(run.source_count).toBe(27);
    const user = fake.requests[0]?.body.messages?.[1]?.content ?? '';
    // 两处截断：已有记忆 > 6000、素材 > 12000。
    expect(user.split('…（已截断）').length - 1).toBeGreaterThanOrEqual(2);
    expect(user).toContain('x'.repeat(1_000));
  });

  it('素材取样覆盖 summary→detail→body→background 回退与任务原因链', async () => {
    const h = boot();
    const fake = await newFake(JSON.stringify({ lines: [] }));
    configureLlm(h, fake);
    const channel = 'devhost/digest-sources/x';
    const project = 'digest-sources';
    const carrier = seedTask(h, channel, 'CARRIER-TASK');
    h.db.prepare('UPDATE task SET description_md = ? WHERE id = ?').run('TASK-DESC', carrier);

    // 1) summary 优先
    const summaryCard = postCard(h, {
      channel_key: channel,
      type: 'status',
      summary: 'SUMMARY-1',
      result: 'success',
      task_id: carrier,
    }).card;
    // 2) summary 为空时回退 detail_md
    const detailCard = postCard(h, {
      channel_key: channel,
      type: 'status',
      summary: 'TMP-DETAIL',
      result: 'partial',
      task_id: carrier,
    }).card;
    // status 卡有 CHECK(summary IS NOT NULL)，用空串制造“摘要为空”而不是 NULL。
    h.db
      .prepare('UPDATE card SET summary = ?, detail_md = ? WHERE id = ?')
      .run('', 'DETAIL-2', detailCard.id);
    // 3) summary/detail 都空时回退 body_md
    const bodyCard = postCard(h, {
      channel_key: channel,
      type: 'info',
      title: 'BODY-CARD',
      body_md: 'BODY-3',
      severity: 'info',
      task_id: carrier,
    }).card;
    h.db.prepare('UPDATE card SET summary = NULL, detail_md = NULL WHERE id = ?').run(bodyCard.id);
    // 4) 再回退 background_md（question 专属）
    const backgroundCard = postCard(h, {
      ...questionPayload({
        channel_key: channel,
        title: 'BG-CARD',
        background_md: 'BG-4',
      }),
      type: 'question',
    }).card;
    // 5) 四段都空：整条素材被丢弃
    const emptyCard = postCard(h, {
      channel_key: channel,
      type: 'info',
      title: 'EMPTY-CARD',
      body_md: 'NOTEXT',
      severity: 'info',
      task_id: carrier,
    }).card;
    // info 卡有 CHECK(body_md IS NOT NULL)，同样用空串表达“没有正文”。
    h.db
      .prepare('UPDATE card SET summary = NULL, detail_md = NULL, body_md = ? WHERE id = ?')
      .run('', emptyCard.id);

    // 任务原因链：blocked → fail → cancel → defer 逐级回退。
    const reasonTasks = ['BLOCKED-REASON', 'FAIL-REASON', 'CANCEL-REASON', 'DEFER-REASON'].map(
      (title, index) => seedTask(h, channel, `${title}-TASK-${index}`),
    );
    h.db.prepare('UPDATE task SET blocked_reason = ? WHERE id = ?').run('BLOCKED-REASON', reasonTasks[0]);
    h.db.prepare('UPDATE task SET fail_reason = ? WHERE id = ?').run('FAIL-REASON', reasonTasks[1]);
    h.db.prepare('UPDATE task SET cancel_reason = ? WHERE id = ?').run('CANCEL-REASON', reasonTasks[2]);
    h.db.prepare('UPDATE task SET defer_reason = ? WHERE id = ?').run('DEFER-REASON', reasonTasks[3]);

    const run = await h.ctx.services.memoryDigest.run(project, 'manual');
    expect(run.result).toBe('empty');
    // 4 张有素材的卡 + 5 个任务（空卡被丢弃）。
    expect(run.source_count).toBe(9);

    const user = fake.requests[0]?.body.messages?.[1]?.content ?? '';
    expect(user).toContain('SUMMARY-1');
    expect(user).toContain('DETAIL-2');
    expect(user).toContain('BODY-3');
    expect(user).toContain('BG-4');
    expect(user).toContain('[卡片/status/open/success]');
    expect(user).toContain('[卡片/status/open/partial]');
    expect(user).not.toContain('NOTEXT');
    expect(user).not.toContain('EMPTY-CARD');
    expect(user).toContain('（原因：BLOCKED-REASON）');
    expect(user).toContain('（原因：FAIL-REASON）');
    expect(user).toContain('（原因：CANCEL-REASON）');
    expect(user).toContain('（原因：DEFER-REASON）');
    expect(user).toContain('TASK-DESC');
  });

  it('sanitizeDigestLines：坏 JSON、非数组、非字符串、超长与去重', () => {
    expect(sanitizeDigestLines('完全不是 JSON')).toEqual([]);
    expect(sanitizeDigestLines('}{')).toEqual([]);
    expect(sanitizeDigestLines('{oops}')).toEqual([]);
    expect(sanitizeDigestLines('{"lines":"不是数组"}')).toEqual([]);
    expect(sanitizeDigestLines('{"lines":[1,null,"   ","没有两组方括号"]}')).toEqual([]);

    const longLine = 'x'.repeat(2_500);
    const [truncated] = sanitizeDigestLines(
      JSON.stringify({ lines: [`[2026-10-25] [long] ${longLine}`] }),
    );
    expect(truncated).toHaveLength(MAX_MEMORY_LINE_CHARS);

    const deduped = sanitizeDigestLines(
      JSON.stringify({
        lines: ['[d] [k] 同一条', '- [d] [k] 同一条', '  [d] [k] 同一条  '],
      }),
    );
    expect(deduped).toEqual(['- [d] [k] 同一条']);
  });

  it('listRuns 容忍坏 lines_json；start/stop 可重复调用', () => {
    const h = boot();
    const now = h.clock.now();
    h.db
      .prepare(
        `INSERT INTO memory_digest_run
         (id, project, trigger, window_start, window_end, source_count, appended,
          skipped_duplicates, result, error_message, lines_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('dg_bad_json', 'broken', 'manual', now, now, 0, 0, 0, 'ok', null, '{oops', now - 1_000);
    h.db
      .prepare(
        `INSERT INTO memory_digest_run
         (id, project, trigger, window_start, window_end, source_count, appended,
          skipped_duplicates, result, error_message, lines_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('dg_mixed_json', 'broken', 'manual', now, now, 0, 0, 0, 'ok', null, '["keep",7]', now);

    const runs = h.ctx.services.memoryDigest.listRuns('broken');
    expect(runs[0]?.lines).toEqual(['keep']);
    expect(runs[1]?.lines).toEqual([]);

    h.ctx.services.memoryDigest.start();
    h.ctx.services.memoryDigest.stop();
    h.ctx.services.memoryDigest.stop();
    expect(h.ctx.services.memoryDigest.listRuns('broken')).toHaveLength(2);
  });

  it('定时归纳：开关关闭/模型未配置直接返回；按间隔跳过、每轮最多 3 个项目', async () => {
    // 第一段：开关与配置是两道闸门，任一不满足都不发请求。
    const off = boot();
    const offFake = await newFake(JSON.stringify({ lines: ['- [2026-10-25] [s] 不该写入'] }));
    configureLlm(off, offFake);
    seedMemory(off, 'sched-off');
    off.ctx.services.settings.update({ memory_digest_enabled: false }, testCtx());
    await runScheduledNow(off);
    expect(offFake.requests).toHaveLength(0);
    expect(off.ctx.services.memoryDigest.listRuns('sched-off')).toHaveLength(0);

    off.ctx.services.settings.update(
      { memory_digest_enabled: true, llm_api_key: null },
      testCtx(),
    );
    await runScheduledNow(off);
    expect(offFake.requests).toHaveLength(0);
    await offFake.close();
    fakes.splice(fakes.indexOf(offFake), 1);

    // 第二段：5 个项目里，1 个间隔未到被跳过，剩余最多处理 3 个。
    const h = boot();
    const fake = await newFake(JSON.stringify({ lines: ['- [2026-10-25] [sched] 定时约束'] }));
    configureLlm(h, fake);
    const projects = ['p1', 'p2', 'p3', 'p4', 'p5'];
    for (const project of projects) {
      seedMemory(h, project);
      seedDigestTasks(h, `devhost/${project}/digest`);
    }
    const now = h.clock.now();
    h.ctx.repos.memoryDigest.insert({
      id: 'dg_recent_p1',
      project: 'p1',
      trigger: 'manual',
      windowStart: now - DAY_MS,
      windowEnd: now,
      sourceCount: 3,
      appended: 0,
      skippedDuplicates: 0,
      result: 'ok',
      errorMessage: null,
      lines: [],
      createdAt: now,
    });

    await runScheduledNow(h);
    expect(fake.requests).toHaveLength(3);
    const scheduled = projects
      .flatMap((project) => h.ctx.services.memoryDigest.listRuns(project))
      .filter((run) => run.trigger === 'schedule');
    expect(scheduled).toHaveLength(3);
    expect(scheduled.every((run) => run.result === 'ok')).toBe(true);
    // p1 只有手工插入的那条；其余 4 个里还有 1 个没轮到。
    expect(h.ctx.services.memoryDigest.listRuns('p1')).toHaveLength(1);
    const untouched = projects.filter(
      (project) => project !== 'p1' && h.ctx.services.memoryDigest.listRuns(project).length === 0,
    );
    expect(untouched).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 项目记忆 / AIDash 记忆：乐观锁
 * ------------------------------------------------------------------ */

describe('记忆乐观锁：过期版本不静默覆盖', () => {
  it('空项目返回空记忆；过期 expected_version 报冲突且内容不变', () => {
    const h = boot();

    expect(h.ctx.services.memory.get('lock-demo')).toMatchObject({
      exists: false,
      version: 0,
      content_md: '',
      line_count: 0,
    });

    h.ctx.services.memory.append(
      memoryAppendSchema.parse({ project: 'lock-demo', lines: ['- 先落一条约束'] }),
      testCtx(),
    );
    // 页面上拿着旧版本号保存：必须 409，而不是把别的终端刚写的约束覆盖掉。
    const projectConflict = captureAppError(() =>
      h.ctx.services.memory.replace(
        { project: 'lock-demo', content_md: '- 覆盖', expected_version: 0 },
        testCtx(),
      ),
    );
    expect(projectConflict.code).toBe('CONFLICT');
    expect(projectConflict.message).toBe('MEMORY_VERSION_CONFLICT');
    expect(projectConflict.details).toMatchObject({ expected_version: 0, actual_version: 1 });
    expect(h.ctx.services.memory.get('lock-demo').content_md).toBe('- 先落一条约束');

    const projectOk = h.ctx.services.memory.replace(
      { project: 'lock-demo', content_md: '- 已合并后的内容', expected_version: 1 },
      testCtx(),
    );
    expect(projectOk.changed).toBe(true);
    expect(projectOk.memory.version).toBe(2);

    // AIDash 全局记忆复用同一套乐观锁：自动学习器刚追加过时，页面保存要带新版本。
    h.ctx.services.assistantMemory.append(['- 长期经验'], testCtx());
    const assistantConflict = captureAppError(() =>
      h.ctx.services.assistantMemory.replace(
        { content_md: '- 覆盖', expected_version: 0 },
        testCtx(),
      ),
    );
    expect(assistantConflict.code).toBe('CONFLICT');
    expect(assistantConflict.message).toBe('MEMORY_VERSION_CONFLICT');
    expect(h.ctx.services.assistantMemory.get().content_md).toBe('- 长期经验');
  });
});

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */


describe('AIDash 记忆学习器：跳过、失败与行数上限', () => {
  it('模型未配置或无 ready 汇报时分别返回 skipped / empty', async () => {
    const h = boot();
    insertReadyReport(h, 'run_skipped');
    const skipped = await h.ctx.services.assistantMemoryLearner.learn('run_skipped');
    expect(skipped).toMatchObject({ result: 'skipped', appended: 0, error_message: null });

    const fake = await newFake(JSON.stringify({ lines: ['- [2026-10-25] [x] 不该写入'] }));
    configureLlm(h, fake);
    const empty = await h.ctx.services.assistantMemoryLearner.learn('run_without_reports');
    expect(empty).toMatchObject({ result: 'empty', appended: 0 });
    // ready 但正文为空的汇报不算素材。
    insertReadyReport(h, 'run_blank_report', null);
    const blank = await h.ctx.services.assistantMemoryLearner.learn('run_blank_report');
    expect(blank.result).toBe('empty');
    expect(h.ctx.services.assistantMemory.get().exists).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it('模型调用失败记 failed 并写审计 error，不抛出', async () => {
    const h = boot();
    const fake = await newFake();
    configureLlm(h, fake);
    fake.setStatus(500);
    insertReadyReport(h, 'run_model_fail');

    const outcome = await h.ctx.services.assistantMemoryLearner.learn('run_model_fail');
    expect(outcome.result).toBe('failed');
    expect(outcome.error_message).toContain('LLM_HTTP_ERROR');
    expect(auditResults(h, 'assistant_memory.learn', 'run_model_fail')).toEqual(['error']);
  });

  it('写入命中敏感模式时记 failed，已有记忆不变', async () => {
    const h = boot();
    const fake = await newFake(
      JSON.stringify({ lines: ['- [2026-10-25] [auth] token: abcdefghijklmnopqrstuvwxyz'] }),
    );
    configureLlm(h, fake);
    insertReadyReport(h, 'run_secret');

    const outcome = await h.ctx.services.assistantMemoryLearner.learn('run_secret');
    expect(outcome.result).toBe('failed');
    expect(outcome.error_message).toContain('SENSITIVE_PATTERN_DETECTED');
    expect(h.ctx.services.assistantMemory.get().exists).toBe(false);
    expect(auditResults(h, 'assistant_memory.learn', 'run_secret')).toEqual(['error']);
  });

  it('一次最多学 3 行；重复学习全部去重后返回 empty', async () => {
    const h = boot();
    const lines = [1, 2, 3, 4, 5].map((n) => `- [2026-10-25] [k] 经验-${n}`);
    const fake = await newFake(JSON.stringify({ lines }));
    configureLlm(h, fake);
    insertReadyReport(h, 'run_learn');

    const first = await h.ctx.services.assistantMemoryLearner.learn('run_learn');
    expect(first).toMatchObject({ result: 'ok', appended: 3, skipped_duplicates: 0 });
    expect(h.ctx.services.assistantMemory.get().line_count).toBe(3);

    const second = await h.ctx.services.assistantMemoryLearner.learn('run_learn');
    expect(second).toMatchObject({ result: 'empty', appended: 0, skipped_duplicates: 3 });
    expect(h.ctx.services.assistantMemory.get().line_count).toBe(3);
    expect(auditResults(h, 'assistant_memory.learn', 'run_learn')).toEqual(['ok', 'ok']);
  });

  it('同一批次正在学习时再次触发返回 skipped，不产生第二次模型请求', async () => {
    const h = boot();
    const fake = await newFake();
    configureLlm(h, fake, 5_000);
    fake.setFault({ kind: 'hang' });
    insertReadyReport(h, 'run_inflight');

    const first = h.ctx.services.assistantMemoryLearner.learn('run_inflight');
    const second = await h.ctx.services.assistantMemoryLearner.learn('run_inflight');
    expect(second).toMatchObject({ result: 'skipped', appended: 0 });

    const firstOutcome = await first;
    expect(firstOutcome.result).toBe('failed');
    expect(firstOutcome.error_message).toContain('LLM_TIMEOUT');
    expect(fake.requests).toHaveLength(1);
  }, LLM_TIMEOUT_TEST_BUDGET_MS);

  it('buildLearnPrompt：空正文、按行/硬截断、素材预算耗尽', () => {
    expect(buildLearnPrompt([{ title: '空汇报', content_md: null }], '')).toContain('（空）');

    // 单条 7000 字符且没有换行：只能硬截断。
    const hard = buildLearnPrompt([{ title: '长文', content_md: 'x'.repeat(7_000) }], '');
    expect(hard).toContain('…（已截断）');
    expect(hard).not.toContain('x'.repeat(6_001));

    // 换行在截断点后半段：按行截断，不把句子切一半。
    const soft = buildLearnPrompt(
      [{ title: '断行', content_md: 'y'.repeat(5_900) + '\n' + 'z'.repeat(300) }],
      '',
    );
    expect(soft).toContain('…（已截断）');
    expect(soft).not.toContain('z'.repeat(300));

    // 25 条 × 2000 字符超过 36,000 的素材预算，剩余汇报明确省略。
    const many = buildLearnPrompt(
      Array.from({ length: 25 }, (_, index) => ({
        title: `汇报-${index}`,
        content_md: 'm'.repeat(2_000),
      })),
      '',
    );
    expect(many).toContain('（其余汇报已省略）');
  });
});

/* ------------------------------------------------------------------ *
 * 决策等待
 * ------------------------------------------------------------------ */

describe('决策等待：超时、取消与答案兜底', () => {
  it('WaitRegistry：零超时立即返回、abort/cancelAll 释放等待者、未知卡号 resolve 无副作用', async () => {
    const registry = new WaitRegistry(5);
    await expect(registry.wait('cd_zero', 0)).resolves.toBeNull();
    expect(registry.size()).toBe(0);

    const timed = registry.wait('cd_timeout', 25);
    expect(registry.size()).toBe(1);
    await expect(timed).resolves.toBeNull();
    expect(registry.size()).toBe(0);

    const controller = new AbortController();
    const aborted = registry.wait('cd_abort', 10_000, controller.signal);
    controller.abort();
    await expect(aborted).resolves.toBeNull();
    expect(registry.size()).toBe(0);

    const cancelled = [registry.wait('cd_cancel_a', 10_000), registry.wait('cd_cancel_b', 10_000)];
    registry.cancelAll();
    await expect(Promise.all(cancelled)).resolves.toEqual([null, null]);
    expect(registry.size()).toBe(0);

    const answer = {
      option_id: 'yes',
      free_text: null,
      note: null,
      answered_by: 'tester',
      answered_at: new Date().toISOString(),
    };
    const resolved = registry.wait('cd_resolve', 10_000);
    registry.resolve('cd_unknown', answer);
    registry.resolve('cd_resolve', answer);
    await expect(resolved).resolves.toMatchObject({ option_id: 'yes' });
    expect(registry.size()).toBe(0);
  });

  it('ask 幂等键命中已答卡时直接返回 answered，不再等待', async () => {
    const h = boot();
    const channel = 'devhost/decision-idem/x';
    const input = cardAskSchema.parse(
      questionPayload({ channel_key: channel, wait_seconds: 0, idempotency_key: 'ask-idem-1' }),
    ) as CardAskInput;

    const first = await h.ctx.services.decisions.ask(input, testCtx());
    expect(first.status).toBe('pending');
    h.ctx.services.cards.answer(first.card_id, { option_id: 'yes' }, testCtx());

    const second = await h.ctx.services.decisions.ask(input, testCtx());
    expect(second).toMatchObject({ status: 'answered', card_id: first.card_id });
    expect(second.answer?.option_id).toBe('yes');
  });

  it('wait：被回答返回 answered；超时返回 pending；非 open 与缺失答案明确报错', async () => {
    const h = boot({ maxWaitSeconds: 1 });
    const channel = 'devhost/decision-wait/x';

    const answeredCard = postQuestion(h, channel);
    const pendingAnswer = h.ctx.services.decisions.wait(answeredCard.id, 5);
    setTimeout(() => {
      h.ctx.services.cards.answer(answeredCard.id, { option_id: 'yes' }, testCtx());
    }, 20);
    const answered = await pendingAnswer;
    expect(answered.status).toBe('answered');
    expect(answered.answer?.option_id).toBe('yes');

    const timeoutCard = postQuestion(h, channel);
    const startedAt = Date.now();
    const timedOut = await h.ctx.services.decisions.wait(timeoutCard.id, 100);
    expect(timedOut.status).toBe('pending');
    expect(timedOut.poll_after_ms).toBe(1_000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);

    const dismissedCard = postQuestion(h, channel);
    h.db.prepare("UPDATE card SET status = 'dismissed' WHERE id = ?").run(dismissedCard.id);
    const notOpen = await captureRejection(
      h.ctx.services.decisions.wait(dismissedCard.id, 1),
    );
    expect(notOpen.code).toBe('CONFLICT');
    expect(notOpen.message).toBe('CARD_NOT_OPEN');
    expect(notOpen.details).toMatchObject({ status: 'dismissed' });

    const corruptedCard = postQuestion(h, channel);
    h.db
      .prepare("UPDATE card SET status = 'answered', answer_json = NULL, answered_at = ? WHERE id = ?")
      .run(h.clock.now(), corruptedCard.id);
    const missing = await captureRejection(
      h.ctx.services.decisions.wait(corruptedCard.id, 1),
    );
    expect(missing.code).toBe('INTERNAL');
    expect(missing.message).toBe('ANSWER_MISSING');
  });

  it('等待超时后仍以数据库为准：恰好在边界外答完也返回 answered', async () => {
    const h = boot({ maxWaitSeconds: 1 });
    const channel = 'devhost/decision-race/x';
    const input = cardAskSchema.parse(
      questionPayload({ channel_key: channel, wait_seconds: 1 }),
    ) as CardAskInput;
    const pending = h.ctx.services.decisions.ask(input, testCtx());
    await new Promise((resolve) => setTimeout(resolve, 30));
    const open = h.ctx.services.cards.list({
      channelKey: channel,
      types: ['question'],
      statuses: ['open'],
    });
    const cardId = open.items[0]?.id;
    expect(cardId).toBeTruthy();

    // 绕过 onAnswered 回调直接落库，再手动释放等待者：
    // 模拟“答案已提交、唤醒回调却先一步丢失”的竞态。
    h.db
      .prepare("UPDATE card SET status = 'answered', answer_json = ?, answered_at = ? WHERE id = ?")
      .run(
        JSON.stringify({
          option_id: 'yes',
          free_text: null,
          note: null,
          answered_by: 'tester',
          answered_at: new Date(h.clock.now()).toISOString(),
        }),
        h.clock.now(),
        cardId,
      );
    h.ctx.services.decisions.cancelAll();

    const result = await pending;
    expect(result).toMatchObject({ status: 'answered', card_id: cardId });
    expect(result.answer?.option_id).toBe('yes');
  });
});

/* ------------------------------------------------------------------ *
 * LLM 服务
 * ------------------------------------------------------------------ */

