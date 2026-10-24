/**
 * Batch 2a（通道别名 + 记忆 Tab）的真机验收脚本（Edge CDP，无第三方依赖）。
 *
 * 调用方：只由开发者用 `node` 直接执行，不被应用代码 import。
 * 影响范围：只读页面 DOM；唯一“写”操作是在通道页把别名改成临时值再改回，
 *           用于验证 UI → PATCH → 列表刷新的闭环。脚本在 finally 里用 REST 强制复原，
 *           即使中途断言失败也不会把用户通道留在临时别名上。
 *
 * 验证目标（对应用户原话）：
 *   1. “通道名称不够友好，应该有个别名，默认显示别名”——通道树与通道页标题都优先显示别名；
 *   2. 通道页可以就地改别名，保存后标题与通道树同步更新；
 *   3. 记忆按主对话浏览：记忆 Tab 左侧列项目、右侧编辑，共用通道显示别名；
 *   4. 任务树主对话模式不再嵌第二份记忆编辑器，只保留跳转入口。
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
const OUT = fileURLToPath(new URL('../../backups/ui-alias-memory', import.meta.url));
const CHANNEL_KEY = 'devhost/aidash/ux-refactor';
const PROJECT = 'aidash';
const ORIGINAL_ALIAS = 'AIDash 界面体验与协作契约迭代';
const TEMP_ALIAS = 'UI 验收临时别名';

mkdirSync(OUT, { recursive: true });

const token = process.env.AIDASH_TOKEN;
if (!token) throw new Error('缺少 AIDASH_TOKEN 环境变量');

let socket;
let sequence = 0;
const waiting = new Map();
const problems = [];
const result = { checks: [] };

function check(name, passed, detail) {
  result.checks.push({ name, passed: Boolean(passed), detail });
  if (!passed) result.failed = true;
}

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
  const value = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (value.exceptionDetails) {
    throw new Error(
      value.exceptionDetails.exception?.description ?? value.exceptionDetails.text,
    );
  }
  return value.result.value;
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

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
}

/** 无论断言走到哪一步，都把别名恢复成原值。 */
async function restoreAlias() {
  const response = await fetch(
    `${BASE}/api/channels/${encodeURIComponent(CHANNEL_KEY)}`,
    {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ alias: ORIGINAL_ALIAS }),
    },
  );
  result.aliasRestored = response.ok;
}

try {
  // ---------- 0. 准备：写令牌并落在通道页 ----------
  await openPage(`${BASE}/#/c/${encodeURIComponent(CHANNEL_KEY)}`);
  await evaluate(`localStorage.setItem('aidash.token', ${JSON.stringify(token)})`);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`document.querySelector('.page-header h1')`, '通道页标题');
  await sleep(800);

  // ---------- 1. 通道页标题优先显示别名 ----------
  const pageTitle = await evaluate(
    `document.querySelector('.page-header h1')?.textContent?.trim()`,
  );
  check('通道页标题显示别名', pageTitle === ORIGINAL_ALIAS, pageTitle);

  // 空记忆时面板显示的是“还没有记忆”提示，而不是 .memory-view 正文；
  // 两者都算“面板已挂载”，否则这段断言会把正常的空态判成回归。
  const memoryPanel = await evaluate(`(() => {
    const panel = document.querySelector('.project-memory.compact');
    return {
      present: Boolean(panel),
      hasView: Boolean(panel?.querySelector('.memory-view')),
      hasEmptyHint: Boolean(panel?.textContent?.includes('还没有记忆')),
    };
  })()`);
  check(
    '通道页嵌入紧凑记忆面板',
    memoryPanel.present && (memoryPanel.hasView || memoryPanel.hasEmptyHint),
    memoryPanel,
  );

  // ---------- 2. 通道树也显示别名 ----------
  await evaluate(`document.querySelector('.channel-tree-trigger')?.click()`);
  await sleep(300);
  const treeRows = await evaluate(
    `[...document.querySelectorAll('.channel-tree-item strong')].map((node) => node.textContent.trim())`,
  );
  check('通道树显示别名', treeRows.includes(ORIGINAL_ALIAS), { rows: treeRows });
  await screenshot('01-channel-tree');

  // ---------- 3. 通道页改别名 → 标题同步 ----------
  await evaluate(`document.querySelector('.channel-tree-trigger')?.click()`);
  await sleep(200);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.page-header .inline button')]
      .find((node) => node.textContent.trim() === '改别名');
    button?.click();
    return null;
  })()`);
  await waitFor(`document.querySelector('.alias-editor input')`, '别名编辑器');
  const draftBefore = await evaluate(`document.querySelector('.alias-editor input')?.value`);
  check('编辑器回填当前别名', draftBefore === ORIGINAL_ALIAS, draftBefore);

  // 直接赋 value 不会触发 React 的受控更新，必须走原生 setter + input 事件。
  await evaluate(`(() => {
    const input = document.querySelector('.alias-editor input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(TEMP_ALIAS)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  await sleep(200);
  await evaluate(`(() => {
    [...document.querySelectorAll('.alias-editor button')]
      .find((node) => node.textContent.trim() === '保存')
      ?.click();
    return null;
  })()`);
  await waitFor(
    `document.querySelector('.page-header h1')?.textContent?.trim() === ${JSON.stringify(TEMP_ALIAS)}`,
    '保存后标题更新',
  );
  await screenshot('02-alias-saved');

  // ---------- 4. 记忆 Tab ----------
  await evaluate(`window.location.hash = '#/memory'`);
  await waitFor(`document.querySelector('.memory-layout')`, '记忆页布局');
  await sleep(800);

  const memory = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.memory-project-item')];
    const active = document.querySelector('.memory-project-item.active');
    const channels = [...document.querySelectorAll('.memory-channel-list li a')]
      .map((node) => node.textContent.trim());
    return {
      itemCount: items.length,
      projects: items.map((node) => node.querySelector('strong')?.textContent?.trim()),
      activeProject: active?.querySelector('strong')?.textContent?.trim() ?? null,
      hasEditor: Boolean(document.querySelector('.project-memory')),
      channels,
    };
  })()`);
  check('记忆页列出主对话', memory.itemCount > 0 && memory.projects.includes(PROJECT), memory);
  check('记忆页右侧有编辑器', memory.hasEditor, memory.hasEditor);
  check(
    '共用通道显示别名',
    memory.channels.includes(TEMP_ALIAS) || memory.channels.includes(ORIGINAL_ALIAS),
    memory.channels,
  );
  await screenshot('03-memory-tab');

  // ---------- 5. 任务树主对话模式只留入口 ----------
  await evaluate(`(() => {
    sessionStorage.setItem('aidash.project', ${JSON.stringify(PROJECT)});
    sessionStorage.removeItem('aidash.channel');
    window.location.hash = '#/tasks';
    return null;
  })()`);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`document.querySelector('.task-board-heading')`, '任务看板');
  await sleep(800);

  const tasks = await evaluate(`(() => {
    const links = [...document.querySelectorAll('.page a.inline-link')]
      .filter((node) => node.textContent.trim() === '记忆 Tab');
    return {
      memoryLinks: links.length,
      embeddedEditors: document.querySelectorAll('.project-memory').length,
      channelGroupTitles: [...document.querySelectorAll('.task-channel-head h2')]
        .map((node) => node.textContent.trim()),
    };
  })()`);
  check('任务树只保留记忆入口链接', tasks.memoryLinks === 1, tasks);
  check('任务树不再嵌第二份记忆编辑器', tasks.embeddedEditors === 0, tasks.embeddedEditors);
  check(
    '任务树通道分组显示别名',
    tasks.channelGroupTitles.includes(TEMP_ALIAS) ||
      tasks.channelGroupTitles.includes(ORIGINAL_ALIAS),
    tasks.channelGroupTitles,
  );
  await screenshot('04-tasks-project');
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  result.failed = true;
} finally {
  await restoreAlias().catch((error) => {
    result.aliasRestored = false;
    result.restoreError = String(error);
  });
  result.consoleProblems = problems;
  writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  socket?.close();
}
