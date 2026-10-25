import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackgroundWorker } from '../src/server/workers/background.js';
import { createHarness, type TestHarness } from './helpers.js';

/**
 * KB 索引的“生产路径”回归。
 *
 * 同步 `index()` 保留给既有调用与测试，但它会在大库上占住事件循环；
 * 生产实际走 `indexAsync()`（HTTP reindex + worker 定时）。这里不重复测
 * front matter 解析细节（已有用例覆盖），只锁定三条容易回退的契约：
 * 1. 异步与同步的统计/清理结果一致；
 * 2. AbortSignal 在关机时能真正中断，而不是“标记了却继续跑完”；
 * 3. 首轮索引必须由 listen 后的 `indexKb()` 触发，`start()` 不得抢跑。
 */

const harnesses: TestHarness[] = [];
const tempDirs: string[] = [];

function boot(overrides: Parameters<typeof createHarness>[0] = {}): TestHarness {
  const h = createHarness(overrides);
  harnesses.push(h);
  return h;
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  // 先停服务再删目录：索引中途被删根目录会产生无意义的 ENOENT 噪音。
  for (const h of harnesses.splice(0)) h.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('KB 异步分批索引', () => {
  it('与同步索引结果一致：跳过目录、超大文件、删除清理', async () => {
    const dir = tempDir('aidash-kb-async-');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'wiki'));
    fs.writeFileSync(path.join(dir, '.git', 'hidden.md'), '# 不该被索引\n');
    fs.writeFileSync(
      path.join(dir, 'wiki', 'a.md'),
      '---\ntype: runbook\ntags: [ops]\ndate: 2026-02-03\n---\n# A\n',
    );
    fs.writeFileSync(path.join(dir, 'b.md'), '# B\n');
    // 超过 2MB：收集阶段记错误，不进入待索引列表。
    fs.writeFileSync(path.join(dir, 'huge.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

    const h = boot({ kbRoot: dir });
    // batchSize=1 强制每篇都让出一次事件循环，把分批路径跑到。
    const report = await h.ctx.services.kb.indexAsync({ batchSize: 1 });
    expect(report).toMatchObject({ scanned: 2, indexed: 2, unchanged: 0, removed: 0 });
    expect(report.errors).toEqual([{ path: 'huge.md', message: 'file_too_large' }]);
    expect(h.ctx.services.kb.stats().docs).toBe(2);
    expect(h.ctx.services.kb.listDocs().items.map((doc) => doc.path).sort()).toEqual([
      'b.md',
      'wiki/a.md',
    ]);

    // 内容没变时不应重复写库。
    const second = await h.ctx.services.kb.indexAsync({ batchSize: 1 });
    expect(second.unchanged).toBe(2);

    // 磁盘上消失的文档要从索引里清掉，而不是一直留在搜索结果里。
    fs.rmSync(path.join(dir, 'b.md'));
    const third = await h.ctx.services.kb.indexAsync({ batchSize: 1 });
    expect(third.scanned).toBe(1);
    expect(third.removed).toBe(1);
    expect(h.ctx.services.kb.stats().docs).toBe(1);
  });

  it('已中止的信号在读取文件前就拒绝，且不影响后续索引', async () => {
    const dir = tempDir('aidash-kb-abort-');
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n');
    const h = boot({ kbRoot: dir });

    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    await expect(
      h.ctx.services.kb.indexAsync({ signal: controller.signal }),
    ).rejects.toThrow('shutdown');
    // 中止不是“部分成功”：一篇都不该写进去。
    expect(h.ctx.services.kb.stats().docs).toBe(0);

    // abort 只影响当次调用；关机中止后不重启进程也能继续手动重建。
    const report = await h.ctx.services.kb.indexAsync();
    expect(report.indexed).toBe(1);
  });

  it('索引进行中可从 stats 观察到，完成后保留最近一次摘要', async () => {
    const dir = tempDir('aidash-kb-status-');
    for (const name of ['a.md', 'b.md', 'c.md']) {
      fs.writeFileSync(path.join(dir, name), `# ${name}\n`);
    }
    const h = boot({ kbRoot: dir });
    expect(h.ctx.services.kb.stats()).toMatchObject({ indexing: false, last_index: null });

    const running = h.ctx.services.kb.indexAsync({ batchSize: 1 });
    // 在途计数在第一个 await 之前置位：文件还没读完，设置页就应该能显示“重建中”。
    expect(h.ctx.services.kb.stats().indexing).toBe(true);

    const report = await running;
    const stats = h.ctx.services.kb.stats();
    expect(stats.indexing).toBe(false);
    expect(stats.last_index).toMatchObject({
      scanned: report.scanned,
      indexed: report.indexed,
      unchanged: report.unchanged,
      removed: report.removed,
      error_count: report.errors.length,
    });
    expect(stats.last_index?.finished_at).toBe(h.clock.now());
  });

  it('未配置知识库时明确拒绝，而不是静默返回空报告', async () => {
    const h = boot({ kbRoot: null });
    await expect(h.ctx.services.kb.indexAsync()).rejects.toMatchObject({
      message: 'KB_NOT_CONFIGURED',
    });
  });
});

describe('后台 worker 的 KB 首轮索引', () => {
  it('start() 不隐式索引；indexKb() 触发并可用 waitForIdle() 等待', async () => {
    const dir = tempDir('aidash-kb-worker-');
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n');
    fs.writeFileSync(path.join(dir, 'b.md'), '# B\n');
    const h = boot({ kbRoot: dir });

    const worker = createBackgroundWorker(h.ctx, h.log);
    worker.start();
    try {
      // 首轮索引必须等 main.ts 在 listen 回调里调用 indexKb()：
      // 若 start() 抢跑，文档多的库会先卡住事件循环、端口迟迟不可用。
      expect(h.ctx.services.kb.stats().docs).toBe(0);

      worker.indexKb();
      await worker.waitForIdle();
      expect(h.ctx.services.kb.stats().docs).toBe(2);

      // 同一时刻只允许一个索引在途；串行触发不会叠出第二份写入。
      worker.indexKb();
      await worker.waitForIdle();
      expect(h.ctx.services.kb.stats().docs).toBe(2);
      expect(h.ctx.services.kb.listDocs().total).toBe(2);
    } finally {
      worker.stop();
      await worker.waitForIdle();
    }
  });

  it('未配置知识库时 indexKb() 直接跳过', async () => {
    const h = boot({ kbRoot: null });
    const worker = createBackgroundWorker(h.ctx, h.log);
    worker.start();
    try {
      worker.indexKb();
      await worker.waitForIdle();
      expect(h.ctx.services.kb.stats()).toMatchObject({ configured: false, docs: 0 });
    } finally {
      worker.stop();
      await worker.waitForIdle();
    }
  });
});
