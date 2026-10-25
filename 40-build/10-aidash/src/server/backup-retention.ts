import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './log.js';

/**
 * 迁移前备份的保留策略。
 *
 * 为什么要有它：每次 schema 升级都会生成一份 pre-migrate-*.db，之前只增不减，
 * 长期运行会占满磁盘，下一次迁移反而可能因为没空间而失败。
 *
 * 边界刻意收得很窄：只删本程序命名规则生成的文件，人工备份、数据库本体、
 * 子目录和陌生文件一律不动；最新一份无条件保留，至少保留 minKeep 份。
 * 清理失败只返回 failures / 记 warn，绝不阻断启动——它只是磁盘运维，不是启动前置条件。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// 与 main.ts 的 `pre-migrate-${from}-to-${to}-${ISO.replace(/[:.]/g, '-')}.db` 对齐。
const BACKUP_NAME =
  /^pre-migrate-\d+-to-\d+-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/;

export interface BackupRetentionOptions {
  backupDir: string;
  /** 传入数据库本体路径，避免极端命名碰撞时误删。 */
  dbPath?: string;
  /** 超过这个天数的旧备份才进入候选；默认配置为 30 天。 */
  retentionDays: number;
  /** 至少保留的份数；最新一份无论如何都保留（默认配置为 5）。 */
  minKeep: number;
}

export interface BackupRetentionFailure {
  file: string;
  reason: string;
}

export interface BackupRetentionResult {
  deleted: string[];
  kept: number;
  failed: BackupRetentionFailure[];
}

/** 测试注入点：固定时钟与模拟 unlink 失败，生产调用走默认实现。 */
export interface BackupRetentionDeps {
  now?: number;
  unlink?: (file: string) => void;
}

interface BackupFile {
  name: string;
  path: string;
  createdAt: number;
}

function timestampOf(match: RegExpExecArray): number {
  const [, year, month, day, hour, minute, second, millis] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millis),
  );
}

function listBackups(backupDir: string, dbPath?: string): BackupFile[] {
  const guard = dbPath && dbPath !== ':memory:' ? path.resolve(dbPath) : null;
  const files: BackupFile[] = [];
  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    // 只处理普通文件：目录、符号链接都可能指向备份目录之外，不能跟。
    if (!entry.isFile()) continue;
    const match = BACKUP_NAME.exec(entry.name);
    if (!match) continue;
    const file = path.join(backupDir, entry.name);
    if (guard && path.resolve(file) === guard) continue;
    files.push({ name: entry.name, path: file, createdAt: timestampOf(match) });
  }
  return files;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 执行一次清理。函数本身不抛异常：目录不存在视为没有备份，
 * 读取或删除失败收集到 failed 里，交给调用方决定怎么告警。
 */
export function pruneOldBackups(
  options: BackupRetentionOptions,
  deps: BackupRetentionDeps = {},
): BackupRetentionResult {
  const result: BackupRetentionResult = { deleted: [], kept: 0, failed: [] };
  const now = deps.now ?? Date.now();
  const retentionDays = Number.isFinite(options.retentionDays)
    ? Math.max(0, options.retentionDays)
    : 0;
  const retentionMs = retentionDays * DAY_MS;
  // 即使调用方传 0 或非法值，最新一份也必须留下。
  const minKeep = Number.isFinite(options.minKeep) ? Math.max(1, Math.floor(options.minKeep)) : 1;

  let files: BackupFile[];
  try {
    files = listBackups(options.backupDir, options.dbPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 备份目录还没创建是正常状态，不该每天启动都报一条告警。
    if (code !== 'ENOENT') {
      result.failed.push({ file: path.resolve(options.backupDir), reason: messageOf(error) });
    }
    return result;
  }

  // 文件名里的时间戳是可排序的事实；倒序后 index 0 就是最新一份。
  files.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  const unlink = deps.unlink ?? ((file: string) => fs.unlinkSync(file));

  files.forEach((file, index) => {
    const withinKeepWindow = index < minKeep || now - file.createdAt <= retentionMs;
    if (withinKeepWindow) {
      result.kept += 1;
      return;
    }
    try {
      unlink(file.path);
      result.deleted.push(file.name);
    } catch (error) {
      result.failed.push({ file: file.name, reason: messageOf(error) });
    }
  });

  return result;
}

/** 启动阶段的薄封装：把清理结果变成日志，并保证任何意外都不会冒泡。 */
export function enforceBackupRetention(options: BackupRetentionOptions, log: Logger): void {
  try {
    const result = pruneOldBackups(options);
    if (result.deleted.length > 0) {
      log.info('backup_retention_pruned', {
        deleted: result.deleted.length,
        kept: result.kept,
      });
    }
    if (result.failed.length > 0) {
      log.warn('backup_retention_failed', {
        count: result.failed.length,
        failures: result.failed.slice(0, 5),
      });
    }
  } catch (error) {
    // pruneOldBackups 已收敛预期错误；这里兜住未来改动，确保清理永不阻断启动。
    log.warn('backup_retention_failed', {
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
