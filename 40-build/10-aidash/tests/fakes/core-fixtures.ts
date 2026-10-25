import { expect } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { cardPostSchema, taskCreateSchema, taskUpdateSchema } from '../../src/shared/schemas.js';
import type { CardPostInput } from '../../src/server/services/card-service.js';
import { TaskService } from '../../src/server/services/task-service.js';
import { testCtx, type TestHarness } from '../helpers.js';

/**
 * core-error-branches 拆分后的共享夹具。
 *
 * 这里只放“多个测试文件都要用”的建任务/认领/发卡样板；
 * 断言仍留在各自的用例文件里，避免把行为期望藏进工具函数。
 */

export const CHANNEL = 'devhost/core-error/topic';
export const OTHER_CHANNEL = 'devhost/core-error/other';
export const HARNESS_ID = 'h-core';
export const HARNESS_ALT = 'h-core-alt';

export function expectAppError(fn: () => unknown, code: string, message: string): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    // 业务 message 不是给人看的句子，而是稳定的机器码（如 TASK_CHANNEL_MISMATCH）。
    expect(appError.message).toBe(message);
    return appError;
  }
  throw new Error(`expected AppError(${code}/${message}) but nothing was thrown`);
}

export function registerHarness(h: TestHarness, id = HARNESS_ID): void {
  h.ctx.repos.harnesses.upsert({
    harness_id: id,
    name: id,
    host: null,
    capabilities_json: null,
    now: h.clock.now(),
  });
}

export function createTask(
  h: TestHarness,
  options: {
    channel?: string;
    title?: string;
    submit?: boolean;
    parent_id?: string;
    description_md?: string;
    category?: string;
    assignee?: string;
    idempotency_key?: string;
  } = {},
) {
  const { channel = CHANNEL, submit = true, ...rest } = options;
  return h.ctx.services.tasks.create(
    taskCreateSchema.parse({
      channel_key: channel,
      title: options.title ?? '错误分支测试任务',
      ...rest,
    }),
    testCtx(),
    { submit },
  ).task;
}

export function updateTask(h: TestHarness, body: Record<string, unknown>) {
  return h.ctx.services.tasks.update(taskUpdateSchema.parse(body), testCtx());
}

export function claimTask(h: TestHarness, taskId: string, harnessId = HARNESS_ID) {
  return h.ctx.services.tasks.claim({ task_id: taskId, harness_id: harnessId }, testCtx());
}

export function startTask(h: TestHarness, taskId: string) {
  const claim = claimTask(h, taskId);
  updateTask(h, { task_id: taskId, event: 'start', claim_token: claim.claim_token });
  return claim;
}

export function postCard(h: TestHarness, input: Record<string, unknown>) {
  return h.ctx.services.cards.post(cardPostSchema.parse(input) as CardPostInput, testCtx()).card;
}

export function seedCardTask(h: TestHarness, channel = CHANNEL): string {
  return createTask(h, { channel, submit: false, title: '承载卡片的测试任务' }).id;
}

/** 用同一套 repos 装配一个 maxDepth 更小的实例，专门验证深度上限分支。 */
export function shallowDepthService(h: TestHarness, maxDepth: number): TaskService {
  return new TaskService({
    db: h.db,
    tasks: h.ctx.repos.tasks,
    cards: h.ctx.repos.cards,
    harnesses: h.ctx.repos.harnesses,
    events: h.ctx.repos.events,
    channels: h.ctx.services.channels,
    audit: h.ctx.services.audit,
    clock: h.clock,
    leaseSeconds: 900,
    maxDepth,
  });
}
