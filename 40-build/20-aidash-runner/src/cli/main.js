import { parseArgv } from '../args.js';
import { VERSION } from '../constants.js';
import { checkCommand, initCommand } from './commands-init.js';
import {
  dryRunCommand,
  onceCommand,
  runInternal,
  startCommand,
} from './commands-start.js';
import {
  configCommand,
  killCommand,
  stopCommand,
} from './commands-control.js';
import {
  listCommand,
  logsCommand,
  pullCommand,
  statusCommand,
} from './commands-query.js';
import { helpText } from './help.js';
import { CliOutput, exitCodeFor } from './output.js';

const HANDLERS = {
  start: (flags, out) => startCommand(flags, out),
  __run: (flags, out) => runInternal(flags, out),
  once: (flags, out) => onceCommand(flags, out),
  'dry-run': (flags, out) => dryRunCommand(flags, out),
  list: (flags, out) => listCommand(flags, out),
  status: (flags, out, pos) => statusCommand(flags, out, pos),
  pull: (flags, out, pos) => pullCommand(flags, out, pos),
  stop: (flags, out, pos) => stopCommand(flags, out, pos),
  kill: (flags, out, pos) => killCommand(flags, out, pos),
  config: (flags, out, pos) => configCommand(flags, out, pos),
  logs: (flags, out, pos) => logsCommand(flags, out, pos),
  init: (flags, out) => initCommand(flags, out),
  check: (flags, out) => checkCommand(flags, out),
};

/**
 * CLI 顶层：解析参数 → 分发 → 统一错误出口。
 *
 * 这里不 process.exit()，只返回退出码；bin 把它赋给 process.exitCode。
 * 好处是测试可以直接 await runMain 或子进程读取真实退出码，也避免在 stdout
 * 尚未 flush 时把进程掐掉。
 */
export async function runMain(argv) {
  const wantsJson = argv.includes('--json');
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    const out = new CliOutput({ json: wantsJson });
    out.error(error);
    return exitCodeFor(error);
  }

  const { command, flags, positionals } = parsed;
  const out = new CliOutput({ json: flags.json });

  if (flags.version) {
    out.write({ version: VERSION }, VERSION);
    return 0;
  }
  if (flags.help || command === 'help') {
    out.write({ version: VERSION, help: helpText() }, helpText());
    return 0;
  }

  const handler = HANDLERS[command];
  if (!handler) {
    const error = new Error(`未知命令：${command}`);
    out.error(error);
    return 2;
  }

  try {
    const code = await handler(flags, out, positionals);
    return typeof code === 'number' ? code : 0;
  } catch (error) {
    out.error(error);
    return exitCodeFor(error);
  }
}
