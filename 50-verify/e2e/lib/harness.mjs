/**
 * E2E 生命周期：临时工作区 → 起服务 → 起浏览器 → 造数据 → 跑用例 → 全清。
 *
 * 设计原则（为什么这样写）：
 * 1. **绝不碰真实数据库。** 服务端支持 `AIDASH_DB_PATH`，这里把它指到 `os.tmpdir()`
 *    下的一次性目录。跑完连目录一起删。这样 E2E 可以随便发卡、提交决策，
 *    不会污染用户自己的看板。
 * 2. **绝不碰真实密钥。** `AIDASH_SECRET_DIR` 同样指到临时目录，否则页面上的
 *    「测试连接」之类操作会读写 `~/.aidash/secrets.json`。
 * 3. **绝不读用户配置。** `AIDASH_CONFIG` 指到一个不存在的路径：服务端默认会读
 *    仓库根的 `aidash.config.json`，那份文件属于使用者，E2E 不该受它影响。
 * 4. **关掉增强。** `AIDASH_ENRICHMENT_ENABLED=false`，避免 E2E 真的去调外部 LLM。
 * 5. **端口动态分配。** 固定 8787/9222 会和用户正在跑的服务撞车，
 *    这里用 `listen(0)` 让内核分配空闲端口。
 *
 * 影响范围：只被 E2E 入口 import；不修改服务端代码与真实数据。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** 本文件在 50-verify/e2e/lib/，向上三级是仓库根。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SERVER_ENTRY = path.join(REPO_ROOT, '40-build', '10-aidash', 'dist', 'server', 'main.js');
const STATIC_DIR = path.join(REPO_ROOT, '40-build', '10-aidash', 'dist', 'web');

/** Edge 的常见安装位置。允许用环境变量覆盖，方便换机器或换通道版本。 */
const EDGE_CANDIDATES = [
  process.env.AIDASH_EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 用例造数据用的通道。刻意用一个不可能与真实业务重名的值。 */
export const E2E_CHANNEL = 'e2e/smoke';

export function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    '找不到 Edge。请设置 AIDASH_EDGE_PATH 指向 msedge.exe，或安装 Edge。',
  );
}

/**
 * 让内核分配一个空闲端口。
 *
 * 注意：close 到真正使用之间有极小的窗口会被别的进程抢走。E2E 场景可接受；
 * 若真撞上，表现为服务端 EADDRINUSE，日志里能一眼看出来。
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 构建产物检查：没有 dist 时给出可执行的下一步，而不是让进程崩在 require 上。 */
export function assertBuildExists() {
  const missing = [SERVER_ENTRY, path.join(STATIC_DIR, 'index.html')].filter(
    (file) => !fs.existsSync(file),
  );
  if (missing.length > 0) {
    throw new Error(
      `缺少构建产物，先执行：pnpm -C 40-build build && pnpm -C 40-build web:build\n` +
        `缺失：${missing.join('、')}`,
    );
  }
}

/** 建一次性工作区：库、备份、密钥、浏览器 profile 全在这里。 */
export function createWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-e2e-'));
  const workspace = {
    dir,
    dbPath: path.join(dir, 'aidash.db'),
    backupDir: path.join(dir, 'backups'),
    secretDir: path.join(dir, 'secrets'),
    edgeProfile: path.join(dir, 'edge-profile'),
  };
  for (const sub of [workspace.backupDir, workspace.secretDir, workspace.edgeProfile]) {
    fs.mkdirSync(sub, { recursive: true });
  }
  return workspace;
}

/**
 * 起服务端进程并等 `/healthz` 通过。
 *
 * 用 `node dist/server/main.js` 而不是 `pnpm start`：
 * pnpm 会多一层进程，kill 的时候容易留下孤儿 node 占着端口。
 */
export async function startServer(workspace, { token, port }) {
  const env = {
    ...process.env,
    AIDASH_TOKEN: token,
    AIDASH_HOST: '127.0.0.1',
    AIDASH_PORT: String(port),
    AIDASH_DB_PATH: workspace.dbPath,
    AIDASH_BACKUP_DIR: workspace.backupDir,
    AIDASH_SECRET_DIR: workspace.secretDir,
    AIDASH_STATIC_DIR: STATIC_DIR,
    // 指向一个不存在的路径：隔离用户自己的 aidash.config.json。
    AIDASH_CONFIG: path.join(workspace.dir, 'no-such-config.json'),
    // 临时目录里没有旧库也没有备份，允许建空库（这是 E2E 的正常起点）。
    AIDASH_ALLOW_EMPTY_DB: 'true',
    AIDASH_ENRICHMENT_ENABLED: 'false',
    AIDASH_LOG_LEVEL: 'warn',
    // 放宽限流：一个 server 要连着跑完 6 个用例，节奏比真人快一个数量级
    // （真人按秒点，E2E 按毫秒点），默认的 60/分钟 + 突发 20 会被这套加速操作打满，
    // 于是失败信息全是 429、掩盖掉真正要测的 UI 问题。
    // 限流本身由 tests/http-routes.test.ts 专门覆盖，E2E 不该重复测它。
    AIDASH_RATE_LIMIT_PER_MINUTE: '100000',
    AIDASH_RATE_LIMIT_BURST: '10000',
  };

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `服务端启动即退出（code=${exited.code}, signal=${exited.signal}）：\n${output.join('')}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return { child, baseUrl, output };
    } catch {
      // 端口还没监听，继续等。
    }
    await sleep(200);
  }
  child.kill();
  throw new Error(`服务端 30 秒内未通过健康检查：\n${output.join('')}`);
}

/** 起 Edge 无头实例并等 DevTools 端点就绪。 */
export async function startEdge(workspace, { port }) {
  const executable = findEdge();
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${workspace.edgeProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    // 关掉后台联网，避免无头浏览器偷偷发遥测、拖慢启动。
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1440,900',
    'about:blank',
  ];

  const child = spawn(executable, args, {
    stdio: 'ignore',
    windowsHide: true,
  });

  const devtoolsBase = `http://127.0.0.1:${port}`;
  return { child, devtoolsBase, executable, args };
}

/**
 * 按 PID 杀整棵进程树。
 *
 * Windows 上 Edge 会派生多个子进程，只 kill 父进程会留下僵尸占着 profile 目录，
 * 下一次 E2E 就删不掉临时目录。taskkill /T 是唯一可靠的写法。
 */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  child.kill('SIGTERM');
}

/** 带 Bearer 的 REST 调用。令牌只进请求头，不进 URL、不进日志。 */
async function api(baseUrl, token, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    throw new Error(
      `造数据失败 ${method} ${route} → HTTP ${response.status}：${typeof payload === 'string' ? payload : JSON.stringify(payload)}`,
    );
  }
  return payload?.data ?? payload;
}

/**
 * 通过正式 REST 接口造测试数据。
 *
 * 为什么不直接写 SQLite：
 * 直接插库会绕过 service 层，造出来的数据可能违反业务不变量（比如任务缺事件行、
 * 卡片缺未读计数），用例就会在一个「现实中不存在」的状态上跑，通过也没意义。
 */
export async function seed(baseUrl, token) {
  const channelKey = E2E_CHANNEL;
  const suffix = randomUUID().slice(0, 8);

  await api(baseUrl, token, 'POST', '/api/channels', {
    channel_key: channelKey,
    title: 'E2E 冒烟通道',
    alias: 'E2E 通道别名',
  });

  // REST 的 data 形状是服务层的返回值 { task, created } / { card, created }，
  // 不是直接把实体摊平；这里显式取 .task / .card，避免把包装层当成实体用。
  const createdTask = await api(baseUrl, token, 'POST', '/api/tasks', {
    channel_key: channelKey,
    title: `E2E 冒烟任务 ${suffix}`,
    description_md: '由 E2E harness 通过 REST 创建，跑完随临时库一起删除。',
    submit: true,
  });
  const task = createdTask.task;

  const createdInfo = await api(baseUrl, token, 'POST', '/api/cards', {
    channel_key: channelKey,
    type: 'info',
    task_id: task.id,
    title: `E2E 冒烟卡片 ${suffix}`,
    body_md: '这张卡用来验证决策台列表与卡片抽屉能否正确渲染。',
    severity: 'info',
  });
  const infoCard = createdInfo.card;

  const createdQuestion = await api(baseUrl, token, 'POST', '/api/cards', {
    channel_key: channelKey,
    type: 'question',
    title: `E2E 待决策问题 ${suffix}`,
    background_md: '验证决策台上会显示待回答的问题卡。',
    // question 的三段式正文是硬性必填（goal / research / decision）：
    // 缺了它们，用户在看板上只看到两个选项却不知道在选什么。E2E 也要按真实形状造数据。
    goal_md: '确认决策台能正确渲染一张待拍板的问题卡。',
    research_md: '无需外部调查：这是自动化测试构造的固定样例。',
    decision_md: '在两个无实际差别的选项里选一个，仅用于验证交互链路。',
    options: [
      {
        id: 'a',
        label: '选项 A',
        pros_md: '简单',
        cons_md: '无明显缺点',
        recommendation_role: 'primary',
      },
      {
        id: 'b',
        label: '选项 B',
        pros_md: '更稳',
        cons_md: '更慢',
        recommendation_role: 'backup',
      },
    ],
  });
  const questionCard = createdQuestion.card;

  return {
    channelKey,
    suffix,
    taskId: task.id,
    infoCardId: infoCard.id,
    questionCardId: questionCard.id,
    infoCardTitle: `E2E 冒烟卡片 ${suffix}`,
    questionCardTitle: `E2E 待决策问题 ${suffix}`,
    taskTitle: `E2E 冒烟任务 ${suffix}`,
  };
}

/** 尽力清理：先杀进程，再删目录。删不掉不算失败（Windows 偶发占用）。 */
export async function cleanup({ server, edge, workspace, keep }) {
  killTree(server?.child);
  killTree(edge?.child);
  // 等进程真正退出再删，否则 Windows 会报 EBUSY。
  await sleep(300);
  if (!workspace) return;
  if (keep) {
    console.log(`[e2e] 保留临时目录：${workspace.dir}`);
    return;
  }
  try {
    fs.rmSync(workspace.dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[e2e] 临时目录删除失败（不影响结果）：${error.message}`);
  }
}
