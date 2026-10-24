/**
 * Batch 1 任务树改造的真机验收脚本（Edge CDP，无第三方依赖）。
 *
 * 调用方：只由开发者用 `node` 直接执行，不被应用代码 import。
 * 影响范围：只读页面 DOM；唯一“写”操作是点开/关闭一张已答决策卡的模态框，
 *           不提交答案、不新建任务，因此不会改变数据库内容。
 *
 * 验证目标（对应用户原话）：
 *   1. 页面级标题合并进看板头部，不再有重复 h1；
 *   2. 统计里出现“进行中”，并有静态完成段 + 动态进行中段的进度条；
 *   3. 任务树有明确列名、层级连线、可收纳展开；
 *   4. 决策条目挂在任务行下，点开是模态框；
 *   5. 已结束父任务若有未结束后代，显示“有遗留 N”。
 *
 * 运行前提：
 *   - 8787 已启动并托管最新 dist/web；
 *   - Edge 以 --remote-debugging-port=9222 --headless=new 启动；
 *   - AIDASH_TOKEN 在环境变量里（脚本只写入浏览器 localStorage，不打印）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CDP = 'http://127.0.0.1:9222';
const BASE = 'http://127.0.0.1:8787';
const OUT = fileURLToPath(new URL('../../backups/ui-task-board-batch1', import.meta.url));
const CHANNEL_KEY = 'devhost/aidash/ux-refactor';

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

async function waitFor(expression, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await evaluate(`Boolean(${expression})`).catch(() => false);
    if (ready) return;
    await sleep(100);
  }
  throw new Error(`等待超时（${label}）：${expression}`);
}

async function press(key, code, virtualKeyCode, text) {
  const base = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(200);
}

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
}

const result = {};

// ---------- 0. 准备：令牌与通道 ----------
const token = process.env.AIDASH_TOKEN;
if (!token) throw new Error('缺少 AIDASH_TOKEN 环境变量');

await openPage(`${BASE}/#/tasks`);
await evaluate(`localStorage.setItem('aidash.token', ${JSON.stringify(token)})`);
await evaluate(`(() => {
  sessionStorage.setItem('aidash.channel', ${JSON.stringify(CHANNEL_KEY)});
  sessionStorage.removeItem('aidash.project');
})()`);
await send('Page.reload', { ignoreCache: true });
await waitFor(`document.querySelector('.task-board-heading')`, '任务看板头部');
await sleep(800); // 等任务树与决策卡两个请求都回来

// ---------- 1. 标题合并 + 统计 + 进度条 ----------
result.nav = await evaluate(
  `[...document.querySelectorAll('.nav .nav-link')].map((node) => node.textContent.trim())`,
);
result.header = await evaluate(`(() => {
  const heading = document.querySelector('.task-board-heading');
  const progress = heading?.querySelector('.task-progress');
  const track = progress?.querySelector('.task-progress-track');
  const done = progress?.querySelector('.task-progress-done');
  const active = progress?.querySelector('.task-progress-active');
  return {
    pageHeaderCount: document.querySelectorAll('.page-header').length,
    h1Count: document.querySelectorAll('.page > h1, .page-header h1').length,
    h2: heading?.querySelector('h2')?.textContent?.trim() ?? null,
    statsText: heading?.querySelector('.task-stats')?.innerText ?? null,
    hasActiveStat: Boolean(heading?.querySelector('.task-stat-active')),
    progressRole: progress?.getAttribute('role') ?? null,
    progressNow: progress?.getAttribute('aria-valuenow') ?? null,
    progressText: progress?.querySelector('.task-progress-text')?.innerText ?? null,
    trackHeight: track ? Math.round(track.getBoundingClientRect().height) : 0,
    doneWidth: done ? Math.round(done.getBoundingClientRect().width) : 0,
    activeWidth: active ? Math.round(active.getBoundingClientRect().width) : 0,
    activeAnimation: active ? getComputedStyle(active).animationName : null,
  };
})()`);

// ---------- 2. 列名与层级交互 ----------
result.tree = await evaluate(`(() => {
  const header = document.querySelector('.task-table-head');
  return {
    headerCells: header ? [...header.children].map((cell) => cell.textContent?.trim()) : [],
    rowCount: document.querySelectorAll('.task-row').length,
    indentCount: document.querySelectorAll('.task-indent').length,
    toggleCount: document.querySelectorAll('.task-toggle').length,
    decisionRows: document.querySelectorAll('.task-decisions').length,
    decisionChips: document.querySelectorAll('.task-decision-chip').length,
    leftoverBadges: [...document.querySelectorAll('.badge-leftover')].map((node) => node.textContent?.trim()),
  };
})()`);

// 收纳：找一个有子节点的行，点按钮前先记子节点数，点后应为 0，再点恢复。
result.toggle = await evaluate(`(() => {
  const li = [...document.querySelectorAll('.task-tree li')].find(
    (node) => node.querySelector(':scope > .task-row .task-toggle') &&
      node.querySelector(':scope > ul'),
  );
  if (!li) return { found: false };
  const before = li.querySelectorAll(':scope > ul > li').length;
  li.querySelector(':scope > .task-row .task-toggle').click();
  return { found: true, before };
})()`);
if (result.toggle.found) {
  await sleep(250);
  result.toggle.afterCollapse = await evaluate(`(() => {
    const li = [...document.querySelectorAll('.task-tree li')].find(
      (node) => node.querySelector(':scope > .task-row .task-toggle'),
    );
    return li ? li.querySelectorAll(':scope > ul > li').length : -1;
  })()`);
  await evaluate(`[...document.querySelectorAll('.task-toggle')][0].click()`);
  await sleep(250);
  result.toggle.afterExpand = await evaluate(`(() => {
    const li = [...document.querySelectorAll('.task-tree li')].find(
      (node) => node.querySelector(':scope > .task-row .task-toggle'),
    );
    return li ? li.querySelectorAll(':scope > ul > li').length : -1;
  })()`);
}

await screenshot('01-task-board');

// ---------- 3. 决策条目 → 模态框 ----------
result.decision = await evaluate(`(() => {
  const chip = document.querySelector('.task-decision-chip');
  if (!chip) return { found: false };
  const title = chip.getAttribute('title');
  chip.click();
  return { found: true, title };
})()`);
if (result.decision.found) {
  await waitFor(`document.querySelector('.question-modal')`, '决策模态框');
  await sleep(400);
  result.decision.modal = await evaluate(`(() => ({
    hasModal: Boolean(document.querySelector('.question-modal')),
    overlay: Boolean(document.querySelector('.modal-overlay')),
    titleShown: document.querySelector('.question-modal')?.innerText?.includes('信息流挂任务') ?? false,
  }))()`);
  await screenshot('02-decision-modal');
  await press('Escape', 'Escape', 27);
  await waitFor(`!document.querySelector('.question-modal')`, '模态框关闭');
  result.decision.closed = await evaluate(`!document.querySelector('.question-modal')`);
}

// ---------- 4. 动画只影响进行中段 ----------
// 无头浏览器经常默认 prefers-reduced-motion: reduce，从而按设计关掉动画。
// 这里显式模拟“用户未要求减少动效”，验证动画本身存在；再切回 reduce 确认会关。
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
});
await sleep(200);
result.animation = await evaluate(`(() => {
  const active = document.querySelector('.task-progress-active');
  const done = document.querySelector('.task-progress-done');
  return {
    prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    activeAnim: active ? getComputedStyle(active).animationName : null,
    doneAnim: done ? getComputedStyle(done).animationName : null,
  };
})()`);
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});
await sleep(200);
result.animation.reduced = await evaluate(`(() => {
  const active = document.querySelector('.task-progress-active');
  return active ? getComputedStyle(active).animationName : null;
})()`);

result.problems = problems;
writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
