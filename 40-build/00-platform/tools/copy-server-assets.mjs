/**
 * 把服务端运行时需要的非 TS 资产复制进 dist。
 *
 * 为什么需要这一步：tsc 只编译 .ts，不会搬运 .sql。而迁移文件必须在运行时读取
 * （要按版本排序、算 checksum、逐个执行），不能靠 import 打包进去。
 * 如果不复制，编译产物只有在“当前工作目录恰好是仓库根”时才能找到迁移目录，
 * 换到部署目录启动就会报 MIGRATIONS_DIR_NOT_FOUND —— 这是很难在开发机上发现的坑。
 *
 * 设计取舍：
 * - 先清空目标目录再复制，避免重命名/删除迁移后 dist 里残留旧文件；
 * - 只用 node 内置模块，不引入 copy 类依赖（YAGNI）；
 * - 复制完做一次存在性校验，缺 SQL 就让构建直接失败，而不是等到启动时才炸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_DIR = path.join(ROOT, '40-build/10-aidash/src/server/db/migrations');
const DEST_DIR = path.join(ROOT, '40-build/10-aidash/dist/server/db/migrations');

function assertBootstrap() {
  // 000_bootstrap.sql 是 migrate.ts 用来判定“这个目录是不是迁移目录”的锚点。
  if (!fs.existsSync(path.join(SRC_DIR, '000_bootstrap.sql'))) {
    throw new Error(`migrations source missing: ${SRC_DIR}`);
  }
}

function main() {
  assertBootstrap();
  fs.rmSync(DEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DEST_DIR, { recursive: true });

  const files = fs.readdirSync(SRC_DIR).filter((name) => name.endsWith('.sql'));
  for (const name of files) {
    fs.copyFileSync(path.join(SRC_DIR, name), path.join(DEST_DIR, name));
  }

  if (!fs.existsSync(path.join(DEST_DIR, '000_bootstrap.sql'))) {
    throw new Error(`copy verification failed: ${DEST_DIR}`);
  }
  console.log(`[copy-server-assets] ${files.length} SQL file(s) -> ${path.relative(ROOT, DEST_DIR)}`);
}

main();
