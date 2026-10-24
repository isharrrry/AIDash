#!/usr/bin/env node
/**
 * 打包值守壳：10-aidash/src/cli/index.ts → 10-aidash/dist/cli/aidash-watch.mjs
 *
 * 为什么用 esbuild bundle：
 * - 值守壳可能被拷到没有 node_modules 的机器上运行，单文件产物最省事；
 * - target=node24 与根 package.json 的 engines 一致，不额外做降级转译；
 * - banner 保留 shebang：esbuild 只有在 bundle 时才方便把 shebang 放在第一行，
 *   否则源码里的 shebang 经过格式转换可能被挤到中间，执行时不被识别。
 */
import { chmod, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// 本文件位于 00-platform/tools/，向上两级回到仓库根。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = path.join(root, '10-aidash', 'src', 'cli', 'index.ts');
const outfile = path.join(root, '10-aidash', 'dist', 'cli', 'aidash-watch.mjs');

await mkdir(path.dirname(outfile), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [entry],
  outfile,
  platform: 'node',
  format: 'esm',
  bundle: true,
  target: 'node24',
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  legalComments: 'none',
  logLevel: 'info',
});

// Windows 上 chmod 基本是 no-op；POSIX 上让产物可以直接执行。
await chmod(outfile, 0o755).catch(() => {
  // 某些文件系统（如部分网络盘）不支持 chmod，不影响 `node 10-aidash/dist/cli/aidash-watch.mjs`。
});

const info = await stat(outfile);
process.stdout.write(
  `[build-cli] ${path.relative(root, outfile)} (${(info.size / 1024).toFixed(1)} KiB)\n`,
);
