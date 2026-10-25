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
 * 核心服务的状态事件与租约错误分支。
 *
 * 由 core-error-branches 按主题拆出：状态迁移、令牌/原因守卫、证据、认领/释放、
 * 以及 TaskRepo 的原子认领。断言保持原样，仅搬移分组。
 */

describe('TaskService 错误分支', () => {
  it('非法状态迁移：draft 直接 start/complete 被拒，任务保持原状', () => {
    const h = createHarness();
    try {
      const draft = createTask(h, { submit: false });

      const startErr = expectAppError(
        () => updateTask(h, { task_id: draft.id, event: 'start', claim_token: 'cl_fake' }),
        'CONFLICT',
        'TASK_STATE_INVALID',
      );
      expect(startErr.details).toMatchObject({
        guard: 'G-T01',
        event: 'start',
        from: 'draft',
        allowed_from: ['claimed'],
      });

      const completeErr = expectAppError(
        () => updateTask(h, { task_id: draft.id, event: 'complete', claim_token: 'cl_fake' }),
        'CONFLICT',
        'TASK_STATE_INVALID',
      );
      expect(completeErr.details).toMatchObject({ event: 'complete', from: 'draft' });

      // 失败必须没有任何副作用：状态、租约、时间线都不该被写脏。
      const after = h.ctx.services.tasks.get(draft.id);
      expect(after.status).toBe('draft');
      expect(after.claimed_by).toBeNull();
      expect(after.started_at).toBeNull();
      expect(h.ctx.repos.tasks.get(draft.id)?.claim_token).toBeNull();
    } finally {
      h.close();
    }
  });

  it('令牌与原因守卫：缺/错令牌、block/fail 无原因、cancel 无令牌都被拒', () => {
    const h = createHarness();
    try {
      registerHarness(h);
      const task = createTask(h);
      const claim = claimTask(h, task.id);

      expectAppError(
        () => updateTask(h, { task_id: task.id, event: 'start' }),
        'INVALID_ARGUMENT',
        'CLAIM_TOKEN_MISSING',
      );
      expectAppError(
        () => updateTask(h, { task_id: task.id, event: 'start', claim_token: 'cl_wrong' }),
        'FORBIDDEN',
        'CLAIM_TOKEN_MISMATCH',
      );

      const started = updateTask(h, {
        task_id: task.id,
        event: 'start',
        claim_token: claim.claim_token,
      });
      expect(started.status).toBe('in_progress');
      expect(started.started_at).not.toBeNull();

      expectAppError(
        () =>
          updateTask(h, {
            task_id: task.id,
            event: 'block',
            claim_token: claim.claim_token,
          }),
        'INVALID_ARGUMENT',
        'REASON_REQUIRED',
      );
      expectAppError(
        () =>
          updateTask(h, {
            task_id: task.id,
            event: 'fail',
            claim_token: claim.claim_token,
            reason: '   ',
          }),
        'INVALID_ARGUMENT',
        'REASON_REQUIRED',
      );
      // 执行中的任务已经持有令牌，取消也必须证明自己就是持有者。
      expectAppError(
        () => updateTask(h, { task_id: task.id, event: 'cancel', reason: '放弃' }),
        'INVALID_ARGUMENT',
        'CLAIM_TOKEN_MISSING',
      );

      // 上述失败都不能推进状态。
      expect(h.ctx.services.tasks.get(task.id).status).toBe('in_progress');
    } finally {
      h.close();
    }
  });

  it('阻塞/解除/失败：原因与时间线落库，失败清令牌并产生结束通知', () => {
    const h = createHarness();
    try {
      registerHarness(h);
      const task = createTask(h);
      const claim = startTask(h, task.id);

      const blocked = updateTask(h, {
        task_id: task.id,
        event: 'block',
        reason: '等待测试机',
        claim_token: claim.claim_token,
      });
      expect(blocked.status).toBe('blocked');
      expect(blocked.blocked_reason).toBe('等待测试机');
      expect(blocked.blocked_at).not.toBeNull();

      const unblocked = updateTask(h, {
        task_id: task.id,
        event: 'unblock',
        claim_token: claim.claim_token,
      });
      expect(unblocked.status).toBe('in_progress');
      // unblock 刻意保留“最近一次被阻塞”的历史，用于计算阻塞时长。
      expect(unblocked.blocked_at).toBe(blocked.blocked_at);
      expect(unblocked.blocked_reason).toBe('等待测试机');

      const failed = updateTask(h, {
        task_id: task.id,
        event: 'fail',
        reason: '环境不可用',
        claim_token: claim.claim_token,
      });
      expect(failed.status).toBe('failed');
      expect(failed.fail_reason).toBe('环境不可用');
      expect(failed.failed_at).not.toBeNull();
      expect(failed.end_notice_pending).toBe(true);
      expect(h.ctx.repos.tasks.get(task.id)?.claim_token).toBeNull();

      expectAppError(
        () =>
          updateTask(h, {
            task_id: task.id,
            event: 'start',
            claim_token: claim.claim_token,
          }),
        'CONFLICT',
        'TASK_STATE_INVALID',
      );
    } finally {
      h.close();
    }
  });

  it('取消 pending 任务必须写原因；对已取消任务再次取消被状态机拒绝', () => {
    const h = createHarness();
    try {
      const pending = createTask(h);

      expectAppError(
        () => updateTask(h, { task_id: pending.id, event: 'cancel' }),
        'INVALID_ARGUMENT',
        'REASON_REQUIRED',
      );
      expect(h.ctx.services.tasks.get(pending.id).status).toBe('pending');

      const cancelled = updateTask(h, {
        task_id: pending.id,
        event: 'cancel',
        reason: '重复任务',
      });
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancel_reason).toBe('重复任务');
      expect(cancelled.cancelled_at).not.toBeNull();
      expect(cancelled.end_notice_pending).toBe(true);

      expectAppError(
        () => updateTask(h, { task_id: pending.id, event: 'cancel', reason: '再取消一次' }),
        'CONFLICT',
        'TASK_STATE_INVALID',
      );
    } finally {
      h.close();
    }
  });

  it('完成证据：缺失/跨任务/类型不符/已归档全部拒绝，合法 status+artifact 通过', () => {
    const h = createHarness();
    try {
      registerHarness(h);
      const task = createTask(h);
      const claim = startTask(h, task.id);

      const missing = expectAppError(
        () =>
          updateTask(h, {
            task_id: task.id,
            event: 'complete',
            claim_token: claim.claim_token,
            evidence_card_ids: ['cd_missing'],
          }),
        'INVALID_ARGUMENT',
        'EVIDENCE_CARD_NOT_FOUND',
      );
      expect(missing.details?.missing).toEqual(['cd_missing']);

      const info = postCard(h, {
        channel_key: CHANNEL,
        type: 'info',
        title: '只有说明，不算证据',
        body_md: '正文',
        severity: 'info',
        task_id: task.id,
      });
      const wrongType = expectAppError(
        () =>
          updateTask(h, {
            task_id: task.id,
            event: 'complete',
            claim_token: claim.claim_token,
            evidence_card_ids: [info.id],
          }),
        'INVALID_ARGUMENT',
        'EVIDENCE_INVALID',
      );
      expect(wrongType.details).toMatchObject({
        reason: 'must_be_status_with_summary_or_artifact_with_url',
      });

      const otherTask = createTask(h, { title: '另一条任务' });
      const foreign = postCard(h, {
        channel_key: CHANNEL,
        type: 'status',
        summary: '属于别人的证据',
        result: 'success',
        task_id: otherTask.id,
      });
      const notLinked = expectAppError(
        () =>
          updateTask(h, {
            task_id: task.id,
            event: 'complete',
            claim_token: claim.claim_token,
            evidence_card_ids: [foreign.id],
          }),
        'INVALID_ARGUMENT',
        'EVIDENCE_INVALID',
      );
      expect(notLinked.details).toMatchObject({ reason: 'not_linked_to_task' });

      const archivedCard = postCard(h, {
        channel_key: CHANNEL,
        type: 'status',
        summary: '已归档的证据',
        result: 'success',
        task_id: task.id,
      });
      h.ctx.services.cards.archive(archivedCard.id, testCtx());
      const archivedErr = expectAppError(
        () =>
          updateTask(h, {
            task_id: task.id,
            event: 'complete',
            claim_token: claim.claim_token,
            evidence_card_ids: [archivedCard.id],
          }),
        'INVALID_ARGUMENT',
        'EVIDENCE_INVALID',
      );
      expect(archivedErr.details).toMatchObject({
        reason: 'must_be_status_with_summary_or_artifact_with_url',
      });

      // 合法的两类证据：带 summary 的 status、带 url 的 artifact。
      const statusCard = postCard(h, {
        channel_key: CHANNEL,
        type: 'status',
        summary: '修复并验证完成',
        result: 'success',
        task_id: task.id,
      });
      const artifactCard = postCard(h, {
        channel_key: CHANNEL,
        type: 'artifact',
        url: 'https://example.com/logs/build.txt',
        kind: 'log',
        summary: '构建日志',
        size_bytes: 42,
        task_id: task.id,
      });

      const done = updateTask(h, {
        task_id: task.id,
        event: 'complete',
        claim_token: claim.claim_token,
        evidence_card_ids: [statusCard.id, artifactCard.id],
      });
      expect(done.status).toBe('done');
      expect(done.evidence_ids).toEqual([statusCard.id, artifactCard.id]);
      expect(done.completed_at).not.toBeNull();
      expect(done.end_notice_pending).toBe(true);

      const raw = h.ctx.repos.tasks.get(task.id)!;
      expect(raw.claim_token).toBeNull();
      expect(raw.claim_expires_at).toBeNull();
    } finally {
      h.close();
    }
  });

  it('证据 id 重复：去重后正常完成，不再误报「找不到」（D-2 回归守卫）', () => {
    const h = createHarness();
    try {
      registerHarness(h);
      const task = createTask(h);
      const claim = startTask(h, task.id);
      const statusCard = postCard(h, {
        channel_key: CHANNEL,
        type: 'status',
        summary: '重复传入也应算一次证据',
        result: 'success',
        task_id: task.id,
      });

      // 回归守卫（原 D-2）：findByIds 结果天然去重，旧实现拿它和原始数组比长度，
      // 会把「重复」误判成「有卡不存在」，且 missing 为空。
      const done = updateTask(h, {
        task_id: task.id,
        event: 'complete',
        claim_token: claim.claim_token,
        evidence_card_ids: [statusCard.id, statusCard.id],
      });
      expect(done.status).toBe('done');
      expect(done.evidence_ids).toEqual([statusCard.id]);
    } finally {
      h.close();
    }
  });

  it('认领：未注册 harness 被拒；同 harness 续租沿用令牌；租约过期可被接管', () => {
    const h = createHarness();
    try {
      registerHarness(h, HARNESS_ID);
      registerHarness(h, HARNESS_ALT);
      const task = createTask(h);

      expectAppError(
        () =>
          h.ctx.services.tasks.claim(
            { task_id: task.id, harness_id: 'h-unknown' },
            testCtx(),
          ),
        'INVALID_ARGUMENT',
        'HARNESS_NOT_REGISTERED',
      );

      const draft = createTask(h, { submit: false });
      const notClaimable = expectAppError(
        () =>
          h.ctx.services.tasks.claim(
            { task_id: draft.id, harness_id: HARNESS_ID },
            testCtx(),
          ),
        'CONFLICT',
        'TASK_NOT_CLAIMABLE',
      );
      expect(notClaimable.details?.status).toBe('draft');

      const first = h.ctx.services.tasks.claim(
        { task_id: task.id, harness_id: HARNESS_ID, lease_seconds: 1 },
        testCtx(),
      );
      expect(first.task.status).toBe('claimed');
      expect(first.renewed).toBe(false);
      expect(Date.parse(first.lease_expires_at)).toBe(h.clock.now() + 1_000);

      expectAppError(
        () =>
          h.ctx.services.tasks.claim(
            { task_id: task.id, harness_id: HARNESS_ALT },
            testCtx(),
          ),
        'ALREADY_CLAIMED',
        'TASK_ALREADY_CLAIMED',
      );

      const renewed = h.ctx.services.tasks.claim(
        { task_id: task.id, harness_id: HARNESS_ID, lease_seconds: 60 },
        testCtx(),
      );
      expect(renewed.renewed).toBe(true);
      // 续租不换令牌：同一持有者没有必要重新分发密钥。
      expect(renewed.claim_token).toBe(first.claim_token);

      h.clock.advance(90_000);
      const takeover = h.ctx.services.tasks.claim(
        { task_id: task.id, harness_id: HARNESS_ALT, lease_seconds: 60 },
        testCtx(),
      );
      expect(takeover.task.claimed_by).toBe(HARNESS_ALT);
      expect(takeover.claim_token).not.toBe(first.claim_token);

      // 旧令牌必须彻底失效，不能继续驱动被接管的任务。
      expectAppError(
        () =>
          updateTask(h, {
            task_id: task.id,
            event: 'start',
            claim_token: first.claim_token,
          }),
        'FORBIDDEN',
        'CLAIM_TOKEN_MISMATCH',
      );

      h.clock.advance(120_000);
      expect(h.ctx.services.tasks.expireLeases(h.clock.now())).toBe(1);
      const reclaimed = h.ctx.services.tasks.get(task.id);
      expect(reclaimed.status).toBe('pending');
      expect(reclaimed.claimed_by).toBeNull();
      expect(reclaimed.claim_expires_at).toBeNull();
      // 已回收的租约再次扫描不应重复计数。
      expect(h.ctx.services.tasks.expireLeases(h.clock.now())).toBe(0);
    } finally {
      h.close();
    }
  });

  it('释放：错令牌被拒；正确令牌回到 pending 并保留已开工时间', () => {
    const h = createHarness();
    try {
      registerHarness(h);
      const task = createTask(h);
      const claim = startTask(h, task.id);
      const startedAt = h.ctx.services.tasks.get(task.id).started_at;

      expectAppError(
        () =>
          h.ctx.services.tasks.release(
            { task_id: task.id, claim_token: 'cl_bad', reason: '交接' },
            testCtx(),
          ),
        'FORBIDDEN',
        'CLAIM_TOKEN_MISMATCH',
      );

      const released = updateTask(h, {
        task_id: task.id,
        event: 'release',
        claim_token: claim.claim_token,
        reason: '交接给下一班',
      });
      expect(released.status).toBe('pending');
      expect(released.claimed_by).toBeNull();
      expect(released.started_at).toBe(startedAt);
      expect(h.ctx.repos.tasks.get(task.id)?.claim_token).toBeNull();

      // 已经释放的任务没有可匹配的令牌，重复释放同样报 mismatch。
      expectAppError(
        () =>
          h.ctx.services.tasks.release(
            { task_id: task.id, claim_token: claim.claim_token },
            testCtx(),
          ),
        'FORBIDDEN',
        'CLAIM_TOKEN_MISMATCH',
      );
    } finally {
      h.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * TaskRepo：原子认领、关闭、统计
 * ------------------------------------------------------------------ */

describe('TaskRepo 错误分支', () => {
  it('claim：不存在/续租/他人持有/租约接管/不可认领，release 校验令牌与状态', () => {
    const h = createHarness();
    try {
      const repo = h.ctx.repos.tasks;
      const now = h.clock.now();

      expect(repo.claim('tk_missing', HARNESS_ID, 'cl_x', now, 60)).toMatchObject({
        ok: false,
        reason: 'NOT_FOUND',
      });

      const task = createTask(h);
      const first = repo.claim(task.id, HARNESS_ID, 'cl_a', now, 60);
      expect(first).toMatchObject({ ok: true, claimToken: 'cl_a' });
      expect(first.renewed).toBeUndefined();

      const renewed = repo.claim(task.id, HARNESS_ID, 'cl_b', now, 120);
      expect(renewed).toMatchObject({ ok: true, renewed: true, claimToken: 'cl_a' });

      expect(repo.claim(task.id, HARNESS_ALT, 'cl_c', now, 60)).toMatchObject({
        ok: false,
        reason: 'ALREADY_CLAIMED',
      });

      h.clock.advance(121_000);
      const takeover = repo.claim(task.id, HARNESS_ALT, 'cl_c', h.clock.now(), 60);
      expect(takeover).toMatchObject({ ok: true, claimToken: 'cl_c' });

      const draft = createTask(h, { submit: false });
      expect(repo.claim(draft.id, HARNESS_ID, 'cl_d', h.clock.now(), 60)).toMatchObject({
        ok: false,
        reason: 'NOT_CLAIMABLE',
      });

      expect(repo.release(task.id, 'cl_a', h.clock.now())).toBe(false);
      expect(repo.release(task.id, 'cl_c', h.clock.now())).toBe(true);
      expect(repo.get(task.id)?.status).toBe('pending');
    } finally {
      h.close();
    }
  });

});
