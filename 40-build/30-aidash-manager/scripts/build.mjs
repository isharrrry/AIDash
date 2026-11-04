#!/usr/bin/env node
/**
 * 构建管理台：同步 AIDash 配置 Schema，再构建 React Web。
 *
 * Schema 复制到包内是因为 npm 发布物不应该依赖仓库里的 00-platform 目录；
 * 同步放在 build 入口，避免源码 Schema 改了、发布包还在用旧副本。
 * 用 spawnSync 调 pnpm 而不是 import vite：构建依赖只在 workspace 里安装，
 * 管理台运行时始终保持零第三方依赖。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceSchema = path.resolve(root, '..', '00-platform', 'config', 'schema', 'aidash-config.schema.json');
const targetSchema = path.join(root, 'src', 'schema', 'aidash-config.schema.json');

if (existsSync(sourceSchema)) {
  mkdirSync(path.dirname(targetSchema), { recursive: true });
  copyFileSync(sourceSchema, targetSchema);
  process.stdout.write(`[manager:build] 已同步 Schema → ${path.relative(root, targetSchema)}\n`);
} else {
  process.stdout.write('[manager:build] 未找到源 Schema，沿用包内副本\n');
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(pnpm, ['--filter', 'aidash-manager-web', 'build'], {
  cwd: root,
  stdio: 'inherit',
  // Windows 的 .cmd 需要 shell 才能被 CreateProcess 正确解析；否则 spawnSync 返回 EINVAL。
  shell: process.platform === 'win32',
});
if (result.error) {
  process.stderr.write(`[manager:build] 启动 pnpm 失败：${result.error.message}\n`);
}
process.exit(result.status ?? 1);
