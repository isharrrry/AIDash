import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  createHarness,
  startApp,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

// 只由 vitest 收集：验证设置页新增的“知识库目录可编辑”链路。
// 根目录用操作系统临时目录，不碰真实 KB，也不写仓库文件。
let harness: TestHarness | null = null;
let app: RunningApp | null = null;
const cleanup: string[] = [];

async function boot(): Promise<{ h: TestHarness; a: RunningApp }> {
  harness = createHarness({ kbRoot: null });
  app = await startApp(harness);
  return { h: harness, a: app };
}

afterEach(async () => {
  if (app) await app.close();
  harness?.close();
  app = null;
  harness = null;
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeKbDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-kb-settings-'));
  cleanup.push(dir);
  fs.writeFileSync(
    path.join(dir, 'gateway.md'),
    [
      '---',
      'type: ops',
      'title: Gateway whitelist',
      'tags: [gateway, auth]',
      '---',
      '',
      '# Gateway whitelist',
      '',
      'The gateway whitelist must include 192.0.2.15 before login works.',
    ].join('\n'),
  );
  return dir;
}

describe('知识库配置：PATCH /api/settings', () => {
  it('根目录不存在或不是目录时明确拒绝', async () => {
    const { a } = await boot();

    const missing = path.join(os.tmpdir(), `aidash-kb-missing-${Date.now()}`);
    const notFound = await api(a, 'PATCH', '/api/settings', { kb_root: missing });
    expect(notFound.status).toBe(400);
    expect(notFound.body.error?.message).toBe('KB_ROOT_NOT_FOUND');

    const file = path.join(os.tmpdir(), `aidash-kb-file-${Date.now()}.md`);
    fs.writeFileSync(file, '# not a directory');
    cleanup.push(file);
    const notDir = await api(a, 'PATCH', '/api/settings', { kb_root: file });
    expect(notDir.status).toBe(400);
    expect(notDir.body.error?.message).toBe('KB_ROOT_NOT_DIRECTORY');
  });

  it('保存目录后立即可索引、可搜索；清空后回退未配置', async () => {
    const { a } = await boot();
    const dir = makeKbDir();

    const saved = await api<{ kb: { root: string | null; configured: boolean } }>(
      a,
      'PATCH',
      '/api/settings',
      { kb_root: dir },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data?.kb).toMatchObject({ root: dir, configured: true });

    // 不同请求之间不重启：KbService 通过 getter 读 runtime，保存即生效。
    const indexed = await api<{ indexed: number; scanned: number; errors: unknown[] }>(
      a,
      'POST',
      '/api/kb/reindex',
    );
    expect(indexed.status).toBe(200);
    expect(indexed.body.data?.scanned).toBe(1);
    expect(indexed.body.data?.indexed).toBe(1);
    expect(indexed.body.data?.errors).toHaveLength(0);

    const searched = await api<{
      total: number;
      items: Array<{ path: string; title: string | null }>;
    }>(a, 'GET', '/api/kb/search?q=whitelist');
    expect(searched.body.data?.total).toBeGreaterThan(0);
    expect(searched.body.data?.items[0]?.path).toBe('gateway.md');

    const stats = await api<{ configured: boolean; root: string | null }>(
      a,
      'GET',
      '/api/kb/stats',
    );
    expect(stats.body.data).toMatchObject({ configured: true, root: dir });

    const cleared = await api<{ kb: { configured: boolean } }>(a, 'PATCH', '/api/settings', {
      kb_root: null,
    });
    expect(cleared.body.data?.kb.configured).toBe(false);

    // 清空后索引应明确报“未配置”，而不是静默扫 0 个文件。
    const rejected = await api(a, 'POST', '/api/kb/reindex');
    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.message).toBe('KB_NOT_CONFIGURED');
  });

  it('llm_api_key 允许页面写入，但只进加密文件且不回显', async () => {
    const { a, h } = await boot();
    const saved = await api<{
      enrichment: { llm: { has_api_key: boolean; configured: boolean; key_source: string | null } };
    }>(a, 'PATCH', '/api/settings', { llm_api_key: 'sk-test-page-key' });
    expect(saved.status).toBe(200);
    expect(saved.body.data?.enrichment.llm).toMatchObject({
      has_api_key: true,
      configured: true,
      key_source: 'file',
    });
    // 响应里绝不能出现明文 key；这是“页面可写”与“密钥不外泄”的分界。
    expect(saved.text).not.toContain('sk-test-page-key');

    const secretsFile = path.join(h.config.secretDir, 'secrets.json');
    const ciphertext = fs.readFileSync(secretsFile, 'utf8');
    expect(ciphertext).not.toContain('sk-test-page-key');

    // 再次读取设置页也不能回显：只能看到“已配置”。
    const viewed = await api(a, 'GET', '/api/settings');
    expect(viewed.text).not.toContain('sk-test-page-key');
  });
});
