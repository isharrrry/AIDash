/**
 * E2E 入口：一条命令跑完所有视图用例。
 *
 * 用法：
 *   node 50-verify/e2e/run.mjs
 *   pnpm -C 40-build e2e
 *
 * 退出码：
 *   0 = 全部通过
 *   1 = 有失败（含环境问题：缺 Edge、缺构建产物、服务起不来）
 *
 * 环境变量：
 *   AIDASH_EDGE_PATH              指定 msedge.exe（默认查两个常见安装路径）
 *   AIDASH_E2E_KEEP=1             保留临时目录，排查失败时用
 *   AIDASH_E2E_ALLOW_CONSOLE=1    不把页面控制台报错判为失败（默认严格，建议只临时用）
 *
 * 为什么把「控制台报错」当失败：
 * 页面可能“看起来渲染了”却在后台一直抛异常（比如某个轮询接口 500），
 * 这类问题只有控制台能暴露，而它恰好是 UI 回归最容易漏掉的一类。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CASES } from './cases.mjs';
import {
  assertBuildExists,
  cleanup,
  createWorkspace,
  freePort,
  seed,
  startEdge,
  startServer,
} from './lib/harness.mjs';
import { newPage, waitForDevtools } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = path.join(HERE, 'artifacts');
const CASE_TIMEOUT_MS = 30_000;
const ALLOW_CONSOLE = process.env.AIDASH_E2E_ALLOW_CONSOLE === '1';

/** 每个用例的超时保护：卡住时必须失败，否则本地跑就会一直挂着等人 Ctrl+C。 */
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`用例超时（${timeoutMs}ms）：${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function writeArtifact(stamp, caseName, base64) {
  const dir = path.join(ARTIFACT_ROOT, stamp);
  fs.mkdirSync(dir, { recursive: true });
  // 用例名里有中文与标点，落盘前换成安全的短横线形式。
  const safe = caseName.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const file = path.join(dir, `${safe || 'case'}.png`);
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  return file;
}

async function main() {
  assertBuildExists();

  const workspace = createWorkspace();
  // 一次性令牌：本次进程内有效，跑完随库一起消失。不读、不打印真实令牌。
  const token = `e2e-${randomUUID()}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  let server;
  let edge;
  let client;
  const results = [];

  try {
    const serverPort = await freePort();
    server = await startServer(workspace, { token, port: serverPort });
    console.log(`[e2e] 服务已就绪：${server.baseUrl}（临时库 ${workspace.dbPath}）`);

    const data = await seed(server.baseUrl, token);
    console.log(`[e2e] 造数据完成：通道 ${data.channelKey}，任务 1 个，卡片 2 张`);

    const devtoolsPort = await freePort();
    edge = await startEdge(workspace, { port: devtoolsPort });
    await waitForDevtools(edge.devtoolsBase);
    console.log(`[e2e] 浏览器已就绪：${edge.devtoolsBase}`);

    client = await newPage(edge.devtoolsBase, `${server.baseUrl}/`);

    // 先导航到同源页面再写 localStorage：about:blank 的 origin 是 opaque，
    // 在那里写 localStorage 会抛 SecurityError。
    await client.navigate(`${server.baseUrl}/`);
    await client.evaluate(`window.localStorage.setItem('aidash.token', ${JSON.stringify(token)})`);
    // 必须真的整页重载，不能改成 navigate 到 /#/：
    // 同文档只变 hash 不会重跑 JS，App 的初始 useState 已经拿过 null 了。
    await client.reload();

    for (const testCase of CASES) {
      const startedAt = Date.now();
      try {
        await withTimeout(
          testCase.run({ client, baseUrl: server.baseUrl, token, data }),
          CASE_TIMEOUT_MS,
          testCase.name,
        );
        const consoleErrors = client.consoleErrors;
        if (consoleErrors.length > 0 && !ALLOW_CONSOLE) {
          throw new Error(
            `页面控制台有 ${consoleErrors.length} 条报错：\n- ${consoleErrors.join('\n- ')}`,
          );
        }
        results.push({ name: testCase.name, ok: true, ms: Date.now() - startedAt });
        console.log(`[e2e] 通过  ${testCase.name}（${Date.now() - startedAt}ms）`);
      } catch (error) {
        let artifact = null;
        try {
          artifact = writeArtifact(stamp, testCase.name, await client.screenshotBase64());
        } catch {
          // 截图失败不能掩盖原始失败原因，忽略即可。
        }
        results.push({
          name: testCase.name,
          ok: false,
          ms: Date.now() - startedAt,
          error: error.message,
          artifact,
        });
        console.error(`[e2e] 失败  ${testCase.name}：${error.message}`);
        if (artifact) console.error(`[e2e]       截图：${artifact}`);
      }
    }
  } finally {
    // 无论成败都要关：否则下一次运行会和残留进程抢端口。
    // 顺序：先断 CDP（释放 WebSocket 句柄），再杀进程、删目录。
    client?.disconnect();
    await cleanup({
      server,
      edge,
      workspace,
      keep: process.env.AIDASH_E2E_KEEP === '1',
    });
  }

  const passed = results.filter((item) => item.ok).length;
  const failed = results.length - passed;
  console.log('');
  console.log(`[e2e] 合计 ${results.length} 条：通过 ${passed}，失败 ${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(`[e2e] 运行器异常：${error.stack ?? error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // 显式退出：子进程（浏览器/服务端）即使已经 kill，Node 也可能因为
    // 残留句柄迟迟不退出。E2E 是一次性进程，跑完就退，不必等事件循环自然清空。
    process.exit(process.exitCode ?? 0);
  });
