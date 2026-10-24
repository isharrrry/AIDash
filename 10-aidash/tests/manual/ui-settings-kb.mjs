/**
 * 设置页“知识库配置”的真机验收脚本（Edge CDP，无第三方依赖）。
 *
 * 调用方：只由开发者用 `node` 直接执行，不被应用代码 import。
 * 影响范围：会在 backups/ui-settings-kb/kb-fixture 下建一个临时 KB 目录并写入 1 篇 Markdown，
 *           通过设置页把它设为 KB 根目录、重建索引、搜索一次；finally 里清空 kb_root
 *           并删除临时目录，真实索引内容保留（清空配置后不再可见）。
 *
 * 验证目标（对应用户原话“需解决缺少知识库等配置功能”）：
 *   1. 不存在/非目录路径保存时给出明确错误，不写入配置；
 *   2. 合法目录保存后徽标变为“已启用”，无需重启；
 *   3. “重新索引”能扫描并写入索引，结果可读；
 *   4. 清空配置后回到“未配置”，重新索引入口禁用。
 */
import fs from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CDP = 'http://127.0.0.1:9222';
const BASE = 'http://127.0.0.1:8787';
const OUT = fileURLToPath(new URL('../../backups/ui-settings-kb', import.meta.url));
const KB_DIR = `${OUT}/kb-fixture`;
const MISSING = `${OUT}/definitely-missing`;

mkdirSync(KB_DIR, { recursive: true });
writeFileSync(
  `${KB_DIR}/gateway.md`,
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

/** 输入框是受控组件：直接赋 value 不触发 React，必须走原生 setter + input 事件。 */
async function typeInto(selector, value) {
  await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw new Error('input not found: ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
}

async function clickButton(text) {
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error('button not found: ' + ${JSON.stringify(text)});
    button.click();
    return null;
  })()`);
}

/** 直接调 REST 读服务端真相，避免只相信 DOM。 */
async function apiGet(pathName) {
  return evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(BASE + pathName)}, {
      headers: { authorization: 'Bearer ' + localStorage.getItem('aidash.token') },
    });
    return response.json();
  })()`);
}

async function clearKbRoot() {
  await fetch(`${BASE}/api/settings`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kb_root: null }),
  });
}

try {
  await openPage(`${BASE}/#/settings`);
  await evaluate(`localStorage.setItem('aidash.token', ${JSON.stringify(token)})`);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`document.querySelector('input[placeholder*="knowledge"]')`, '知识库输入框');
  await sleep(600);

  // 索引按钮会弹 confirm；验收脚本里直接放行，不改变页面行为。
  await evaluate(`window.confirm = () => true`);

  // ---------- 1. 不存在的目录：保存被拒 ----------
  await typeInto('input[placeholder*="knowledge"]', MISSING);
  await clickButton('保存');
  await waitFor(`document.querySelector('.toast')`, '错误提示');
  const afterBadSave = await apiGet('/api/settings');
  check(
    '不存在的目录不会写入配置',
    afterBadSave.data.kb.configured === false && afterBadSave.data.kb.root === null,
    afterBadSave.data.kb,
  );
  await screenshot('01-invalid-path');

  // ---------- 2. 合法目录：保存即生效 ----------
  await typeInto('input[placeholder*="knowledge"]', KB_DIR);
  await clickButton('保存');
  await waitFor(
    `[...document.querySelectorAll('.panel')].some((panel) =>
      panel.getAttribute('aria-label') === '知识库配置' &&
      panel.textContent.includes('已启用'))`,
    '知识库已启用',
  );
  const savedSettings = await apiGet('/api/settings');
  check(
    '合法目录保存后立即可用',
    savedSettings.data.kb.configured === true && savedSettings.data.kb.root === KB_DIR,
    savedSettings.data.kb,
  );
  await screenshot('02-enabled');

  // ---------- 3. 重新索引并搜索 ----------
  await clickButton('重新索引');
  await waitFor(`document.querySelector('.detail-json')`, '索引结果');
  await sleep(300);
  const indexNote = await evaluate(`document.querySelector('.detail-json')?.textContent ?? ''`);
  check('索引结果可读且扫描到文件', /"scanned":\s*1/.test(indexNote), indexNote.slice(0, 300));

  const search = await apiGet('/api/kb/search?q=whitelist');
  check(
    '索引后可搜索到临时文档',
    search.data?.items?.[0]?.path === 'gateway.md',
    search.data?.items?.map((item) => item.path),
  );
  await screenshot('03-indexed');

  // ---------- 4. 清空配置 ----------
  await clickButton('清空配置');
  await waitFor(
    `[...document.querySelectorAll('.panel')].some((panel) =>
      panel.getAttribute('aria-label') === '知识库配置' &&
      panel.textContent.includes('未配置'))`,
    '知识库回到未配置',
  );
  const cleared = await apiGet('/api/settings');
  check('清空后回到未配置', cleared.data.kb.configured === false, cleared.data.kb);

  const reindexDisabled = await evaluate(`(() => {
    const panel = [...document.querySelectorAll('.panel')]
      .find((node) => node.getAttribute('aria-label') === '知识库配置');
    const button = [...panel.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === '重新索引');
    return button ? button.disabled : null;
  })()`);
  check('未配置时重新索引入口禁用', reindexDisabled === true, reindexDisabled);
  await screenshot('04-cleared');
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  result.failed = true;
} finally {
  await clearKbRoot().catch((error) => {
    result.clearError = String(error);
  });
  fs.rmSync(KB_DIR, { recursive: true, force: true });
  result.consoleProblems = problems;
  writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  socket?.close();
}
