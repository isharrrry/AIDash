#!/usr/bin/env node
/**
 * aidash-manager 唯一入口。
 *
 * 和 runner 一样，bin 只负责把 argv 交给 CLI 层；默认无参启动是“开管理台”，
 * 不是 help——用户把工具装好后最常做的动作就是打开网页管理服务。
 */
import { runMain } from '../src/cli/main.js';

process.exitCode = await runMain(process.argv.slice(2));
