import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectEmptyDb, resolveStartupPaths } from '../src/server/startup.js';

/**
 * 启动路径检查的单元测试。
 *
 * 这些用例只碰临时目录，不启动服务、不碰真实库：
 * 目的是钉住“什么情况算有备份、什么情况允许建空库”的判定，
 * 避免以后为了图省事把拒绝逻辑删掉，又回到“空库静默上线”。
 */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-startup-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveStartupPaths', () => {
  it('把相对路径解析成绝对路径', () => {
    // Arrange
    const config = { dbPath: './data/a.db', backupDir: './backups', staticDir: './dist' };

    // Act
    const paths = resolveStartupPaths(config);

    // Assert
    expect(path.isAbsolute(paths.dbPath)).toBe(true);
    expect(path.isAbsolute(paths.backupDir)).toBe(true);
    expect(path.isAbsolute(paths.staticDir)).toBe(true);
    expect(paths.dbPath).toBe(path.resolve('./data/a.db'));
  });

  it('保留内存库标记，不把它解析成文件路径', () => {
    const paths = resolveStartupPaths({
      dbPath: ':memory:',
      backupDir: './backups',
      staticDir: './dist',
    });
    expect(paths.dbPath).toBe(':memory:');
  });
});

describe('inspectEmptyDb', () => {
  it('库文件存在时不认为缺失', () => {
    // Arrange
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'aidash.db');
    fs.writeFileSync(dbPath, 'not-a-real-db');

    // Act
    const check = inspectEmptyDb(dbPath, path.join(dir, 'backups'));

    // Assert
    expect(check.missing).toBe(false);
    expect(check.backups).toEqual([]);
  });

  it('库文件缺失且没有备份时返回 missing=true', () => {
    const dir = makeTempDir();
    const check = inspectEmptyDb(path.join(dir, 'aidash.db'), path.join(dir, 'backups'));
    expect(check.missing).toBe(true);
    expect(check.backups).toEqual([]);
    expect(check.backupDirReadable).toBe(true);
  });

  it('识别同目录的 .bak 备份', () => {
    // Arrange
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'aidash.db');
    fs.writeFileSync(`${dbPath}.bak`, 'backup');

    // Act
    const check = inspectEmptyDb(dbPath, path.join(dir, 'backups'));

    // Assert
    expect(check.missing).toBe(true);
    expect(check.backups).toContain(`${dbPath}.bak`);
  });

  it('识别备份目录里的 pre-migrate .db 文件', () => {
    // Arrange
    const dir = makeTempDir();
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, 'pre-migrate-3-to-4-2026.db');
    fs.writeFileSync(backup, 'backup');

    // Act
    const check = inspectEmptyDb(path.join(dir, 'aidash.db'), backupDir);

    // Assert
    expect(check.missing).toBe(true);
    expect(check.backups).toEqual([backup]);
    expect(check.backupDirReadable).toBe(true);
  });

  it(':memory: 永远不按文件缺失处理', () => {
    const check = inspectEmptyDb(':memory:', path.join(makeTempDir(), 'backups'));
    expect(check.missing).toBe(false);
  });
});
