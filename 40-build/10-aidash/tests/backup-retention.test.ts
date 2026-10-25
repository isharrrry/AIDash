import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneOldBackups } from '../src/server/backup-retention.js';
import { loadConfig } from '../src/server/config.js';

/**
 * 备份保留策略的单元测试。
 *
 * 全部使用临时目录：不碰真实 data/、backups/。
 * 重点不是“能删文件”，而是不能删错东西——DB 本体、人工备份、陌生命名
 * 都必须原样保留；最新一份即使超过保留期也不能删。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-retention-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function backupName(ageDays: number): string {
  const stamp = new Date(NOW - ageDays * DAY_MS).toISOString().replace(/[:.]/g, '-');
  return `pre-migrate-1-to-2-${stamp}.db`;
}

function writeBackup(dir: string, ageDays: number): string {
  const name = backupName(ageDays);
  fs.writeFileSync(path.join(dir, name), 'backup', 'utf8');
  return name;
}

describe('pruneOldBackups', () => {
  it('超过保留天数的旧备份被清理，保留份数内的新备份不动', () => {
    // Arrange：40/35/31 天前超过 30 天；20/10/2 天前够新。
    const dir = makeTempDir();
    const names = [40, 35, 31, 20, 10, 2].map((age) => writeBackup(dir, age));

    // Act：至少保留 2 份（2 天前、10 天前），20 天前靠天数保留。
    const result = pruneOldBackups(
      { backupDir: dir, retentionDays: 30, minKeep: 2 },
      { now: NOW },
    );

    // Assert
    expect(result.deleted.sort()).toEqual([names[0], names[1], names[2]].sort());
    expect(result.kept).toBe(3);
    expect(fs.existsSync(path.join(dir, names[3]!))).toBe(true);
    expect(fs.existsSync(path.join(dir, names[4]!))).toBe(true);
    expect(fs.existsSync(path.join(dir, names[5]!))).toBe(true);
  });

  it('即使配置成 0 份，也硬性保护最新一份', () => {
    // Arrange：三份都远超保留期。
    const dir = makeTempDir();
    const oldest = writeBackup(dir, 100);
    const middle = writeBackup(dir, 90);
    const latest = writeBackup(dir, 80);

    // Act
    const result = pruneOldBackups(
      { backupDir: dir, retentionDays: 0, minKeep: 0 },
      { now: NOW },
    );

    // Assert
    expect(result.deleted.sort()).toEqual([oldest, middle].sort());
    expect(fs.existsSync(path.join(dir, latest))).toBe(true);
  });

  it('忽略陌生文件、子目录与 DB 本体，不误删非本程序生成的内容', () => {
    // Arrange：准备两份合法旧备份，并把较旧那份当作 DB 路径传入。
    const dir = makeTempDir();
    const guarded = writeBackup(dir, 200);
    const latest = writeBackup(dir, 100);
    const dbBody = path.join(dir, 'aidash.db');
    const manual = path.join(dir, 'manual-backup.db');
    const malformed = path.join(dir, 'pre-migrate-oops.db');
    fs.writeFileSync(dbBody, 'db', 'utf8');
    fs.writeFileSync(manual, 'manual', 'utf8');
    fs.writeFileSync(malformed, 'malformed', 'utf8');
    const nested = path.join(dir, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, backupName(300)), 'nested', 'utf8');

    // Act：不设保护时较旧备份本应删除，但 dbPath 命中了它。
    const result = pruneOldBackups(
      {
        backupDir: dir,
        dbPath: path.join(dir, guarded),
        retentionDays: 1,
        minKeep: 1,
      },
      { now: NOW },
    );

    // Assert
    expect(result.deleted).toEqual([]);
    for (const file of [guarded, latest]) {
      expect(fs.existsSync(path.join(dir, file))).toBe(true);
    }
    for (const file of [dbBody, manual, malformed]) {
      expect(fs.existsSync(file)).toBe(true);
    }
    expect(fs.existsSync(path.join(nested, backupName(300)))).toBe(true);
  });

  it('删除失败只记录错误，不抛出，也不影响其他文件判定', () => {
    // Arrange
    const dir = makeTempDir();
    const old = writeBackup(dir, 200);
    const latest = writeBackup(dir, 100);

    // Act
    const result = pruneOldBackups(
      { backupDir: dir, retentionDays: 1, minKeep: 1 },
      {
        now: NOW,
        unlink: () => {
          throw new Error('EBUSY');
        },
      },
    );

    // Assert
    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual([{ file: old, reason: 'EBUSY' }]);
    expect(fs.existsSync(path.join(dir, old))).toBe(true);
    expect(fs.existsSync(path.join(dir, latest))).toBe(true);
  });

  it('备份目录不存在时静默跳过；目录不可读时收敛成 failure', () => {
    const dir = makeTempDir();

    expect(
      pruneOldBackups(
        { backupDir: path.join(dir, 'missing'), retentionDays: 30, minKeep: 5 },
        { now: NOW },
      ),
    ).toEqual({ deleted: [], kept: 0, failed: [] });

    const notDir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(notDir, 'x', 'utf8');
    expect(() =>
      pruneOldBackups(
        { backupDir: notDir, retentionDays: 30, minKeep: 5 },
        { now: NOW },
      ),
    ).not.toThrow();
    const failed = pruneOldBackups(
      { backupDir: notDir, retentionDays: 30, minKeep: 5 },
      { now: NOW },
    );
    expect(failed.failed).toHaveLength(1);
  });
});

describe('备份保留配置', () => {
  it('默认保留 30 天、至少 5 份，并可通过 AIDASH_* 环境变量覆盖', () => {
    // Arrange：不存在的配置文件会让 loadConfig 只使用 env + defaults。
    const dir = makeTempDir();
    const configFile = path.join(dir, 'no-such-config.json');

    // Act
    const defaults = loadConfig({ AIDASH_TOKEN: 't' }, { configFile });
    const overridden = loadConfig(
      {
        AIDASH_TOKEN: 't',
        AIDASH_BACKUP_RETENTION_DAYS: '7',
        AIDASH_BACKUP_MIN_KEEP: '3',
      },
      { configFile },
    );

    // Assert
    expect(defaults.backupRetentionDays).toBe(30);
    expect(defaults.backupMinKeep).toBe(5);
    expect(overridden.backupRetentionDays).toBe(7);
    expect(overridden.backupMinKeep).toBe(3);
  });
});
