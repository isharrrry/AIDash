/**
 * 极简 CDP 客户端：只做 E2E 断言需要的那几件事。
 *
 * 为什么不用 Playwright / Puppeteer：
 * 1. 技术规格清单 §6.4 已锁定「E2E 用 Edge 无头 + CDP」，引入 Playwright 会带来
 *    一份上百 MB 的浏览器和一条新的版本矩阵，与「单机自用、零第三方运行时依赖」
 *    的定位冲突；
 * 2. Node 24 自带全局 WebSocket，CDP 本身只是 JSON over WebSocket，
 *    「导航 + 求值 + 截图 + 收集控制台错误」这四样本事已经覆盖 UI 回归的全部断言面。
 *
 * 影响范围：
 * - 只被 50-verify/e2e 下的脚本 import；
 * - 不进 dist，不被 src/ 引用；
 * - 不修改服务端任何接口。
 */

import { setTimeout as sleep } from 'node:timers/promises';

/** 单条命令的默认超时。CDP 本地通信，5 秒足够；卡住通常说明浏览器已崩。 */
const COMMAND_TIMEOUT_MS = 5_000;

export class CdpClient {
  #socket;
  #sequence = 0;
  /** id → {resolve, reject, timer}：防止浏览器没响应时 Promise 永久挂起。 */
  #waiting = new Map();
  /** 控制台与未捕获异常。用例据此判断「页面没白屏但一直在报错」这种隐性失败。 */
  #consoleErrors = [];
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', () => {
      this.#closed = true;
      // 浏览器被关掉时，所有挂起的命令都必须失败，否则 run.mjs 会一直等下去。
      for (const [id, entry] of this.#waiting) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`CDP 连接已关闭（未完成命令 id=${id}）`));
      }
      this.#waiting.clear();
    });
  }

  /**
   * 连接一条 CDP WebSocket。
   * @param {string} url 形如 ws://127.0.0.1:9222/devtools/page/<id>
   */
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`连接 CDP 超时：${url}`)), COMMAND_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`连接 CDP 失败：${url}`));
      });
    });
    const client = new CdpClient(socket);
    // 三个域都要显式开：不开 Runtime 拿不到异常，不开 Log 拿不到浏览器级错误。
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    return client;
  }

  get consoleErrors() {
    return [...this.#consoleErrors];
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.#waiting.has(message.id)) {
      const entry = this.#waiting.get(message.id);
      this.#waiting.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`${message.error.code} ${message.error.message}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    // 事件分支：只记「页面自己报的错」，忽略 favicon 之类的资源 404 噪音。
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails;
      this.#consoleErrors.push(details?.exception?.description ?? details?.text ?? 'Runtime exception');
    }
    if (message.method === 'Log.entryAdded') {
      const entry = message.params?.entry;
      if (entry?.level === 'error' && !/favicon/i.test(entry.text ?? '')) {
        this.#consoleErrors.push(entry.text ?? 'Log error');
      }
    }
  }

  /** 发一条 CDP 命令并等待响应。 */
  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error(`CDP 已关闭，无法发送 ${method}`));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.#waiting.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * 在页面上下文求值并取回 JS 值。
   *
   * userGesture=true：某些交互（比如 localStorage 写入、点击后导航）在没有用户手势时
   * 会被浏览器限制；E2E 里没有真实鼠标，只能显式声明。
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text ?? '页面求值抛异常');
    }
    return result.result?.value;
  }

  /**
   * 轮询直到表达式为真。
   *
   * 为什么不用固定 sleep：UI 的渲染时机取决于接口返回与 React 提交阶段，
   * 固定等待要么慢要么不稳；轮询把「等多久」交给真实条件决定。
   */
  async waitFor(expression, label, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        // 页面正在导航时求值会报 "Execution context was destroyed"，属于正常竞态。
        lastError = error;
      }
      await sleep(100);
    }
    const suffix = lastError ? `（最后一次错误：${lastError.message}）` : '';
    throw new Error(`等待超时（${label}）：${expression}${suffix}`);
  }

  /** 导航并等到 DOM 可用；比监听 loadEventFired 更宽容（SPA 首屏常是异步渲染）。 */
  async navigate(url, timeoutMs = 15_000) {
    await this.send('Page.navigate', { url });
    await this.waitFor("document.readyState === 'complete'", `导航到 ${url}`, timeoutMs);
  }

  /**
   * 整页刷新。
   *
   * 为什么需要它：`Page.navigate` 到「同文档不同 hash」的地址只是改 hash，
   * 不会重新执行 JS。而令牌写在 localStorage 里、App 只在初始化时读一次，
   * 所以「设完令牌」必须真的重载一次，否则页面仍停在令牌输入页。
   */
  async reload(timeoutMs = 15_000) {
    await this.send('Page.reload', { ignoreCache: true });
    await this.waitFor("document.readyState === 'complete'", '整页刷新', timeoutMs);
  }

  /** 改 hash 并等一帧，用于同页内切视图（不触发整页加载）。 */
  async setHash(hash) {
    await this.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
    // hashchange 是同步派发，但 React 的 setState 要等一次渲染；等两帧最省事。
    await this.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  }

  async screenshotBase64() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    return data;
  }

  async close() {
    try {
      await this.send('Page.close');
    } catch {
      // 页面可能已经自己关了；关闭失败不影响宿主进程清理。
    }
  }

  /**
   * 断开 WebSocket 并释放事件循环。
   *
   * 为什么必须显式调用：Node 的全局 WebSocket 是活跃句柄，不 close 的话
   * 即使所有用例都跑完了，进程也会一直挂着不退出——表现就是「跑完了但命令不返回」。
   */
  disconnect() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      // 已经断开的情况忽略即可。
    }
  }
}

/**
 * 用 CDP 的 HTTP 端点新开一个标签页。
 *
 * 注意必须是 PUT：GET 在新版 Chromium 上返回 405。
 */
export async function newPage(devtoolsBase, url) {
  const response = await fetch(`${devtoolsBase}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!response.ok) {
    throw new Error(`打开新标签页失败：HTTP ${response.status}`);
  }
  const page = await response.json();
  if (!page.webSocketDebuggerUrl) {
    throw new Error('打开新标签页失败：响应里没有 webSocketDebuggerUrl');
  }
  return CdpClient.connect(page.webSocketDebuggerUrl);
}

/** 轮询 DevTools 端点直到浏览器就绪（进程起来 ≠ 端口可连）。 */
export async function waitForDevtools(devtoolsBase, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${devtoolsBase}/json/version`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  const suffix = lastError ? `（最后一次错误：${lastError.message}）` : '';
  throw new Error(`DevTools 端点未就绪：${devtoolsBase}${suffix}`);
}
