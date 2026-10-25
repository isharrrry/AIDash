import { afterEach, describe, expect, it } from 'vitest';
import { AssistantMemoryRepo } from '../src/server/repos/assistant-memory-repo.js';
import { MemoryRepo } from '../src/server/repos/memory-repo.js';
import { startFakeLlm, type FakeLlm } from './fakes/fake-llm.js';
import { createHarness, testCtx, type TestHarness } from './helpers.js';

/**
 * P2 #19 重构前的行为快照。
 *
 * 这些断言刻意只碰“现有公开行为”与两个版本化仓储的直接契约：
 * - 之后抽出的 BatchRunner / MaterialRepo / 共享版本写入必须让本文件原样通过；
 * - 用例不引用新内部类，避免把“重构实现”当成需求本身。
 */

const harnesses: TestHarness[] = [];
const fakes: FakeLlm[] = [];

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  for (const harness of harnesses.splice(0)) harness.close();
});

function boot(): TestHarness {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
}

async function newFake(): Promise<FakeLlm> {
  const fake = await startFakeLlm('# 本期结论\n\n- 完成 3 项');
  fakes.push(fake);
  return fake;
}

function configureLlm(h: TestHarness, fake: FakeLlm): void {
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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('版本化仓储回归契约', () => {
  it('project_memory：expected_version=0 创建、过期写入返回实际版本、正确版本递增', () => {
    const h = boot();
    const repo = new MemoryRepo(h.db);
    const now = h.clock.now();

    expect(repo.get('devhost/contract')).toBeUndefined();

    const created = repo.upsert('devhost/contract', '- 第一版', 0, 'tester', now);
    expect(created).toMatchObject({ ok: true, actualVersion: 1 });
    expect(created.memory).toMatchObject({
      project: 'devhost/contract',
      content_md: '- 第一版',
      version: 1,
      updated_by: 'tester',
    });

    // 两个终端都以为“还没有记忆”：后写入者必须失败，且拿得到实际版本去合并。
    const staleCreate = repo.upsert('devhost/contract', '- 覆盖', 0, 'other', now + 1);
    expect(staleCreate).toMatchObject({ ok: false, actualVersion: 1 });
    expect(staleCreate.memory?.content_md).toBe('- 第一版');

    const updated = repo.upsert('devhost/contract', '- 第二版', 1, 'tester', now + 2);
    expect(updated).toMatchObject({ ok: true, actualVersion: 2 });

    const staleUpdate = repo.upsert('devhost/contract', '- 旧版本覆盖', 1, 'other', now + 3);
    expect(staleUpdate).toMatchObject({ ok: false, actualVersion: 2 });
    expect(repo.get('devhost/contract')?.content_md).toBe('- 第二版');
  });

  it('assistant_memory：单行表同样按 expected_version 做乐观锁', () => {
    const h = boot();
    const repo = new AssistantMemoryRepo(h.db);
    const now = h.clock.now();

    expect(repo.get()).toBeUndefined();

    const created = repo.upsert('- 长期经验', 0, 'assistant-memory', now);
    expect(created).toMatchObject({ ok: true, actualVersion: 1 });
    expect(created.memory).toMatchObject({
      content_md: '- 长期经验',
      version: 1,
      updated_by: 'assistant-memory',
    });

    const staleCreate = repo.upsert('- 覆盖', 0, 'other', now + 1);
    expect(staleCreate).toMatchObject({ ok: false, actualVersion: 1 });
    expect(staleCreate.memory?.content_md).toBe('- 长期经验');

    const updated = repo.upsert('- 长期经验\n- 新增经验', 1, 'assistant-memory', now + 2);
    expect(updated).toMatchObject({ ok: true, actualVersion: 2 });

    const staleUpdate = repo.upsert('- 退回过期版本', 1, 'other', now + 3);
    expect(staleUpdate).toMatchObject({ ok: false, actualVersion: 2 });
    expect(repo.get()?.version).toBe(2);
  });
});

describe('汇报批次回归契约', () => {
  it('成功批次：done/6 条 ready，并只留一条成功审计', async () => {
    const fake = await newFake();
    const h = boot();
    configureLlm(h, fake);

    const run = h.ctx.services.reports.startPeriodUpdate(testCtx());
    await waitFor(() => h.ctx.services.reports.status().running === null);

    expect(h.ctx.repos.reports.getRun(run.id)).toMatchObject({
      status: 'done',
      total: 6,
      completed: 6,
      cancel_requested: 0,
      error_message: null,
    });
    const reports = h.ctx.services.reports.list({ kind: 'period', page_size: 20 });
    expect(reports.total).toBe(6);
    expect(reports.items.every((report) => report.status === 'ready')).toBe(true);

    const audits = h.db
      .prepare(
        `SELECT action, result, object_type, object_id, detail_json
           FROM audit_log
          WHERE action = 'report.update' AND object_id = ?
          ORDER BY id`,
      )
      .all(run.id) as Array<{
      action: string;
      result: string;
      object_type: string;
      object_id: string;
      detail_json: string;
    }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'report.update',
      result: 'ok',
      object_type: 'report_run',
      object_id: run.id,
    });
    expect(JSON.parse(audits[0]!.detail_json)).toMatchObject({ completed: 6, total: 6 });
  });

  it('取消批次：cancelled/只标记当前一条，并保留取消与阶段完成两条审计', async () => {
    const fake = await newFake();
    fake.setFault({ kind: 'hang' });
    const h = boot();
    configureLlm(h, fake);

    const run = h.ctx.services.reports.startPeriodUpdate(testCtx());
    await waitFor(() => fake.requests.length === 1);
    h.ctx.services.reports.cancel(run.id, testCtx());
    await waitFor(() => h.ctx.services.reports.status().running === null);

    expect(h.ctx.repos.reports.getRun(run.id)).toMatchObject({
      status: 'cancelled',
      completed: 0,
      cancel_requested: 1,
      error_message: null,
    });
    const reports = h.ctx.services.reports.list({ kind: 'period', page_size: 20 });
    expect(reports.total).toBe(1);
    expect(reports.items[0]).toMatchObject({ period: 'day', status: 'cancelled' });

    const audits = h.db
      .prepare(
        `SELECT action, result, object_type, object_id, detail_json
           FROM audit_log
          WHERE action = 'report.cancel' AND object_id = ?
          ORDER BY id`,
      )
      .all(run.id) as Array<{
      action: string;
      result: string;
      object_type: string;
      object_id: string;
      detail_json: string;
    }>;
    expect(audits.map((row) => row.result)).toEqual(['ok', 'ok']);
    const details = audits.map(
      (row) => JSON.parse(row.detail_json) as Record<string, unknown>,
    );
    expect(details).toContainEqual({ completed: 0, total: 6 });
    expect(details).toContainEqual({ stage: 'finished' });
  });
});
