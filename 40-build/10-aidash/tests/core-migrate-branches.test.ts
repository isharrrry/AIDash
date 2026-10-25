import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { latestMigrationVersion, migrate, schemaVersion } from '../src/server/db/migrate.js';
import { openDb } from '../src/server/db/connection.js';
import { expectAppError } from './fakes/core-fixtures.js';
import { createHarness } from './helpers.js';

/**
 * 迁移执行的错误分支。
 *
 * 由 core-error-branches 按主题拆出：重复执行、校验和变化、单文件回滚、
 * 迁移目录缺失与版本排序。断言保持原样，仅搬移分组。
 */

/** 真实迁移目录：仅用于“复制 000_bootstrap 到临时目录”的场景。 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../src/server/db/migrations', import.meta.url));

function makeMigrationsDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-core-mig-'));
  fs.copyFileSync(
    path.join(MIGRATIONS_DIR, '000_bootstrap.sql'),
    path.join(dir, '000_bootstrap.sql'),
  );
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql, 'utf8');
  }
  return dir;
}

describe('migrate 错误分支', () => {
  it('重复执行：已应用版本全部 skipped，版本号不变', () => {
    const h = createHarness();
    try {
      const before = schemaVersion(h.db);
      expect(before).toBe(latestMigrationVersion());
      expect(before).toBeGreaterThanOrEqual(16);

      const report = migrate(h.db);
      expect(report.applied).toEqual([]);
      expect(report.skipped).toContain(before);
      expect(report.skipped.length).toBe(before);
      expect(schemaVersion(h.db)).toBe(before);
    } finally {
      h.close();
    }
  });

  it('校验和变化：拒绝启动，已应用 schema 与记录保持原样', () => {
    const h = createHarness();
    const dir = makeMigrationsDir();
    try {
      const file = path.join(dir, '900_test.sql');
      fs.writeFileSync(file, 'CREATE TABLE mig_checksum_probe(x INTEGER);\n', 'utf8');
      expect(migrate(h.db, { migrationsDir: dir }).applied).toEqual([900]);
      expect(schemaVersion(h.db)).toBe(900);

      fs.writeFileSync(file, 'CREATE TABLE mig_checksum_probe(x INTEGER, y INTEGER);\n', 'utf8');
      const error = expectAppError(
        () => migrate(h.db, { migrationsDir: dir }),
        'INTERNAL',
        'MIGRATION_CHECKSUM_MISMATCH',
      );
      expect(error.details).toMatchObject({ version: 900, file: '900_test.sql' });

      expect(schemaVersion(h.db)).toBe(900);
      const columns = h.db.prepare('PRAGMA table_info(mig_checksum_probe)').all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual(['x']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      h.close();
    }
  });

  it('迁移失败：当前文件整体回滚，半成品表与版本记录都不落库', () => {
    const h = createHarness();
    const dir = makeMigrationsDir({
      '901_bad.sql':
        'CREATE TABLE mig_partial_probe(x INTEGER);\nINSERT INTO no_such_table VALUES (1);\n',
    });
    try {
      const error = expectAppError(
        () => migrate(h.db, { migrationsDir: dir }),
        'INTERNAL',
        'MIGRATION_FAILED',
      );
      expect(error.details).toMatchObject({ version: 901, file: '901_bad.sql' });
      expect(typeof error.details?.cause).toBe('string');

      const table = h.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mig_partial_probe'")
        .get();
      expect(table).toBeUndefined();
      expect(h.db.prepare('SELECT version FROM schema_migration WHERE version = 901').get()).toBeUndefined();
      expect(schemaVersion(h.db)).toBe(latestMigrationVersion());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      h.close();
    }
  });

  it('默认迁移目录都找不到时返回 MIGRATIONS_DIR_NOT_FOUND，而不是裸 ENOENT', () => {
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      expectAppError(
        () => latestMigrationVersion(),
        'INTERNAL',
        'MIGRATIONS_DIR_NOT_FOUND',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('空库 schemaVersion 为 0；按版本号排序执行并记录 applied', () => {
    const dir = makeMigrationsDir({
      '010_ten.sql': 'SELECT 10;\n',
      '002_two.sql': 'SELECT 2;\n',
    });
    try {
      expect(latestMigrationVersion(dir)).toBe(10);

      const fresh = openDb(':memory:');
      try {
        // schema_migration 尚不存在：不能抛错，按“无版本”处理。
        expect(schemaVersion(fresh)).toBe(0);

        const report = migrate(fresh, { migrationsDir: dir });
        expect(report.applied).toEqual([2, 10]);
        expect(report.skipped).toEqual([]);
        expect(schemaVersion(fresh)).toBe(10);

        // 再执行一次走 skipped 分支。
        const again = migrate(fresh, { migrationsDir: dir });
        expect(again.applied).toEqual([]);
        expect(again.skipped).toEqual([2, 10]);
      } finally {
        fresh.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
