import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../shared/errors.js';
import { txImmediate, type Db } from './connection.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 源码运行（tsx）与编译后（dist）都能找到迁移目录。 */
function resolveMigrationsDir(explicit?: string): string {
  if (explicit) return explicit;
  const candidates = [
    path.join(HERE, 'migrations'),
    path.resolve(process.cwd(), '40-build/10-aidash/src/server/db/migrations'),
    // 兼容已有的 temp 运行目录（迁移前在旧路径下启动的场景）。
    path.resolve(process.cwd(), 'src/server/db/migrations'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, '000_bootstrap.sql'))) return candidate;
  }
  throw new AppError('INTERNAL', 'MIGRATIONS_DIR_NOT_FOUND');
}

export interface MigrationReport {
  applied: number[];
  skipped: number[];
}

interface MigrationFile {
  version: number;
  description: string;
  file: string;
  sql: string;
  checksum: string;
}

/**
 * 统一 SQL 文本的换行符。
 *
 * 为什么不在原始字节上算 checksum：同一份迁移在 Windows 检出（CRLF）与
 * Linux 部署（LF）下字节不同，会让部署库已经记录的历史 checksum 与源码构建的
 * dist 对不上，启动直接报 MIGRATION_CHECKSUM_MISMATCH。SQL 语义与换行风格无关，
 * 因此先归一为 LF 再计算与执行；已有迁移文件本身不需要改写。
 */
function normalizeSqlText(sql: string): string {
  return sql.replace(/\r\n?/g, '\n');
}

function loadMigrations(dir: string): MigrationFile[] {
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort((a, b) => Number(a.slice(0, 3)) - Number(b.slice(0, 3)));

  return files
    .filter((name) => !name.startsWith('000_'))
    .map((name) => {
      const version = Number(name.slice(0, 3));
      const sql = normalizeSqlText(fs.readFileSync(path.join(dir, name), 'utf8'));
      return {
        version,
        description: name.replace(/^\d+_/, '').replace(/\.sql$/, ''),
        file: name,
        sql,
        // 用归一后的 SQL 计算：checksum 描述的是迁移内容，而不是检出的换行风格。
        checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
      };
    });
}

/**
 * 迁移执行器（05 §7.3）。
 *
 * 为什么 checksum 只增不改：已发布迁移改一个字符就会和库里的记录不一致；
 * 这里遇到不一致直接拒绝启动，避免“代码 schema 与库 schema 悄悄分叉”。
 *
 * 失败时由同一事务回滚当前文件；调用方（main）负责在启动失败时恢复迁移前备份。
 */
export function migrate(db: Db, options: { migrationsDir?: string; now?: number } = {}): MigrationReport {
  const dir = resolveMigrationsDir(options.migrationsDir);
  const bootstrap = fs.readFileSync(path.join(dir, '000_bootstrap.sql'), 'utf8');
  db.exec(bootstrap);

  const currentRows = db
    .prepare('SELECT version, checksum FROM schema_migration ORDER BY version')
    .all() as Array<{ version: number; checksum: string }>;
  const current = new Map(currentRows.map((row) => [row.version, row.checksum]));

  const migrations = loadMigrations(dir);
  const report: MigrationReport = { applied: [], skipped: [] };
  const now = options.now ?? Date.now();

  for (const migration of migrations) {
    const existingChecksum = current.get(migration.version);
    if (existingChecksum) {
      if (existingChecksum !== migration.checksum) {
        throw new AppError('INTERNAL', 'MIGRATION_CHECKSUM_MISMATCH', {
          version: migration.version,
          file: migration.file,
        });
      }
      report.skipped.push(migration.version);
      continue;
    }

    try {
      txImmediate(db, () => {
        db.exec(migration.sql);
        db.prepare(
          'INSERT INTO schema_migration(version, description, checksum, applied_at) VALUES (?,?,?,?)',
        ).run(migration.version, migration.description, migration.checksum, now);
        db.pragma(`user_version = ${migration.version}`);
      });
      report.applied.push(migration.version);
    } catch (error) {
      throw new AppError('INTERNAL', 'MIGRATION_FAILED', {
        version: migration.version,
        file: migration.file,
        cause: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  return report;
}

/** 供 main 判断“是否需要在迁移前备份”：当前库版本低于目标版本才备份。 */
export function latestMigrationVersion(migrationsDir?: string): number {
  const dir = resolveMigrationsDir(migrationsDir);
  const versions = loadMigrations(dir).map((migration) => migration.version);
  return versions.length ? Math.max(...versions) : 0;
}

export function schemaVersion(db: Db): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) AS version FROM schema_migration')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}
