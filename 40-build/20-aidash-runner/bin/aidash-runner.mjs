#!/usr/bin/env node
/**
 * aidash-runner / aidash-watch 唯一入口。
 *
 * 这里只做一件事：把参数交给 runMain。错误分层、退出码与 --json 的处理都在
 * src/cli/main.js，保证 `node bin/aidash-runner.mjs` 与 npm 全局安装后的行为完全一致。
 * 不在这里解析参数，避免出现“bin 和 src 各有一套默认值”的双真源。
 */
import { runMain } from '../src/cli/main.js';

process.exitCode = await runMain(process.argv.slice(2));
