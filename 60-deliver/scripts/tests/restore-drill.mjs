#!/usr/bin/env node
/**
 * 备份/恢复演练：用真实脚本在临时库里走一遍，证明“坏了能救回来”。
 *
 * 为什么不是只测 restore-db.mjs 的函数：
 * 恢复是运维动作，真正的风险在步骤之间的顺序上——先校验再覆盖、先快照再删 WAL、
 * 端口有人听就拒绝。这些只有端到端跑 backup-db.mjs → 破坏库 → restore-db.mjs
 * 才能验证。演练全程在系统临时目录，不读真实库、不碰 8787。
 *
 * 覆盖场景：
 *   1. backup-db.mjs 生成快照与 .sha256；
 *   2. 备份被改坏 → sha256 不匹配，拒绝恢复，目标库保持原样；
 *   3. 缺 .sha256 → 默认拒绝；加 --allow-missing-sha256 才放行；
 *   4. 端口有人监听 → 拒绝恢复（防止在服务运行时换库）；
 *   5. 正常恢复：表与数据回来，且现场快照保存的是“恢复前”的坏状态；
 *   6. 目标库残留真实 WAL（模拟进程硬退出）→ 恢复后副文件被清掉，数据一致；
 *   7. `--verify` 只读校验：不改主文件、不留副文件，也不删预先存在的副文件。
 *
 * 用法：
 *   node 60-deliver/scripts/tests/restore-drill.mjs [--record-dir <目录>] [--no-record]
 * 退出码：0 = 全部通过；1 = 有失败。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const BACKUP_SCRIPT = path.join(REPO_ROOT, '60-deliver/scripts/backup-db.mjs');
const RESTORE_SCRIPT = path.join(REPO_ROOT, '60-deliver/scripts/restore-db.mjs');
const BUILD_PACKAGE = path.join(REPO_ROOT, '40-build', 'package.json');

const requireFromBuild = createRequire(BUILD_PACKAGE);
const Database = requireFromBuild('better-sqlite3');

const results = [];
let tempRoot = null;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` —— ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function runScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    // 演练不依赖 cwd：脚本内部都用绝对路径解析 40-build。
    cwd: REPO_ROOT,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readShaFile(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  const match = raw.match(/^([0-9a-f]{64})\b/i);
  return match ? match[1].toLowerCase() : null;
}

/** 建一个最简库：一张 demo 表 + 3 行，足够验证“数据回来了”。 */
function createDemoDb(file, notes = ['alpha', 'beta', 'gamma']) {
  const db = new Database(file);
  try {
    db.pragma('journal_mode=WAL');
    db.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO demo(note) VALUES (?)');
    for (const note of notes) insert.run(note);
  } finally {
    db.close();
  }
}

function demoRows(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='demo'")
      .get();
    if (!exists) return null;
    return db.prepare('SELECT note FROM demo ORDER BY id').all().map((row) => row.note);
  } finally {
    db.close();
  }
}

function dropDemoTable(file) {
  const db = new Database(file);
  try {
    db.exec('DROP TABLE demo');
  } finally {
    db.close();
  }
}

/**
 * 模拟“进程硬退出”：写一行后直接 process.exit，不走 close。
 * 这样 -wal / -shm 会真实留在磁盘上——正是恢复脚本必须清理的那种残留。
 */
function leaveRealWal(file) {
  const code = [
    "const { createRequire } = require('node:module');",
    `const req = createRequire(${JSON.stringify(BUILD_PACKAGE)});`,
    "const Database = req('better-sqlite3');",
    'const db = new Database(process.argv[1]);',
    "db.pragma('journal_mode=WAL');",
    "db.prepare('INSERT INTO demo(note) VALUES (?)').run('crash-row');",
    'process.exit(0);',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', code, file], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`模拟硬退出失败：${result.stderr || result.stdout}`);
  }
}

function listenOnFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 断言辅助：把“通过/失败”收进结果表，不中途抛异常，保证演练能跑完。 */
function expect(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
}

async function main() {
  const argv = process.argv.slice(2);
  let recordDir = path.join(REPO_ROOT, '50-verify', '演练记录');
  let writeRecord = true;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--record-dir') {
      recordDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--no-record') {
      writeRecord = false;
    } else {
      throw new Error(`未知参数：${argv[i]}`);
    }
  }

  for (const script of [BACKUP_SCRIPT, RESTORE_SCRIPT]) {
    if (!fs.existsSync(script)) throw new Error(`找不到脚本：${script}`);
  }

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-restore-drill-'));
  const backupsDir = path.join(tempRoot, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  // ---------------------------------------------------------------- 场景 1
  section('场景 1：备份生成快照与校验文件');
  const live = path.join(tempRoot, 'live.db');
  createDemoDb(live);
  const snapshot = path.join(backupsDir, 'snap.db');
  const backupRun = runScript(BACKUP_SCRIPT, [
    '--db',
    live,
    '--out',
    snapshot,
    '--sha256',
    `${snapshot}.sha256`,
  ]);
  expect('backup-db.mjs 退出码为 0', backupRun.status === 0, backupRun.stderr.trim());
  expect('快照文件存在且非空', fs.existsSync(snapshot) && fs.statSync(snapshot).size > 0);
  expect('校验文件存在', fs.existsSync(`${snapshot}.sha256`));
  const snapshotDigest = sha256(snapshot);
  expect(
    '校验文件与快照实际 sha256 一致',
    readShaFile(`${snapshot}.sha256`) === snapshotDigest,
    snapshotDigest,
  );
  // 备份流程会在临时文件上做 integrity_check，SQLite 因此生成 -wal/-shm；
  // 只 rename 主文件不清理副文件，会在备份目录留下 `.tmp-<pid>-wal` 垃圾。
  // 这里直接扫目录，比断言某个具体文件名更能抓住“将来又漏了某种副文件”。
  const tempLeftovers = fs.readdirSync(backupsDir).filter((name) => name.includes('.tmp-'));
  expect(
    '备份成功后不残留任何 .tmp- 临时文件（含 -wal/-shm 副文件）',
    tempLeftovers.length === 0,
    tempLeftovers.join(', '),
  );

  // ---------------------------------------------------------------- 场景 2
  section('场景 2：备份被改坏 → 拒绝恢复，目标库不受影响');
  const tampered = path.join(backupsDir, 'tampered.db');
  fs.copyFileSync(snapshot, tampered);
  fs.appendFileSync(tampered, Buffer.from('tampered!'));
  fs.copyFileSync(`${snapshot}.sha256`, `${tampered}.sha256`);
  const victimChecksum = path.join(tempRoot, 'v-checksum.db');
  fs.copyFileSync(live, victimChecksum);
  const safetyChecksumDir = path.join(tempRoot, 'safety-checksum');
  const checksumRun = runScript(RESTORE_SCRIPT, [
    '--db',
    victimChecksum,
    '--from',
    tampered,
    '--safety-dir',
    safetyChecksumDir,
  ]);
  expect('sha256 不匹配时退出码为 1', checksumRun.status === 1, checksumRun.stderr.trim());
  expect(
    '目标库数据保持原样',
    JSON.stringify(demoRows(victimChecksum)) === JSON.stringify(['alpha', 'beta', 'gamma']),
  );
  expect('校验失败时没有做安全快照', !fs.existsSync(safetyChecksumDir));

  // ---------------------------------------------------------------- 场景 3
  section('场景 3：缺 .sha256 默认拒绝，显式放行后才继续');
  const nosha = path.join(backupsDir, 'nosha.db');
  fs.copyFileSync(snapshot, nosha);
  const victimNosha = path.join(tempRoot, 'v-nosha.db');
  fs.copyFileSync(live, victimNosha);
  const noshaRun = runScript(RESTORE_SCRIPT, ['--db', victimNosha, '--from', nosha]);
  expect('缺校验文件时退出码为 1', noshaRun.status === 1, noshaRun.stderr.trim());
  expect(
    '缺校验文件时目标库未被替换',
    JSON.stringify(demoRows(victimNosha)) === JSON.stringify(['alpha', 'beta', 'gamma']),
  );

  const victimNoshaOk = path.join(tempRoot, 'v-nosha-ok.db');
  fs.copyFileSync(live, victimNoshaOk);
  dropDemoTable(victimNoshaOk);
  const noshaOkRun = runScript(RESTORE_SCRIPT, [
    '--db',
    victimNoshaOk,
    '--from',
    nosha,
    '--allow-missing-sha256',
  ]);
  expect(
    '显式 --allow-missing-sha256 后恢复成功',
    noshaOkRun.status === 0,
    noshaOkRun.stderr.trim(),
  );
  expect(
    '恢复后的数据正确',
    JSON.stringify(demoRows(victimNoshaOk)) === JSON.stringify(['alpha', 'beta', 'gamma']),
  );

  // ---------------------------------------------------------------- 场景 4
  section('场景 4：端口有人监听 → 拒绝在服务运行时换库');
  const victimPort = path.join(tempRoot, 'v-port.db');
  fs.copyFileSync(live, victimPort);
  dropDemoTable(victimPort);
  const safetyPortDir = path.join(tempRoot, 'safety-port');
  const { server: busyServer, port: busyPort } = await listenOnFreePort();
  let portRun;
  try {
    portRun = runScript(RESTORE_SCRIPT, [
      '--db',
      victimPort,
      '--from',
      snapshot,
      '--safety-dir',
      safetyPortDir,
      '--port',
      String(busyPort),
    ]);
  } finally {
    await closeServer(busyServer);
  }
  expect('端口被占用时退出码为 1', portRun.status === 1, portRun.stderr.trim());
  expect('端口占用时没有做安全快照', !fs.existsSync(safetyPortDir));
  expect('端口占用时目标库未被替换（demo 表仍不存在）', demoRows(victimPort) === null);

  // ---------------------------------------------------------------- 场景 5
  section('场景 5：正常恢复 + 现场快照保存的是恢复前状态');
  const safetyLiveDir = path.join(tempRoot, 'safety-live');
  dropDemoTable(live);
  const liveRun = runScript(RESTORE_SCRIPT, [
    '--db',
    live,
    '--from',
    snapshot,
    '--safety-dir',
    safetyLiveDir,
  ]);
  expect('正常恢复退出码为 0', liveRun.status === 0, liveRun.stderr.trim());
  expect(
    '恢复后 demo 表与 3 行数据都回来了',
    JSON.stringify(demoRows(live)) === JSON.stringify(['alpha', 'beta', 'gamma']),
  );
  expect('恢复后 sha256 与备份一致', sha256(live) === snapshotDigest);

  const safetyFiles = fs.existsSync(safetyLiveDir)
    ? fs.readdirSync(safetyLiveDir).filter((name) => /^pre-restore-.*\.db$/.test(name))
    : [];
  expect('生成了现场快照', safetyFiles.length === 1, safetyFiles.join(', '));
  if (safetyFiles.length === 1) {
    const safetyPath = path.join(safetyLiveDir, safetyFiles[0]);
    expect('现场快照记录的是恢复前的坏状态（demo 表不存在）', demoRows(safetyPath) === null);
    expect('现场快照自带 .sha256', fs.existsSync(`${safetyPath}.sha256`));
  }
  const restoreLog = path.join(tempRoot, 'restore.log');
  const logLines = fs.existsSync(restoreLog)
    ? fs.readFileSync(restoreLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  const entries = logLines.map((line) => JSON.parse(line));
  // 本目录里成功恢复过两次：场景 3 的 --allow-missing-sha256 与场景 5。
  expect('每次成功恢复都追加一条记录', entries.length === 2, `${entries.length} 行`);
  const entry = entries.find((item) => item.from === snapshot);
  expect(
    '恢复记录包含来源与快照路径',
    Boolean(entry) && entry.result === 'ok' && typeof entry.safety_snapshot === 'string',
  );

  // ---------------------------------------------------------------- 场景 6
  section('场景 6：目标库残留真实 WAL → 恢复后副文件被清理');
  const walDb = path.join(tempRoot, 'wal.db');
  createDemoDb(walDb);
  const walSnapshot = path.join(backupsDir, 'wal-snap.db');
  const walBackup = runScript(BACKUP_SCRIPT, [
    '--db',
    walDb,
    '--out',
    walSnapshot,
    '--sha256',
    `${walSnapshot}.sha256`,
  ]);
  expect('WAL 场景备份成功', walBackup.status === 0, walBackup.stderr.trim());

  leaveRealWal(walDb);
  const hadWal = fs.existsSync(`${walDb}-wal`);
  expect('确实留下了真实 -wal 文件（否则本场景退化为空跑）', hadWal);
  const walRun = runScript(RESTORE_SCRIPT, [
    '--db',
    walDb,
    '--from',
    walSnapshot,
    '--safety-dir',
    path.join(tempRoot, 'safety-wal'),
  ]);
  expect('有残留 WAL 时恢复退出码为 0', walRun.status === 0, walRun.stderr.trim());
  expect('恢复后 -wal 已删除', !fs.existsSync(`${walDb}-wal`));
  expect('恢复后 -shm 已删除', !fs.existsSync(`${walDb}-shm`));
  expect(
    '恢复后数据回到快照时刻（crash-row 不在）',
    JSON.stringify(demoRows(walDb)) === JSON.stringify(['alpha', 'beta', 'gamma']),
  );

  // ---------------------------------------------------------------- 场景 7
  section('场景 7：--verify 只读校验不改主文件，也不留副文件');
  const verifyClean = path.join(tempRoot, 'verify-clean.db');
  fs.copyFileSync(snapshot, verifyClean);
  const verifyDigestBefore = sha256(verifyClean);
  const verifyRun = runScript(BACKUP_SCRIPT, ['--verify', verifyClean]);
  expect('--verify 退出码为 0', verifyRun.status === 0, verifyRun.stderr.trim());
  // 这条是「只读」的硬指标：WAL 库被打开时 SQLite 会写页到 -wal，主文件必须一个字节都不变。
  expect('--verify 没有改动主文件', sha256(verifyClean) === verifyDigestBefore, verifyDigestBefore);
  expect('--verify 没有留下 -wal', !fs.existsSync(`${verifyClean}-wal`));
  expect('--verify 没有留下 -shm', !fs.existsSync(`${verifyClean}-shm`));
  expect(
    '--verify 打印的 sha256 与主文件一致',
    verifyRun.stdout.includes(verifyDigestBefore),
    verifyDigestBefore,
  );

  const verifyKept = path.join(tempRoot, 'verify-kept.db');
  fs.copyFileSync(snapshot, verifyKept);
  // 0 字节的 -wal / -shm 是合法副文件：SQLite 会按“空 WAL”处理并重建内容。
  // 用它们模拟「校验前副文件就已经存在」，验证脚本不会把别人的现场删掉。
  fs.writeFileSync(`${verifyKept}-wal`, '');
  fs.writeFileSync(`${verifyKept}-shm`, '');
  const keptRun = runScript(BACKUP_SCRIPT, ['--verify', verifyKept]);
  expect('预先存在副文件时 --verify 仍能通过', keptRun.status === 0, keptRun.stderr.trim());
  expect('预先存在的 -wal 未被删掉', fs.existsSync(`${verifyKept}-wal`));
  expect('预先存在的 -shm 未被删掉', fs.existsSync(`${verifyKept}-shm`));

  // ---------------------------------------------------------------- 记录
  const failed = results.filter((item) => !item.ok);
  if (writeRecord) {
    fs.mkdirSync(recordDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recordFile = path.join(recordDir, `restore-drill-${stamp}.md`);
    const lines = [
      '# 备份/恢复演练记录',
      '',
      `- 时间：${new Date().toISOString()}`,
      `- 平台：${process.platform} ${process.arch}，Node ${process.version}`,
      '- 范围：临时库（系统临时目录）端到端演练，不涉及真实数据库与 8787。',
      `- 结果：${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}（共 ${results.length} 项断言）`,
      '',
      '| # | 断言 | 结果 | 备注 |',
      '| --- | --- | --- | --- |',
      ...results.map((item, index) => {
        const detail = item.detail.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
        return `| ${index + 1} | ${item.name.replace(/\|/g, '\\|')} | ${item.ok ? 'PASS' : 'FAIL'} | ${detail} |`;
      }),
      '',
      '重跑方式：`node 60-deliver/scripts/tests/restore-drill.mjs`',
      '',
    ];
    fs.writeFileSync(recordFile, `${lines.join('\n')}`, 'utf8');
    console.log(`\n演练记录：${recordFile}`);
  }

  console.log('');
  if (failed.length > 0) {
    console.log(`结果：${results.length - failed.length} 通过，${failed.length} 失败`);
    for (const item of failed) {
      console.log(`   - ${item.name}${item.detail ? `（${item.detail}）` : ''}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`结果：${results.length} 项断言全部通过`);
  }
}

main()
  .catch((error) => {
    console.error(`[drill] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  });
