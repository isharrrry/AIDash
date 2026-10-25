/**
 * 通道在线判定 + 任务暂缓徽标的真机验证（CDP，只读）。
 *
 * 验证目标（对应用户反馈）：
 * 1. MCP 有调用时，通道树显示“在线”；
 * 2. 之后分钟级不调 MCP（页面只走 REST 轮询），同一通道自动变“已停止”，
 *    且它的“N 待处理”计数仍然大于 0——证明在线与未结束任务数已解耦；
 * 3. 任务树里遗留的 pending 任务显示“已暂缓”徽标，而不是看起来没人管。
 *
 * 为什么等待 185 秒：服务端阈值默认 180 秒，必须跨过阈值才算真机验证，
 * 不能只断言字段存在。
 *
 * 调用方：开发者手动 `node` 执行，不被应用代码 import。
 * 影响范围：只读 DOM；令牌只从 AIDASH_TOKEN 环境变量读，写进页面 localStorage 供页面自身鉴权，不打印。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CDP = 'http://127.0.0.1:9222';
const BASE = 'http://127.0.0.1:8787';
const OUT = fileURLToPath(new URL('../../backups/ui-presence-defer', import.meta.url));
const PROJECT = 'aidash';
const WAIT_MS = 185_000;

const token = process.env.AIDASH_TOKEN;
if (!token) throw new Error('AIDASH_TOKEN is not set');

mkdirSync(OUT, { recursive: true });

let socket;
let sequence = 0;
const waiting = new Map();
const problems = [];

async function openPage(url) {
  const response = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`打开页面失败：HTTP ${response.status}`);
  const page = await response.json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(`${message.error.code} ${message.error.message}`));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      problems.push(message.params.exceptionDetails?.text ?? 'Runtime exception');
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      problems.push(message.params.entry.text);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

async function waitFor(expression, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await evaluate(`Boolean(${expression})`).catch(() => false);
    if (ready) return;
    await sleep(100);
  }
  throw new Error(`等待超时（${label}）：${expression}`);
}

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
}

async function openChannelTree() {
  const open = await evaluate(`Boolean(document.querySelector('.channel-tree-panel'))`);
  if (!open) {
    await evaluate(`document.querySelector('.channel-tree-trigger').click()`);
    await waitFor(`document.querySelector('.channel-tree-panel')`, '通道树面板');
  }
}

async function readGroup() {
  return evaluate(`(() => {
    const groups = [...document.querySelectorAll('.channel-tree-group')];
    const group = groups.find((node) => {
      const head = node.querySelector('.channel-tree-project');
      return head && head.innerText.includes(${JSON.stringify(PROJECT)});
    });
    if (!group) return null;
    const head = group.querySelector('.channel-tree-project');
    return {
      text: head.innerText,
      online: Boolean(head.querySelector('.spinner')),
      stopped: head.innerText.includes('已停止'),
      openTasks: (head.innerText.match(/(\\d+)\\s*待处理/) ?? [])[1] ?? null,
      channelRows: [...group.querySelectorAll('.channel-tree-row')].map((row) => row.innerText),
    };
  })()`);
}

async function readDeferBadges() {
  return evaluate(`(() => {
    const badges = [...document.querySelectorAll('.task-row .defer-badge')];
    return {
      count: badges.length,
      samples: badges.slice(0, 3).map((node) => ({
        badge: node.innerText,
        title: node.getAttribute('title'),
        row: node.closest('.task-row')?.innerText ?? null,
      })),
      headers: [...document.querySelectorAll('.task-table-head > span')].map((n) => n.innerText),
    };
  })()`);
}

const result = {};

try {
  await openPage(`${BASE}/#/tasks`);
  // 页面用 localStorage 里的令牌鉴权；先写入再刷新，避免首次加载的 401。
  await evaluate(`localStorage.setItem('aidash.token', ${JSON.stringify(token)})`);
  await send('Page.reload');
  await sleep(600);
  await waitFor(`document.querySelector('.channel-tree-trigger')`, '页面框架');

  await openChannelTree();
  await waitFor(
    `[...document.querySelectorAll('.channel-tree-project')].some((n) => n.innerText.includes(${JSON.stringify(PROJECT)}))`,
    '主对话分组',
  );

  result.phase1 = await readGroup();
  await screenshot('01-online');

  // 选中该通道，让任务树只渲染这一个看板，便于统计暂缓徽标。
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.channel-tree-item')]
      .find((node) => node.innerText.includes('devhost/aidash/ux-refactor'));
    item?.click();
  })()`);
  await waitFor(`document.querySelector('.task-row')`, '任务行');
  result.defer = await readDeferBadges();
  await screenshot('02-deferred');

  // 关键等待：期间脚本只做 DOM 读取，页面只用 REST 轮询，不会刷新 last_mcp_at。
  await sleep(WAIT_MS);

  await openChannelTree();
  result.phase2 = await readGroup();
  await screenshot('03-stopped');

  writeFileSync(`${OUT}/result.json`, JSON.stringify({ result, problems }, null, 2));

  const checks = {
    onlineBefore: result.phase1?.online === true,
    openTasksBefore: Number(result.phase1?.openTasks ?? 0) > 0,
    stoppedAfter: result.phase2?.stopped === true && result.phase2?.online === false,
    openTasksStillPositive: Number(result.phase2?.openTasks ?? 0) > 0,
    deferBadges: Number(result.defer?.count ?? 0) >= 6,
    deferBadgeHasReason: (result.defer?.samples ?? []).every((s) => (s.title ?? '').includes('暂缓原因')),
    noRuntimeProblems: problems.length === 0,
  };
  console.log(JSON.stringify({ checks, result, problems }, null, 2));
  if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
} finally {
  socket?.close();
}
