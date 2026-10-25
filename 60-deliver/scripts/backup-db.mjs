#!/usr/bin/env node
/**
 * AIDash 数据库备份助手（Windows 部署脚本的一部分）。
 *
 * 为什么不直接在 PowerShell 里 Copy-Item：
 * SQLite 处于 WAL 模式，已提交的事务可能还在 `-wal` 文件里、尚未 checkpoint 到主库。
 * 直接复制 `.db` 会漏掉这些页，得到一个“看起来成功、实际少了最近写入”的备份。
 * SQLite 的在线备份 API（better-sqlite3 的 db.backup）读取的是连接视图，
 * 会把 WAL 中已提交的内容一并纳入，得到一致快照（设计 05 §9.1）。
 *
 * 本脚本做四件事：
 * 1. 先 `PRAGMA wal_checkpoint(TRUNCATE)`，把 WAL 落回主库；busy=1 说明还有别的连接在写，
 *    这时不继续——部署脚本刚停过服务，出现 busy 通常意味着“没停干净”，应该先查。
 * 2. 用 Backup API 生成备份文件。先写到同目录的临时文件，校验通过后再原子改名：
 *    直接写最终路径的话，中途失败会留下半截 `.db`，而下一次部署又拒绝覆盖同名文件——
 *    一次失败会把后续部署一起挡住，还得人工判断哪个文件能删。
 * 3. 打开备份做 `PRAGMA integrity_check`，结果必须是 ok。
 * 4. 计算 sha256 并写 `<备份>.sha256`，供回滚前校验。
 *
 * 另外支持只读校验模式（回滚前用）：
 *   node backup-db.mjs --verify <备份文件>
 * 只打开备份做 integrity_check 并算 sha256，不改主文件、不写校验文件。
 * 注意：备份是 WAL 模式的库，SQLite 打开它时**必然**在同目录生成 `-shm` / `-wal`
 * （只读标志挡不住这一步，这是 WAL 的实现要求）。所以校验结束会把**本次新建**的
 * 副文件删掉；本来就存在的副文件不动 —— 那可能是别人的现场，删了会掩盖问题。
 *
 * 退出码：
 *   0 = 成功
 *   1 = 失败（备份文件不可信，调用方必须停止部署/回滚）
 *   2 = 源库不存在或为空（首次部署，调用方可按“跳过”处理）
 *
 * 为什么用 createRequire 从 40-build 解析 better-sqlite3：
 * 本文件在 60-deliver/scripts 下，Node 的默认模块解析会从脚本目录向上找 node_modules，
 * 而依赖装在 40-build/node_modules。显式指定解析起点，避免换目录部署后报 MODULE_NOT_FOUND。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const BUILD_PACKAGE = path.join(REPO_ROOT, '40-build', 'package.json');

function fail(message) {
  console.error(`[backup] FAIL: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { db: null, out: null, sha256: null, verify: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--db') {
      args.db = value;
      i += 1;
    } else if (key === '--out') {
      args.out = value;
      i += 1;
    } else if (key === '--sha256') {
      args.sha256 = value;
      i += 1;
    } else if (key === '--verify') {
      args.verify = value;
      i += 1;
    } else {
      fail(`未知参数：${key}`);
    }
  }
  if (args.verify) {
    if (args.db || args.out || args.sha256) {
      fail('--verify 是只读校验模式，不能和 --db/--out/--sha256 混用。');
    }
    return args;
  }
  if (!args.db || !args.out) {
    fail('用法：node backup-db.mjs --db <源库> --out <备份文件> [--sha256 <校验文件>]；或 node backup-db.mjs --verify <备份文件>');
  }
  return args;
}

function loadBetterSqlite3() {
  const requireFromBuild = createRequire(BUILD_PACKAGE);
  return requireFromBuild('better-sqlite3');
}

/** 只读打开一个 SQLite 文件，跑 integrity_check；任何非 ok 都算失败。 */
function assertIntegrity(Database, file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma('integrity_check');
    const first = Array.isArray(rows) ? rows[0] : rows;
    const result = first && typeof first === 'object' ? first.integrity_check : String(first);
    if (result !== 'ok') fail(`完整性校验失败：${result}`);
  } finally {
    db.close();
  }
}

/** 用流式哈希，避免把几百 MB 的备份一次性读进内存。 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.verify) {
    const verifyPath = path.resolve(args.verify);
    if (!fs.existsSync(verifyPath)) fail(`校验目标不存在：${verifyPath}`);
    if (fs.statSync(verifyPath).size === 0) fail(`校验目标大小为 0：${verifyPath}`);
    let Database;
    try {
      Database = loadBetterSqlite3();
    } catch (error) {
      fail(`无法从 40-build/node_modules 加载 better-sqlite3：${error instanceof Error ? error.message : String(error)}`);
    }

    // 打开前先记下哪些副文件已经存在：只清理本次新建的那些。
    // 用 finally 而不是「成功后清理」，是因为校验失败恰恰也是会留下副文件的路径。
    const sidecars = [`${verifyPath}-wal`, `${verifyPath}-shm`];
    const preexisting = new Set(sidecars.filter((file) => fs.existsSync(file)));
    try {
      assertIntegrity(Database, verifyPath);
      const digest = await sha256File(verifyPath);
      console.log(`[verify] OK：integrity_check=ok，sha256=${digest}`);
      console.log(`[verify] 文件：${verifyPath}`);
    } finally {
      for (const file of sidecars) {
        if (preexisting.has(file)) continue;
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // 清理失败不该把「校验通过」变成「校验失败」；残留的副文件不影响下次校验。
        }
      }
    }
    return;
  }

  const dbPath = path.resolve(args.db);
  const outPath = path.resolve(args.out);

  if (dbPath === outPath) fail('源库与备份文件不能是同一个路径。');
  if (!fs.existsSync(dbPath)) {
    console.log(`[backup] 跳过：源库不存在：${dbPath}`);
    process.exit(2);
  }
  if (fs.statSync(dbPath).size === 0) {
    console.log(`[backup] 跳过：源库大小为 0：${dbPath}`);
    process.exit(2);
  }
  if (fs.existsSync(outPath)) fail(`目标已存在，拒绝覆盖：${outPath}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // 先把快照写到同目录临时文件，最后一步再 rename。
  // 临时文件必须与目标同目录：跨卷 rename 会退化成复制，失去原子性。
  // 注册 exit 清理，是为了让 fail()（内部 process.exit）也能带走半截文件——
  // 只在正常路径 finally 里删是不够的，失败路径恰恰是最需要清理的那条。
  const tempPath = `${outPath}.tmp-${process.pid}`;
  // SQLite 打开临时库做 integrity_check 时，会按 WAL 模式在**临时文件旁边**生成
  // -wal / -shm（这就是「打开过就必然有副文件」的性质，只读标志挡不住）。
  // 只删主临时文件会留下 `<备份名>.tmp-<pid>-wal` 这类不会被任何流程再引用的垃圾，
  // 所以清理必须把主文件与副文件当成一组。
  const tempSidecars = ['-wal', '-shm', '-journal'].map((suffix) => `${tempPath}${suffix}`);
  const cleanupTemp = () => {
    for (const file of [tempPath, ...tempSidecars]) {
      try {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } catch {
        // 清理失败不该掩盖原始错误；残留的 .tmp-<pid> 不会挡住下一次备份。
      }
    }
  };
  process.on('exit', cleanupTemp);

  let Database;
  try {
    Database = loadBetterSqlite3();
  } catch (error) {
    fail(`无法从 40-build/node_modules 加载 better-sqlite3：${error instanceof Error ? error.message : String(error)}`);
  }

  let schemaVersion = 0;
  const source = new Database(dbPath);
  try {
    // checkpoint 的返回值形如 [{ busy, log, checkpointed }]。
    // busy=1 表示有别的连接让 checkpoint 无法完成；此时备份仍可能一致，
    // 但“服务已经停了”这个前提就值得怀疑，宁可失败让人检查。
    const checkpointRows = source.pragma('wal_checkpoint(TRUNCATE)');
    const checkpoint = Array.isArray(checkpointRows) ? checkpointRows[0] : checkpointRows;
    if (checkpoint && Number(checkpoint.busy) !== 0) {
      fail('WAL checkpoint 失败：仍有连接占用数据库（busy=1）。请确认 AIDash 已停止，且没有第二个备份/查询工具在跑。');
    }

    // 新库可能还没有 schema_migration 表；备份本身仍然有效，只是版本记为 0。
    try {
      const row = source.prepare('SELECT MAX(version) AS version FROM schema_migration').get();
      schemaVersion = row && row.version !== null && row.version !== undefined ? Number(row.version) : 0;
    } catch {
      schemaVersion = 0;
    }

    await source.backup(tempPath);
    console.log(`[backup] 快照完成（临时文件）：${tempPath}（schema_version=${schemaVersion}）`);
  } finally {
    source.close();
  }

  // 备份完成后必须再打开一次做完整性校验：如果复制/写入过程中出错，
  // 这一步会把“坏备份”拦在部署之前，而不是等到回滚时才发现。
  // 校验对象是临时文件——坏文件绝不能先落到最终路径上。
  assertIntegrity(Database, tempPath);

  const sizeBytes = fs.statSync(tempPath).size;
  const digest = await sha256File(tempPath);

  // 原子改名。Windows 上目标已存在时 renameSync 会抛错（不会静默覆盖）；
  // 前面的存在性检查只是提前给出更清楚的提示，真正的兜底在这里。
  try {
    fs.renameSync(tempPath, outPath);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    fail(
      `备份校验通过但改名失败（${code ?? 'unknown'}）：${error instanceof Error ? error.message : String(error)}。` +
        '目标可能已被另一个进程创建；临时文件会在退出时清理。',
    );
  }

  if (args.sha256) {
    const shaPath = path.resolve(args.sha256);
    // 格式与 sha256sum 一致：<hash>  <文件名>，方便人工核对。
    fs.writeFileSync(shaPath, `${digest}  ${path.basename(outPath)}\n`, 'utf8');
    console.log(`[backup] sha256=${digest}`);
  }
  console.log(`[backup] OK：${sizeBytes} 字节，integrity_check=ok`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
