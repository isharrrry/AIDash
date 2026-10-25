/**
 * AIDash Web 手动冒烟脚本（CDP 驱动，无第三方依赖）。
 *
 * 为什么不用 Playwright/Chrome DevTools MCP：
 * 这台机器只装了 Edge，DevTools MCP 写死了 Chrome stable 的路径；
 * Node 24 自带 WebSocket，直接连 Edge 的 CDP 就足够验证 DOM 与键盘交互。
 *
 * 调用方：只由开发者在验证 UI 时用 `node` 直接执行，不被应用代码 import。
 * 影响范围：只读页面 DOM + 通过网页接口提交两张测试决策卡；不改服务端 API、不改数据库 schema。
 *
 * 运行前提：
 *   1. 8787 已启动并托管最新 dist/web；
 *   2. Edge 以 --remote-debugging-port=9222 --headless=new 启动；
 *   3. 通过 SMOKE_CARD_A / SMOKE_CARD_B 传入两张待决策冒烟卡 id（脚本会选第一项并提交）。
 *
 * 输出：JSON 结果 + 截图，写入 40-build/10-aidash/backups/ui-smoke/。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CDP = 'http://127.0.0.1:9222';
const BASE = 'http://127.0.0.1:8787';
const OUT = fileURLToPath(new URL('../../backups/ui-smoke', import.meta.url));
const CHANNEL_KEY = 'devhost/aidash/ux-refactor';

const CARD_A = process.env.SMOKE_CARD_A;
const CARD_B = process.env.SMOKE_CARD_B;
if (!CARD_A || !CARD_B) {
  throw new Error('需要 SMOKE_CARD_A / SMOKE_CARD_B 两个待决策卡 id');
}

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
  await sleep(150);
}

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
}

const result = {};

// ---------- 1. 通道树 ----------
// 新浏览器配置没有 localStorage，先在第一跳里写入令牌再重载；
// 令牌只从环境变量读取，不写进脚本、日志或截图。
const token = process.env.AIDASH_TOKEN;
if (!token) throw new Error('缺少 AIDASH_TOKEN 环境变量');
await openPage(`${BASE}/`);
await evaluate(`localStorage.setItem('aidash.token', ${JSON.stringify(token)})`);
await send('Page.reload', { ignoreCache: true });
await waitFor(`document.querySelector('.channel-tree-trigger')`, '通道树触发器');
await evaluate(`document.querySelector('.channel-tree-trigger').click()`);
await waitFor(`document.querySelector('.channel-tree-panel')`, '通道树面板');
await sleep(300);

result.channelTree = await evaluate(`(() => {
  const panel = document.querySelector('.channel-tree-panel');
  const text = panel.innerText;
  return {
    startLabels: (text.match(/开始 \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}/g) ?? []).length,
    endLabels: (text.match(/结束 \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}/g) ?? []).length,
    activeLabels: (text.match(/进行中/g) ?? []).length,
    spinners: panel.querySelectorAll('.spinner.spinner-xs').length,
    projectRows: panel.querySelectorAll('.channel-tree-project').length,
    channelRows: panel.querySelectorAll('.channel-tree-item').length,
    hasAllNode: Boolean(panel.querySelector('.channel-tree-all')),
  };
})()`);
await screenshot('01-channel-tree');

// 点主对话行 = 聚焦该主对话下全部通道
result.channelTree.projectLabel = await evaluate(
  `document.querySelector('.channel-tree-project strong')?.textContent ?? null`,
);
await evaluate(`document.querySelector('.channel-tree-project').click()`);
await sleep(500);
result.channelTree.afterProject = await evaluate(
  `document.querySelector('.channel-tree-trigger').innerText`,
);

// 点根节点“全部通道” = 一步清空两级筛选
await evaluate(`document.querySelector('.channel-tree-trigger').click()`);
await waitFor(`document.querySelector('.channel-tree-all')`, '全部通道节点');
await evaluate(`document.querySelector('.channel-tree-all').click()`);
await sleep(500);
result.channelTree.afterAll = await evaluate(
  `document.querySelector('.channel-tree-trigger').innerText`,
);

// 选中目标任务所在通道，供任务页只渲染一个看板
await evaluate(`document.querySelector('.channel-tree-trigger').click()`);
await waitFor(`document.querySelector('.channel-tree-panel')`, '通道树面板');
await evaluate(`(() => {
  const item = [...document.querySelectorAll('.channel-tree-item')]
    .find((node) => node.innerText.includes(${JSON.stringify(CHANNEL_KEY)}));
  if (!item) throw new Error('找不到目标通道');
  item.click();
})()`);
await sleep(600);
result.channelTree.selected = await evaluate(
  `document.querySelector('.channel-tree-trigger').innerText`,
);

// ---------- 2. 任务树 ----------
await evaluate(`location.hash = '/tasks'`);
await waitFor(`document.querySelector('.task-table-head')`, '任务树列头');
await sleep(800);

result.taskTree = await evaluate(`(() => {
  const header = document.querySelector('.task-table-head');
  const rows = [...document.querySelectorAll('.task-row')];
  const toRow = (row) => {
    const timeTitle = row.querySelector('.task-time')?.getAttribute('title') ?? '';
    const created = timeTitle.match(/创建 ([^·]+)/)?.[1]?.trim() ?? null;
    return {
      status: row.querySelector('.task-cell-status .badge')?.textContent ?? null,
      isDone: Boolean(row.querySelector('.task-cell-status .task-status-done')),
      kind: row.querySelector('.badge.kind-task, .badge.kind-suggestion')?.textContent ?? null,
      title: row.querySelector('.task-title')?.textContent ?? null,
      created,
      hasAddButton: Boolean(
        row.querySelector('.task-row-actions button[title*="新增草稿子任务"]'),
      ),
    };
  };
  return {
    headerCells: [...header.children].map((cell) => cell.textContent?.trim()),
    rowCount: rows.length,
    kinds: [...new Set(rows.map((row) =>
      row.querySelector('.badge.kind-task, .badge.kind-suggestion')?.textContent ?? '—'))],
    rows: rows.slice(0, 12).map(toRow),
    allRows: rows.map(toRow),
  };
})()`);

// 排序断言必须按“同级节点”看：父任务要先于子任务出现，
// 把整棵树拍平再要求 done 全在前，会把“未完成的父 + 已完成的子”误判成排序错误。
result.taskTree.sorting = await evaluate(`(() => {
  const check = (list) => {
    const rows = [...list.children]
      .filter((node) => node.tagName === 'LI')
      .map((node) => {
        const row = node.querySelector(':scope > .task-row');
        const timeTitle = row?.querySelector('.task-time')?.getAttribute('title') ?? '';
        return {
          done: Boolean(row?.querySelector('.task-status-done')),
          created: timeTitle.match(/创建 ([^·]+)/)?.[1]?.trim() ?? '',
        };
      });
    const firstOpen = rows.findIndex((row) => !row.done);
    const doneFirst = firstOpen === -1 || rows.slice(firstOpen).every((row) => !row.done);
    let timeAscending = true;
    for (let index = 1; index < rows.length; index += 1) {
      if (
        rows[index - 1].done === rows[index].done &&
        rows[index - 1].created.localeCompare(rows[index].created) > 0
      ) {
        timeAscending = false;
      }
    }
    let childrenOk = true;
    for (const node of [...list.children].filter((item) => item.tagName === 'LI')) {
      const childList = node.querySelector(':scope > ul');
      if (childList && !check(childList)) childrenOk = false;
    }
    return doneFirst && timeAscending && childrenOk;
  };
  return { doneFirstAndTimeAsc: [...document.querySelectorAll('.task-tree')].every(check) };
})()`);

// 行内一句话新增草稿
await evaluate(`document.querySelector('.task-row-actions button[title*="新增草稿子任务"]').click()`);
await waitFor(`document.querySelector('.task-add-inline input')`, '行内草稿输入框');
await evaluate(`(() => {
  const input = document.querySelector('.task-add-inline input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '冒烟：==行内草稿== 验证');
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await evaluate(`(() => {
  const button = [...document.querySelectorAll('.task-add-inline button')]
    .find((node) => node.textContent.includes('保存草稿'));
  if (!button) throw new Error('找不到保存按钮');
  button.click();
})()`);
await waitFor(
  `[...document.querySelectorAll('.toast-success')].some((node) => node.innerText.includes('已添加草稿子任务'))`,
  '草稿创建成功提示',
);
await waitFor(
  `[...document.querySelectorAll('.task-title mark')].some((node) => node.textContent.includes('行内草稿'))`,
  '草稿标题的高亮渲染',
);
result.taskTree.inlineAdd = await evaluate(`(() => ({
  highlightedTitles: [...document.querySelectorAll('.task-title mark')].map((node) => node.textContent),
  toast: document.querySelector('.toast-success')?.innerText ?? null,
}))()`);
await screenshot('02-task-tree');

// ---------- 3. 拍板模态框 ----------
await evaluate(`location.hash = '/?card=${CARD_A}'`);
await waitFor(`document.querySelector('.question-modal')`, '拍板模态框');
await sleep(600);

result.questionModal = {};
result.questionModal.layout = await evaluate(`(() => {
  const body = document.querySelector('.question-modal-body');
  const main = document.querySelector('.question-modal-main');
  const side = document.querySelector('.question-modal-side');
  return {
    gridColumns: getComputedStyle(body).gridTemplateColumns.split(' ').length,
    mainScrolls: main.scrollHeight > main.clientHeight,
    sideScrolls: side.scrollHeight > side.clientHeight,
    hint: document.querySelector('.question-modal-hint')?.textContent?.trim() ?? null,
    index: document.querySelector('.modal-nav-index')?.textContent?.trim() ?? null,
    optionCount: document.querySelectorAll('.answer-option-card').length,
    shortcutKeys: [...document.querySelectorAll('.option-key')].map((node) => node.textContent),
    highlightCount: document.querySelectorAll('.question-modal-main mark').length,
    boldCount: document.querySelectorAll('.question-modal-main strong').length,
  };
})()`);
await screenshot('03-question-modal');

// 数字键 2 选中第二项
await press('2', 'Digit2', 50, '2');
result.questionModal.afterKey2 = await evaluate(
  `document.querySelector('.answer-option-card.selected .option-head strong')?.textContent ?? null`,
);

// → 切到第二张待决策卡
await press('ArrowRight', 'ArrowRight', 39);
await waitFor(
  `document.querySelector('.modal-nav-index')?.textContent?.includes('2 / 2')`,
  '切换到第二张决策卡',
);
result.questionModal.afterArrowRight = await evaluate(`(() => ({
  index: document.querySelector('.modal-nav-index')?.textContent?.trim() ?? null,
  cardId: document.body.innerText.includes(${JSON.stringify(CARD_B)}) ? ${JSON.stringify(CARD_B)} : null,
  optionCount: document.querySelectorAll('.answer-option-card').length,
}))()`);

// 在 B 卡上按 1 + Enter 提交
await press('1', 'Digit1', 49, '1');
await press('Enter', 'Enter', 13, '\r');
await waitFor(`document.querySelectorAll('.answer-option-card.readonly').length > 0`, 'B 卡进入已回答态');
await sleep(500);
result.questionModal.answeredB = await evaluate(`(() => ({
  readonlyOptions: document.querySelectorAll('.answer-option-card.readonly').length,
  selected: document.querySelectorAll('.answer-option-card.readonly.selected').length,
  unselected: document.querySelectorAll('.answer-option-card.readonly.unselected').length,
  chosenBadges: [...document.querySelectorAll('.badge.answer-chosen')].length,
  summary: document.querySelector('.answer-summary')?.innerText ?? null,
}))()`);

// ← 回到 A 卡并提交。
// 注意：B 卡已答，待决策列表会在切回时重取，编号从“2/2”变成“1/1”是预期行为；
// 这里只断言“已经切到 A 卡”，不把编号写死。
await press('ArrowLeft', 'ArrowLeft', 37);
await waitFor(
  `location.hash.includes(${JSON.stringify(CARD_A)}) && document.querySelector('.question-modal')`,
  '切回第一张决策卡',
);
await sleep(400);
result.questionModal.afterArrowLeft = await evaluate(`(() => ({
  hash: location.hash,
  index: document.querySelector('.modal-nav-index')?.textContent?.trim() ?? null,
}))()`);
await press('1', 'Digit1', 49, '1');
await press('Enter', 'Enter', 13, '\r');
await waitFor(`document.querySelectorAll('.answer-option-card.readonly').length === 3`, 'A 卡进入已回答态');
await sleep(500);
result.questionModal.answeredA = await evaluate(`(() => ({
  readonlyOptions: document.querySelectorAll('.answer-option-card.readonly').length,
  selectedLabels: [...document.querySelectorAll('.answer-option-card.readonly.selected .option-head strong')]
    .map((node) => node.textContent),
  unselected: document.querySelectorAll('.answer-option-card.readonly.unselected').length,
  chosenBadge: document.querySelector('.badge.answer-chosen')?.textContent ?? null,
  allLabels: [...document.querySelectorAll('.answer-option-card.readonly .option-head strong')]
    .map((node) => node.textContent),
}))()`);
await screenshot('04-question-answered');

// ---------- 4. 窄屏自适应 ----------
await send('Emulation.setDeviceMetricsOverride', {
  width: 820,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(500);
result.questionModal.narrow = await evaluate(`(() => ({
  gridColumns: getComputedStyle(document.querySelector('.question-modal-body'))
    .gridTemplateColumns.split(' ').length,
  modalWidth: document.querySelector('.question-modal').getBoundingClientRect().width,
}))()`);
await screenshot('05-question-narrow');

result.problems = problems;
writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
