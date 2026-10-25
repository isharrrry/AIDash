#!/usr/bin/env node
/**
 * AIDash 数据库恢复助手（部署脚本的一部分）。
 *
 * 为什么需要独立脚而不是 `Copy-Item 备份 db`：
 * 1. 备份文件可能早已损坏（磁盘、拷贝中断）。直接覆盖等于用坏库换掉好库，
 *    而且原来的数据还没了。所以恢复前必须先验 sha256 + integrity_check。
 * 2. 覆盖前要留一份“现场快照”。恢复本身是破坏性操作：如果备份其实是错的、
 *    或者恢复后发现版本不对，没有快照就回不去了。
 * 3. WAL 模式留下 `-wal` / `-shm`。旧库的 WAL 里可能还有已提交的事务；
 *    换掉主文件却留下旧 WAL，SQLite 下次打开会把旧页“重放”到新库上，
 *    得到一个主键冲突或数据错乱的混合体。必须一起清掉。
 * 4. 服务还在跑时换库，等于让运行中的连接继续写已被替换的文件；
 *    Windows 上通常直接 EBUSY/EPERM，但行为不可依赖。用 --port 探活后拒绝。
 *
 * 恢复顺序（每一步失败都必须让目标库保持原样）：
 *   1. 校验备份存在、非空、sha256 对得上（有 .sha256 时强制；缺失需显式放行）；
 *   2. 只读打开备份做 integrity_check；
 *   3. --port 探活，任何进程在听就拒绝；
 *   4. 目标库存在时先做安全快照（SQLite Backup API，含 WAL 已提交内容）；
 *   5. 删目标库的 -wal / -shm；
 *   6. 复制备份到同目录临时文件，再 rename 原子替换；
 *   7. 对落地后的目标库再做一次 integrity_check + sha256 对账。
 *
 * 用法：
 *   node restore-db.mjs --db <目标库> --from <备份文件> [--safety-dir <目录>] [--port <端口>]
 *                       [--allow-missing-sha256]
 *
 * 退出码：
 *   0 = 恢复成功且已校验
 *   1 = 失败（目标库保持恢复前状态；或已在安全快照阶段中止）
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const BUILD_PACKAGE = path.join(REPO_ROOT, '40-build', 'package.json');
const RESTORE_LOG = 'restore.log';

function fail(message) {
  console.error(`[restore] FAIL: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[restore] ${message}`);
}

function parseArgs(argv) {
  const args = {
    db: null,
    from: null,
    safetyDir: null,
    port: null,
    allowMissingSha256: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--db') {
      args.db = argv[i + 1];
      i += 1;
    } else if (key === '--from') {
      args.from = argv[i + 1];
      i += 1;
    } else if (key === '--safety-dir') {
      args.safetyDir = argv[i + 1];
      i += 1;
    } else if (key === '--port') {
      args.port = Number(argv[i + 1]);
      i += 1;
    } else if (key === '--allow-missing-sha256') {
      args.allowMissingSha256 = true;
    } else {
      fail(`未知参数：${key}`);
    }
  }
  if (!args.db || !args.from) {
    fail(
      '用法：node restore-db.mjs --db <目标库> --from <备份文件> [--safety-dir <目录>] [--port <端口>] [--allow-missing-sha256]',
    );
  }
  if (args.port !== null && (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535)) {
    fail(`--port 不是合法端口：${args.port}`);
  }
  return args;
}

function loadBetterSqlite3() {
  const requireFromBuild = createRequire(BUILD_PACKAGE);
  return requireFromBuild('better-sqlite3');
}

/** 只读打开 SQLite 文件并跑 integrity_check；任何非 ok 都算失败。 */
function assertIntegrity(Database, file, label) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma('integrity_check');
    const first = Array.isArray(rows) ? rows[0] : rows;
    const result = first && typeof first === 'object' ? first.integrity_check : String(first);
    if (result !== 'ok') fail(`${label}完整性校验失败：${result}`);
  } finally {
    db.close();
  }
}

/** 流式哈希，避免把大文件一次性读进内存。 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 读取 `<备份>.sha256` 里的第一段十六进制。格式与 sha256sum 一致。 */
function readExpectedDigest(shaFile) {
  const raw = fs.readFileSync(shaFile, 'utf8').trim();
  const match = raw.match(/^([0-9a-fA-F]{64})\b/);
  if (!match) fail(`校验文件格式不对（期望 64 位十六进制开头）：${shaFile}`);
  return match[1].toLowerCase();
}

/**
 * 探活：能建立 TCP 连接就说明端口有人监听。
 * 不用 HTTP 请求的原因：AIDash 停机中但别的程序占了端口时，发 HTTP 等超时太慢；
 * 而这里的问题本质是“端口被占用”，TCP connect 已经给出答案。
 */
function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (listening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(1_500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * 为现有库做安全快照。
 *
 * 必须用 SQLite Backup API 而不是文件复制：目标库处于 WAL 模式时，
 * 最近提交的事务可能还在 -wal 里，直接复制主文件会得到“少了最后几条写入”的快照。
 */
async function snapshotCurrent(Database, target, safetyDir) {
  fs.mkdirSync(safetyDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(safetyDir, `pre-restore-${stamp}.db`);
  if (fs.existsSync(dest)) fail(`安全快照目标已存在，拒绝覆盖：${dest}`);
  const db = new Database(target);
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  assertIntegrity(Database, dest, '安全快照');
  const digest = await sha256File(dest);
  fs.writeFileSync(`${dest}.sha256`, `${digest}  ${path.basename(dest)}\n`, 'utf8');
  return { path: dest, sha256: digest };
}

/**
 * 删除目标库的 -wal / -shm。
 *
 * 两处调用：替换前删一次（旧 WAL 绝不能落到新库上），校验后再删一次。
 * 第二次是必要的：恢复后的库仍是 WAL 模式，只读打开做 integrity_check 时
 * SQLite 会重建空的 -shm（部分环境也重建 -wal）。它们本身无害，但留着会让
 * 运维误以为“旧 WAL 没删干净”；清掉后交付物就是与备份逐字节一致的主文件。
 */
function removeSidecars(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.rmSync(sidecar, { force: true });
      info(`已删除副文件：${path.basename(sidecar)}`);
    }
  }
}

/** 恢复记录：追加一行 JSON。失败只告警，不影响恢复结果。 */
function appendRestoreLog(targetDir, record) {
  try {
    fs.appendFileSync(
      path.join(targetDir, RESTORE_LOG),
      `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`,
      'utf8',
    );
  } catch (error) {
    console.warn(`[restore] WARN: 写恢复记录失败（不影响已完成的恢复）：${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(args.db);
  const fromPath = path.resolve(args.from);
  const safetyDir = path.resolve(args.safetyDir ?? path.dirname(dbPath));

  if (dbPath === fromPath) fail('目标库与备份文件不能是同一个路径。');
  if (!fs.existsSync(fromPath)) fail(`备份文件不存在：${fromPath}`);
  if (fs.statSync(fromPath).size === 0) fail(`备份文件大小为 0：${fromPath}`);

  let Database;
  try {
    Database = loadBetterSqlite3();
  } catch (error) {
    fail(
      `无法从 40-build/node_modules 加载 better-sqlite3：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 1) 校验 sha256。备份助手默认会写 .sha256；缺失时要求显式放行，
  //    避免“以为验过了、其实没验”。
  const shaFile = `${fromPath}.sha256`;
  const actualDigest = await sha256File(fromPath);
  if (fs.existsSync(shaFile)) {
    const expected = readExpectedDigest(shaFile);
    if (expected !== actualDigest) {
      fail(`备份 sha256 不匹配：期望 ${expected}，实际 ${actualDigest}。备份可能损坏，已中止。`);
    }
    info(`sha256 校验通过：${actualDigest}`);
  } else if (args.allowMissingSha256) {
    info(
      `WARN: 未找到 ${path.basename(shaFile)}，按 --allow-missing-sha256 继续。实际 sha256=${actualDigest}`,
    );
  } else {
    fail(
      `未找到校验文件：${shaFile}。没有它可以恢复，但无法证明备份没被改坏；` +
        '确认要跳过请加 --allow-missing-sha256。',
    );
  }

  // 2) 备份自身必须完整。
  assertIntegrity(Database, fromPath, '备份文件');

  // 3) 服务在跑就不换库。
  if (args.port !== null) {
    if (await isPortListening(args.port)) {
      fail(`端口 ${args.port} 仍有进程监听，说明服务没停。请先停止 AIDash 再恢复。`);
    }
    info(`端口 ${args.port} 无监听，确认服务已停止。`);
  }

  // 4) 先留现场快照，再做任何破坏性动作。
  const targetExists = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  let safety = null;
  if (targetExists) {
    safety = await snapshotCurrent(Database, dbPath, safetyDir);
    info(`现场快照：${safety.path}（sha256=${safety.sha256}）`);
  } else {
    info(`目标库不存在或为空，跳过现场快照：${dbPath}`);
  }

  // 5) 清掉旧 WAL。必须在快照之后：快照需要读到它们。
  removeSidecars(dbPath);

  // 6) 同目录临时文件 + rename 原子替换。
  //    临时文件放在目标目录内，保证 rename 不跨卷（跨卷 rename 会退化为复制，失去原子性）。
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const temp = `${dbPath}.restore-tmp-${process.pid}`;
  try {
    fs.copyFileSync(fromPath, temp);
    try {
      fs.renameSync(temp, dbPath);
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined;
      fail(
        `替换目标库失败（${code ?? 'unknown'}）：${error instanceof Error ? error.message : String(error)}。` +
          `常见原因是服务仍在运行占用文件；临时文件保留在 ${temp}`,
      );
    }
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }

  // 7) 落地后再验一次：复制过程中出问题会在这里暴露，而不是等下次启动。
  assertIntegrity(Database, dbPath, '恢复后的目标库');
  const restoredDigest = await sha256File(dbPath);
  if (restoredDigest !== actualDigest) {
    fail(
      `恢复后 sha256 与备份不一致：备份 ${actualDigest}，落地 ${restoredDigest}。` +
        (safety ? `现场快照在 ${safety.path}，可据此回退。` : ''),
    );
  }

  // 只读校验可能重建了空的副文件（见 removeSidecars 注释），清掉再交付。
  removeSidecars(dbPath);

  appendRestoreLog(path.dirname(dbPath), {
    action: 'restore',
    from: fromPath,
    sha256: actualDigest,
    safety_snapshot: safety?.path ?? null,
    result: 'ok',
  });

  info(`OK：已从 ${fromPath} 恢复；integrity_check=ok，sha256=${restoredDigest}`);
  if (safety) info(`如需回退本次恢复，用现场快照：${safety.path}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
