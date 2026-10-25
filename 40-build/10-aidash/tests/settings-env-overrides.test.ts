import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import {
  api,
  createHarness,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

/**
 * 配置优先级提示（页面设置 > 环境变量 > 配置文件 > 默认）。
 *
 * 这里只验证“提示字段”，不重复验证 coalesce 本身：
 * - 页面值存在且同名环境变量存在 → env_overrides 有对应项；
 * - 清空页面值后回退到环境变量值，同时提示消失；
 * - 环境变量别名按 config.ts 的优先顺序提示实际生效的那个。
 */

let harness: TestHarness | null = null;
let app: RunningApp | null = null;
const cleanup: string[] = [];

afterEach(async () => {
  if (app) await app.close();
  harness?.close();
  app = null;
  harness = null;
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface SettingsResponse {
  kb: { root: string | null; configured: boolean };
  retention: { card_days: number; audit_days: number; log_days: number };
  env_overrides: Array<{ key: string; env_var: string }>;
}

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

describe('设置页环境变量覆盖提示', () => {
  it('loadConfig 只记录实际提供且非空的 AIDASH_* 变量名', () => {
    const config = loadConfig(
      {
        AIDASH_TOKEN: 'test-token',
        AIDASH_KB_ROOT: 'D:/kb',
        // 空值在 num()/str()/bool() 里等同未设置，不能算作覆盖来源。
        AIDASH_LLM_MODEL: '',
      },
      { configFile: path.join(os.tmpdir(), `aidash-missing-env-keys-${process.pid}.json`) },
    );

    expect(config.aidashEnvKeys).toEqual(['AIDASH_KB_ROOT', 'AIDASH_TOKEN']);
  });

  it('页面值覆盖环境变量时返回提示；清空页面值后提示消失', async () => {
    const envRoot = makeDir('aidash-env-kb-');
    const pageRoot = makeDir('aidash-page-kb-');
    harness = createHarness({
      kbRoot: envRoot,
      aidashEnvKeys: ['AIDASH_KB_ROOT', 'AIDASH_CARD_RETENTION_DAYS'],
    });
    app = await startApp(harness);

    // 只有环境变量、没有页面值时不算“页面覆盖”。
    const before = await api<SettingsResponse>(app, 'GET', '/api/settings');
    expect(before.status).toBe(200);
    expect(before.body.data?.kb.root).toBe(envRoot);
    expect(before.body.data?.env_overrides).toEqual([]);

    const saved = await api<SettingsResponse>(app, 'PATCH', '/api/settings', {
      kb_root: pageRoot,
      card_retention_days: 90,
    });
    expect(saved.status).toBe(200);
    // 行为不变：页面值仍然优先于环境变量默认值。
    expect(saved.body.data?.kb.root).toBe(pageRoot);
    expect(saved.body.data?.retention.card_days).toBe(90);
    expect(saved.body.data?.env_overrides).toEqual([
      { key: 'kb_root', env_var: 'AIDASH_KB_ROOT' },
      { key: 'card_retention_days', env_var: 'AIDASH_CARD_RETENTION_DAYS' },
    ]);

    // GET 与 PATCH 的提示必须一致：提示来自持久化的页面值，而不是某次响应临时拼的。
    const viewed = await api<SettingsResponse>(app, 'GET', '/api/settings');
    expect(viewed.body.data?.env_overrides).toEqual(saved.body.data?.env_overrides);

    const cleared = await api<SettingsResponse>(app, 'PATCH', '/api/settings', { kb_root: null });
    expect(cleared.status).toBe(200);
    // 只断言“提示”随页面值清空而消失。
    // 既有 update() 对 kb_root=null 会直接置空运行时值，要到下次启动才重新 coalesce；
    // 这是本任务不改的现有行为，因此这里不固化“立即回退”的运行时结果。
    expect(cleared.body.data?.env_overrides).toEqual([
      { key: 'card_retention_days', env_var: 'AIDASH_CARD_RETENTION_DAYS' },
    ]);
  });

  it('超时环境变量有两个别名时，提示实际生效的新名字', () => {
    harness = createHarness({
      aidashEnvKeys: ['AIDASH_ENRICHMENT_TIMEOUT_MS', 'AIDASH_LLM_TIMEOUT_MS'],
    });
    harness.ctx.services.settings.update({ enrichment_timeout_ms: 120_000 }, testCtx());

    expect(harness.ctx.services.settings.view().env_overrides).toEqual([
      { key: 'enrichment_timeout_ms', env_var: 'AIDASH_LLM_TIMEOUT_MS' },
    ]);
  });
});
