import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 版本从 package.json 读，避免 `--version` 与 npm 包版本双真源。
 * 读不到时退回 0.0.0，让程序还能正常报错退出，而不是启动即崩。
 */
function readVersion() {
  try {
    const url = new URL('../package.json', import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(url, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();

/** 管理台默认端口：避开 AIDash 的 8787，也不占用常见的 3000/5173。 */
export const DEFAULT_WEB_PORT = 4280;
export const DEFAULT_WEB_HOST = '127.0.0.1';
export const MAX_WEB_PORT_TRIES = 30;

export const MANAGER_HOME_ENV = 'AIDASH_MANAGER_HOME';
export const DEFAULT_MANAGER_HOME = path.join(os.homedir(), '.aidash', 'manager');

export const SERVICE_TYPES = Object.freeze(['aidash', 'runner']);
export const SERVICE_ID_PATTERN = /^svc_[A-Za-z0-9_-]{4,40}$/;

/** 与 AIDash 服务端一致：令牌只从环境变量或令牌文件读，不写配置文件。 */
export const TOKEN_ENV_NAME = 'AIDASH_TOKEN';

/**
 * 子进程基础环境白名单不在这里维护：管理台启动的是“用户自己的服务”，
 * 与 runner 启动 harness 的信任模型不同。管理台直接继承当前进程环境，
 * 再由服务定义里的 env 覆盖；敏感字段永远不进入 manager.json。
 */

export const MAX_LOG_TAIL_LINES = 5_000;
export const LOG_READ_CHUNK_BYTES = 512 * 1024;
export const MAX_LOG_READ_BYTES = 4 * 1024 * 1024;

export const STATE_VERSION = 1;

export const AIDASH_HEALTH_PATH = '/healthz';

/**
 * 工作目录兼容布局：服务目录本身就是 AIDash 部署/源码目录时，
 * 程序与数据都相对它解析。新代码只应把“程序”部分用于程序探测；
 * 数据路径请用 aidashDataLayout()，否则纯数据目录会被误当成部署目录。
 */
export function aidashLayoutCandidates(cwd) {
  return [
    {
      key: 'deploy',
      serverEntry: path.join(cwd, 'server', 'dist', 'server', 'main.js'),
      staticDir: path.join(cwd, 'server', 'dist', 'web'),
      dbPath: path.join(cwd, 'data', 'aidash.db'),
      backupDir: path.join(cwd, 'backups'),
    },
    {
      key: 'source',
      serverEntry: path.join(cwd, '40-build', '10-aidash', 'dist', 'server', 'main.js'),
      staticDir: path.join(cwd, '40-build', '10-aidash', 'dist', 'web'),
      dbPath: path.join(cwd, '40-build', '10-aidash', 'data', 'aidash.db'),
      backupDir: path.join(cwd, '40-build', '10-aidash', 'backups'),
    },
    {
      key: 'source-nested',
      serverEntry: path.join(cwd, 'aidash', '40-build', '10-aidash', 'dist', 'server', 'main.js'),
      staticDir: path.join(cwd, 'aidash', '40-build', '10-aidash', 'dist', 'web'),
      dbPath: path.join(cwd, 'aidash', '40-build', '10-aidash', 'data', 'aidash.db'),
      backupDir: path.join(cwd, 'aidash', '40-build', '10-aidash', 'backups'),
    },
  ];
}

/**
 * AIDash 程序安装根目录的候选布局。
 *
 * 同一份程序有三种常见形态，管理台都应能识别：
 * - deploy：部署包根目录（`<root>/server/dist/server/main.js`）；
 * - package：`10-aidash` 包根目录（`<root>/dist/server/main.js`）；
 * - source：仓库根目录（`<root>/40-build/10-aidash/dist/server/main.js`）。
 */
export function aidashProgramLayoutCandidates(root) {
  return [
    {
      key: 'deploy',
      appDir: root,
      serverEntry: path.join(root, 'server', 'dist', 'server', 'main.js'),
      staticDir: path.join(root, 'server', 'dist', 'web'),
    },
    {
      key: 'package',
      appDir: root,
      serverEntry: path.join(root, 'dist', 'server', 'main.js'),
      staticDir: path.join(root, 'dist', 'web'),
    },
    {
      key: 'source',
      appDir: root,
      serverEntry: path.join(root, '40-build', '10-aidash', 'dist', 'server', 'main.js'),
      staticDir: path.join(root, '40-build', '10-aidash', 'dist', 'web'),
    },
  ];
}

/**
 * 纯数据工作目录的默认数据布局：库、备份都在服务工作目录下。
 * 程序入口/静态资源不放在这里——它们来自管理台识别的程序目录。
 */
export function aidashDataLayout(cwd) {
  return {
    key: 'data',
    dbPath: path.join(cwd, 'data', 'aidash.db'),
    backupDir: path.join(cwd, 'backups'),
  };
}
