import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';

import { AppError } from '../../src/shared/errors.js';
import {
  cardPostSchema,
  memoryAppendSchema,
  taskCreateSchema,
} from '../../src/shared/schemas.js';
import type { CardPostInput } from '../../src/server/services/card-service.js';
import { startFakeLlm, type FakeLlm } from './fake-llm.js';
import { createHarness, questionPayload, testCtx, type TestHarness } from '../helpers.js';

/**
 * memory-settings-branches 拆分后的共享夹具。
 *
 * 每个测试文件在独立 worker 里运行，因此模块级数组只覆盖本文件；
 * cleanupFixtures 仍由具体文件在 afterEach 中调用，避免夹具模块隐式注册钩子。
 */

const harnesses: TestHarness[] = [];
/** 用例需要提前关闭某个假模型时，可从清理队列里摘掉它（避免 afterEach 再关一次）。 */
export const fakes: FakeLlm[] = [];
const tempDirs: string[] = [];

export function boot(overrides: Parameters<typeof createHarness>[0] = {}): TestHarness {
  const h = createHarness(overrides);
  harnesses.push(h);
  return h;
}

export async function newFake(content?: string): Promise<FakeLlm> {
  const fake = await startFakeLlm(content);
  fakes.push(fake);
  return fake;
}

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupFixtures(): Promise<void> {
  for (const fake of fakes.splice(0)) await fake.close();
  for (const h of harnesses.splice(0)) h.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** 同步路径捕获 AppError；没抛就失败，避免“居然成功了”被静默放过。 */
export function captureAppError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('期望抛出 AppError，但调用成功了');
}

export async function captureRejection(run: Promise<unknown>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('期望这次调用失败，但它成功了');
}

export function configureLlm(h: TestHarness, fake: FakeLlm, timeoutMs?: number): void {
  h.ctx.services.settings.update(
    {
      llm_endpoint: fake.base,
      llm_model: 'deepseek-flash',
      llm_mode: 'max',
      llm_api_key: 'sk-page-key',
      ...(timeoutMs === undefined ? {} : { enrichment_timeout_ms: timeoutMs }),
    },
    testCtx(),
  );
}

export function postCard(h: TestHarness, input: Record<string, unknown>) {
  return h.ctx.services.cards.post(cardPostSchema.parse(input) as CardPostInput, testCtx());
}

export function postQuestion(h: TestHarness, channelKey: string) {
  return postCard(h, { ...questionPayload({ channel_key: channelKey }), type: 'question' }).card;
}

export function seedDigestTasks(h: TestHarness, channelKey: string, count = 3): void {
  for (let index = 0; index < count; index += 1) {
    h.ctx.services.tasks.create(
      taskCreateSchema.parse({
        channel_key: channelKey,
        title: `素材任务-${index}`,
        description_md: `素材描述-${index}`,
      }),
      testCtx(),
    );
  }
}

export function seedMemory(h: TestHarness, project: string, line = '- [seed] 已有约束'): void {
  h.ctx.services.memory.append(
    memoryAppendSchema.parse({ project, lines: [line] }),
    testCtx(),
  );
}

/** runScheduled 是私有方法；测试直接驱动它，比等 60 秒启动定时器更可控。 */
export function runScheduledNow(h: TestHarness): Promise<void> {
  return (
    h.ctx.services.memoryDigest as unknown as { runScheduled: () => Promise<void> }
  ).runScheduled();
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('条件在超时前未满足');
}

export function insertReadyReport(h: TestHarness, runId: string, content: string | null = '汇报正文'): void {
  const now = h.clock.now();
  const id = `rp_${Math.random().toString(36).slice(2)}`;
  h.db
    .prepare(
      `INSERT INTO report
       (id, kind, period, period_key, title, content_md, status, run_id,
        source_count, generated_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, 'topic', 'topic', id, '学习素材汇报', content, 'ready', runId, 1, now, now, now);
}

export function auditResults(h: TestHarness, action: string, objectId?: string): string[] {
  const rows = (
    objectId === undefined
      ? h.db.prepare('SELECT result FROM audit_log WHERE action = ? ORDER BY id').all(action)
      : h.db
          .prepare('SELECT result FROM audit_log WHERE action = ? AND object_id = ? ORDER BY id')
          .all(action, objectId)
  ) as Array<{ result: string }>;
  return rows.map((row) => row.result);
}
