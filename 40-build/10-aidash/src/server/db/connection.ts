import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface OpenDbOptions {
  busyTimeoutMs?: number;
}

/**
 * 打开唯一的持久化连接（05 §6.1）。
 *
 * 原理：
 * - WAL 允许读写并行，但写仍然串行，因此所有写事务必须短；
 * - busy_timeout 让并发写等待而不是立刻抛 SQLITE_BUSY；
 * - foreign_keys 是连接级开关，必须每次打开都设置。
 */
export function openDb(dbPath: string, options: OpenDbOptions = {}): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * 写事务统一走 BEGIN IMMEDIATE。
 * 原因：默认 DEFERRED 会先拿读锁、写时再升级；两个事务同时升级会死锁。
 * 提前拿写锁 + busy_timeout 可以把冲突变成“排队”。
 */
export function txImmediate<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function isDbWritable(db: Db): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
