import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';

/**
 * 启动路径解析与“空库误连”检查。
 *
 * 为什么要单独一层：
 * 1. 配置里的路径允许是相对路径（相对启动时的工作目录），但会话一换、
 *    启动目录一变，`./10-aidash/...` 就会指向另一个文件；启动日志打印
 *    **解析后的绝对路径**，才能一眼看出“连的是哪个库”。
 * 2. 库文件不存在时 better-sqlite3 会直接建一个空库，随后迁移把空库
 *    标成最新版本。用户看到的是“任务全没了”，却没有任何报错。
 *    所以建库之前先看备份：有备份说明更像路径漂移，默认拒绝启动。
 */
export interface StartupPaths {
  dbPath: string;
  backupDir: string;
  staticDir: string;
}

/** 把配置路径固定成绝对路径；`:memory:` 保持原样（测试用）。 */
export function resolveStartupPaths(
  config: Pick<AppConfig, 'dbPath' | 'backupDir' | 'staticDir'>,
): StartupPaths {
  return {
    dbPath: config.dbPath === ':memory:' ? ':memory:' : path.resolve(config.dbPath),
    backupDir: path.resolve(config.backupDir),
    staticDir: path.resolve(config.staticDir),
  };
}

export interface EmptyDbCheck {
  /** 配置的库文件当前不存在（即将被当成空库创建）。 */
  missing: boolean;
  /** 找到的备份文件绝对路径；只用于日志与错误提示，不读取内容。 */
  backups: string[];
  /** 备份目录存在但读不了（权限/占用）；调用方应提示“无法判断有没有备份”。 */
  backupDirReadable: boolean;
}

/**
 * 建库前检查：库不存在时，同目录的 `.bak` / `.backup` 与备份目录里的
 * `*.db`（迁移前备份的命名）都算“有备份”。
 *
 * 只做存在性判断，不打开备份文件——这里的目的是阻止“静默建空库”，
 * 不是自动恢复；自动恢复需要人确认，属于另一条流程。
 */
export function inspectEmptyDb(dbPath: string, backupDir: string): EmptyDbCheck {
  if (dbPath === ':memory:' || fs.existsSync(dbPath)) {
    return { missing: false, backups: [], backupDirReadable: true };
  }

  const backups = new Set<string>();
  for (const suffix of ['.bak', '.backup', '.db.bak']) {
    const candidate = `${dbPath}${suffix}`;
    if (fs.existsSync(candidate)) backups.add(candidate);
  }

  let backupDirReadable = true;
  if (fs.existsSync(backupDir)) {
    try {
      for (const name of fs.readdirSync(backupDir)) {
        if (name.endsWith('.db')) backups.add(path.join(backupDir, name));
      }
    } catch {
      // 读不了目录不等于没有备份：把状态交给调用方决定怎么提示，
      // 但绝不在这里假装“检查过且没有”。
      backupDirReadable = false;
    }
  }

  return { missing: true, backups: [...backups].sort(), backupDirReadable };
}
