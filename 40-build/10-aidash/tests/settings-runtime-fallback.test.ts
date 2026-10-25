import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, testCtx, type TestHarness } from './helpers';

const tempDirs: string[] = [];
let harness: TestHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * 页面清空设置后的运行时回退。
 *
 * 文档口径是“页面设置 > 环境变量/配置文件 > 默认值”：清空页面值等价于
 * 放弃这一层覆盖，必须立刻回退到下一层。旧实现只把 runtime 置 null，
 * 表现为“保存后立刻失效、重启后又恢复”，用户会以为保存没生效。
 */
describe('设置清空后的运行时回退', () => {
  it('清空页面值立即回退到配置文件值，不需要重启', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-settings-fallback-'));
    tempDirs.push(dir);
    harness = createHarness({
      kbRoot: dir,
      llm: {
        endpoint: 'http://127.0.0.1:9/v1',
        model: 'config-model',
        mode: 'fast',
        apiKey: null,
        timeoutMs: 60_000,
      },
    });
    const h = harness;

    // 先写页面值，确认页面层确实覆盖了配置层。
    h.ctx.services.settings.update(
      {
        kb_root: dir,
        llm_endpoint: 'http://127.0.0.1:8/v1',
        llm_model: 'page-model',
      },
      testCtx(),
    );
    expect(h.ctx.services.settings.current()).toMatchObject({
      kbRoot: dir,
      llmEndpoint: 'http://127.0.0.1:8/v1',
      llmModel: 'page-model',
    });

    // 清空页面值：必须同一进程内回退，而不是等重启。
    h.ctx.services.settings.update(
      { kb_root: null, llm_endpoint: null, llm_model: null },
      testCtx(),
    );
    expect(h.ctx.services.settings.current()).toMatchObject({
      kbRoot: dir,
      llmEndpoint: 'http://127.0.0.1:9/v1',
      llmModel: 'config-model',
    });
  });
});
