#!/usr/bin/env node
/**
 * 文件名：结构计数交叉核对.mjs
 * 作用：用文档正文里“实际出现的编号”反推数量，与 model.json 声明的 counts 对账。
 *
 * 为什么需要这个脚本：
 * 设计文档最容易出的错不是写错内容，而是“声明改了、正文没跟上”。
 * 例如 model.json 写 19 个 MCP 工具，04 文档里实际只写了 18 个——
 * 这种错在人工评审时几乎看不出来，但会让实现方漏掉一个接口。
 * 所以这里不看文档“说”自己有多少，而是去数它“实际”有多少。
 *
 * 设计原理：
 * 1) 只认固定宽度的编号（三位 / SYS 两位），避免 V1 遗留的两位编号（如 DQ-13）混入；
 * 2) 用 Set 去重：同一个编号在索引表、正文、追踪表里出现多次是正常的；
 * 3) 同时校验 counts 与 ranges 自洽——两个字段都是手写的，必须互相印证；
 * 4) 报错时列出“缺哪个、多哪个”，而不是只报数字差，让修复成本降到最低。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_DIR = join(HERE, '..');
const REPO_ROOT = join(PACK_DIR, '..', '..');
const MODEL_PATH = join(REPO_ROOT, '30-design', 'model', 'model.json');

const model = JSON.parse(readFileSync(MODEL_PATH, 'utf8'));
const counts = model.counts || {};
const ranges = model.ranges || {};

const DOC = {
  spec: join(REPO_ROOT, '20-spec', '需求与验收判据文档.md'),
  overview: join(REPO_ROOT, '30-design', '概要设计.md'),
  d02: join(PACK_DIR, '02-系统-子系统设计说明.md'),
  d03: join(PACK_DIR, '03-软件设计说明.md'),
  d04: join(PACK_DIR, '04-接口设计说明.md'),
  d05: join(PACK_DIR, '05-数据库设计说明.md'),
  d06: join(PACK_DIR, '06-安全性设计支撑材料.md'),
  d07: join(PACK_DIR, '07-质量记录包.md'),
  dUI: join(PACK_DIR, '界面设计说明.md'),
};

const rel = (p) => relative(REPO_ROOT, p).split('\\').join('/');

const problems = [];
const passes = [];
const fail = (msg) => problems.push(msg);
const pass = (msg) => passes.push(msg);

function readDoc(path) {
  if (!existsSync(path)) {
    fail(`文档缺失：${rel(path)}`);
    return null;
  }
  return readFileSync(path, 'utf8');
}

const texts = Object.fromEntries(
  Object.entries(DOC).map(([key, path]) => [key, readDoc(path)]),
);

/**
 * 统计一段文本里某个前缀下的唯一编号集合。
 * @param {string} text 正文
 * @param {RegExp} re 必须带 g 标志、带一个捕获组
 * @param {number} width 数字宽度（3 或 2）
 */
function collectIds(text, re, width) {
  const set = new Set();
  re.lastIndex = 0; // g 正则有状态，复用前必须归零
  let m;
  while ((m = re.exec(text)) !== null) {
    set.add(String(m[1]).padStart(width, '0'));
  }
  return set;
}

/** 由 ranges 生成“期望编号全集”，用于计算缺失与多余 */
function expectedSet(prefix, width) {
  const [lo, hi] = ranges[prefix] || [];
  if (lo === undefined) return null;
  const set = new Set();
  for (let n = lo; n <= hi; n += 1) set.add(String(n).padStart(width, '0'));
  return set;
}

// ── 核对表：每个条目说明“哪个计数、去哪份文档数、用什么前缀数” ──────────────
const CHECKS = [
  { key: 'requirements', label: '功能需求', prefix: 'REQ-FN', width: 3, doc: 'spec' },
  { key: 'acceptance', label: '验收准则', prefix: 'ACC', width: 3, doc: 'spec' },
  { key: 'nonFunctional', label: '非功能需求', prefix: 'NF', width: 3, doc: 'spec' },
  { key: 'externalInterfaces', label: '外部接口', prefix: 'XIF', width: 3, doc: 'spec' },
  { key: 'decisions', label: '设计裁决', prefix: 'DQ', width: 3, doc: 'spec' },
  { key: 'adrs', label: '架构决策', prefix: 'ADR', width: 3, doc: 'overview' },
  { key: 'modules', label: '模块', prefix: 'MOD', width: 3, doc: 'overview' },
  { key: 'risks', label: '风险', prefix: 'R', width: 3, doc: 'overview' },
  { key: 'stateMachines', label: '状态机', prefix: 'SM', width: 3, doc: 'd03' },
  { key: 'tables', label: '数据表', prefix: 'TBL', width: 3, doc: 'd05' },
  { key: 'mcpTools', label: 'MCP 工具', prefix: 'MCP', width: 3, doc: 'd04' },
  { key: 'systems', label: '系统', prefix: 'SYS', width: 2, doc: 'd02' },
  { key: 'screens', label: '界面', prefix: 'SCR', width: 2, doc: 'dUI' },
  { key: 'gaps', label: '界面缺口', prefix: 'GAP', width: 2, doc: 'dUI' },
  { key: 'safety', label: '安全性要求', prefix: 'SAFE', width: 3, doc: 'd06' },
];

// 前缀 → 正则（与 CHECKS 的前缀一一对应）
const RES = {
  'REQ-FN': /\bREQ-FN-(\d{3})\b/g,
  ACC: /\bACC-(\d{3})\b/g,
  NF: /\bNF-(\d{3})\b/g,
  XIF: /\bXIF-(\d{3})\b/g,
  DQ: /\bDQ-(\d{3})\b/g,
  ADR: /\bADR-(\d{3})\b/g,
  MOD: /\bMOD-(\d{3})\b/g,
  R: /\bR-(\d{3})\b/g,
  SM: /\bSM-(\d{3})\b/g,
  TBL: /\bTBL-(\d{3})\b/g,
  MCP: /\bMCP-(\d{3})\b/g,
  SYS: /\bSYS-(\d{2})\b/g,
  SCR: /\bSCR-(\d{2})\b/g,
  GAP: /\bGAP-(\d{2})\b/g,
  SAFE: /\bSAFE-(\d{3})\b/g,
};

console.log('=== 结构计数交叉核对 ===');

// ── 第 0 步：counts 与 ranges 必须自洽（两者都是手写，容易改一个忘另一个）──
for (const c of CHECKS) {
  const declared = counts[c.key];
  const [lo, hi] = ranges[c.prefix] || [];
  if (declared === undefined) {
    fail(`model.json 的 counts 缺少字段 ${c.key}`);
    continue;
  }
  if (lo === undefined) {
    fail(`model.json 的 ranges 缺少前缀 ${c.prefix}`);
    continue;
  }
  const span = hi - lo + 1;
  if (span !== declared) {
    fail(`model.json 自相矛盾：${c.key}=${declared}，但 ${c.prefix} 范围 ${lo}~${hi} 共 ${span} 个`);
  }
}

// ── 第 1 步：逐项数正文，与 counts 对账 ────────────────────────────────────
for (const c of CHECKS) {
  const text = texts[c.doc];
  if (text === null) continue; // 文件缺失已在 readDoc 里报过，不重复报

  const actual = collectIds(text, RES[c.prefix], c.width);
  const declared = counts[c.key];
  const expected = expectedSet(c.prefix, c.width);

  if (actual.size === declared) {
    pass(`${c.key} = ${declared}（${rel(DOC[c.doc])} 实测一致）`);
    continue;
  }

  // 数量不一致时，进一步定位到具体编号，避免读者再翻一遍文档
  const missing = expected ? [...expected].filter((id) => !actual.has(id)) : [];
  const extra = expected ? [...actual].filter((id) => !expected.has(id)) : [];

  const detail = [];
  if (missing.length) detail.push(`缺少 ${missing.join('、')}`);
  if (extra.length) detail.push(`多出 ${extra.join('、')}`);
  fail(
    `${c.key}：model.json 声明 ${declared}，${rel(DOC[c.doc])} 实测 ${actual.size}` +
      (detail.length ? `（${detail.join('；')}）` : ''),
  );
}

// ── 第 2 步：输出 ──────────────────────────────────────────────────────────
for (const line of passes) console.log(`  [OK] ${line}`);

if (problems.length === 0) {
  console.log(`\n结果：${CHECKS.length} 项计数全部一致`);
  process.exit(0);
}

console.log('');
for (const line of problems) console.log(`  [FAIL] ${line}`);
console.log(`\n结果：${problems.length} 项不一致，${passes.length} 项一致`);
process.exit(1);
