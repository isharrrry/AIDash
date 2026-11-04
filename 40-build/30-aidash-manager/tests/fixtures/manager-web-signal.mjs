/**
 * 测试夹具：启动管理台 Web，等父进程写入 <home>/shutdown 后模拟 Ctrl+C 退出。
 *
 * 为什么不用外部信号：Windows 上 process.kill(pid, 'SIGTERM') 走的是
 * TerminateProcess，不会触发 JS 的 SIGTERM 监听；真实控制台里的 Ctrl+C
 * 则是 Node 把 CTRL_C_EVENT 转成 SIGINT 事件。这里直接 emit('SIGINT')
 * 走的就是同一条处理路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runMain } from '../../src/cli/main.js';

const [home, port] = process.argv.slice(2);
if (!home || !port) {
  process.stderr.write('用法：manager-web-signal.mjs <home> <port>\n');
  process.exit(2);
}

const runtimeFile = path.join(home, 'web-runtime.json');
const shutdownFile = path.join(home, 'shutdown');
const running = runMain(['web', '--home', home, '--port', port, '--no-open', '--json']);

let signalled = false;
const poll = setInterval(() => {
  if (signalled || !fs.existsSync(runtimeFile) || !fs.existsSync(shutdownFile)) return;
  signalled = true;
  clearInterval(poll);
  process.emit('SIGINT');
}, 50);

// 防止夹具自己挂死：15 秒还没收到退出指令就报错退出，让父测试尽快失败。
const guard = setTimeout(() => {
  if (signalled) return;
  clearInterval(poll);
  process.stderr.write('夹具等待 shutdown 超时\n');
  process.exit(3);
}, 15_000);
guard.unref();

const code = await running;
clearTimeout(guard);
// 不要在这里 process.exit：Windows 上服务端句柄正在关闭时强制退出会触发
// libuv 断言（0xC0000409）。设置退出码后让事件循环自然收尾。
process.exitCode = code;
