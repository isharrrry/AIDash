#!/usr/bin/env node
/**
 * 文件名：三边一致.mjs
 * 作用：检查“需求 ↔ 设计 ↔ 基线模型”三条边是否闭环。
 *
 * 三条边分别回答三个问题：
 *   边 1（需求 → 设计）：需求文档里的每一条，设计里有没有落点？
 *                        没有落点的需求 = 写了但不打算做，是最危险的文档债。
 *   边 2（设计 → 需求）：设计里引用的编号，定义方文档里真的有吗？
 *                        悬空引用会让读者顺着编号找过去，结果扑空。
 *   边 3（文档 ↔ model）：model.json 的版本、计数、定义方路径是否与文档同步？
 *                        model.json 是给检查脚本和后续工具读的，它一旦漂移，
 *                        下游所有自动化都会基于错误事实工作。
 *
 * 与另外两个脚本的分工：
 *   - 文档包自检.mjs      ：包内文件/章节/编号是否越界（单文件视角）
 *   - 结构计数交叉核对.mjs：正文实际数量 vs model.counts（数量视角）
 *   - 本脚本             ：跨文件闭环（关系视角）
 *
 * 设计原理：
 * 1) 范围写法（如 REQ-FN-001~012）必须先展开再比对，
 *    否则“用范围省事”的文档会被误判成大量未覆盖。
 * 2) 定义方 = 该编号“被定义”的那份文档；其余文档视为引用方。
 *    自己引用自己不算悬空，因此只检查非定义方文档。
 * 3) 不联网、不依赖第三方库，Node 20 直接可跑。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../30-design/checks
const DESIGN_ROOT = join(HERE, '..'); // .../30-design
const REPO_ROOT = join(DESIGN_ROOT, '..');
const PACK_DIR = join(DESIGN_ROOT, '设计文档包');
const MODEL_PATH = join(DESIGN_ROOT, 'model', 'model.json');

const SPEC_PATH = join(REPO_ROOT, '20-spec', '需求与验收判据文档.md');
const OVERVIEW_PATH = join(DESIGN_ROOT, '概要设计.md');

const rel = (p) => relative(REPO_ROOT, p).split('\\').join('/');

const problems = [];
const passes = [];
const fail = (msg) => problems.push(msg);
const pass = (msg) => passes.push(msg);

/** 递归收集某个目录下的全部 .md 文件（跳过 node_modules 与 .git） */
function collectMarkdown(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** 转义正则里的特殊字符，前缀虽然不是用户输入，但保持习惯更安全 */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 从文本中提取某个前缀下的全部编号，自动展开范围写法。
 * 支持：REQ-FN-001、REQ-FN-001~012、REQ-FN-001~REQ-FN-012、NF-001~NF-015。
 * 返回 Set<string>（编号已按宽度补零）。
 */
function extractIds(text, prefix, width) {
  const ids = new Set();
  const p = esc(prefix);
  const w = `\\d{${width}}`;

  // 先展开范围：第二个编号前缀可省略（REQ-FN-001~012）
  const rangeRe = new RegExp(
    `\\b${p}-(${w})\\s*[~～至]\\s*(?:${p}-)?(\\d{1,${width}})\\b`,
    'g',
  );
  for (const m of text.matchAll(rangeRe)) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    // 倒序/超长区间视为笔误，不展开；交给人工确认
    if (from <= to && to - from < 200) {
      for (let n = from; n <= to; n += 1) ids.add(String(n).padStart(width, '0'));
    }
  }

  // 再收单个编号（覆盖没有被范围写法包含的那些）
  const singleRe = new RegExp(`\\b${p}-(${w})\\b`, 'g');
  for (const m of text.matchAll(singleRe)) {
    ids.add(String(m[1]).padStart(width, '0'));
  }

  return ids;
}

/**
 * 由 ranges 生成“权威编号全集”。
 *
 * 为什么不用 extractIds 从正文提取定义集合：
 * 正文里除了定义，还会有历史说明。例如 20-spec 写着
 * “V1 的 REQ-FN-001~066 已归档”，若按全文提取，066 会被当成 V2 的需求，
 * 于是覆盖检查永远报“065、066 未覆盖”——这是把注释当数据。
 * ranges 是显式声明的编号空间，用它做定义集合才不会被说明文字污染。
 */
function rangeSet(prefix, width) {
  const [lo, hi] = ranges[prefix] || [];
  if (lo === undefined) return null;
  const set = new Set();
  for (let n = lo; n <= hi; n += 1) set.add(String(n).padStart(width, '0'));
  return set;
}

/** 读取文本；缺失时登记失败并返回 null */
function readOrFail(path, label) {
  if (!existsSync(path)) {
    fail(`缺少${label}：${rel(path)}`);
    return null;
  }
  return readFileSync(path, 'utf8');
}

// ── 读取基线模型 ───────────────────────────────────────────────────────────
if (!existsSync(MODEL_PATH)) {
  console.error(`[FAIL] 缺少基线模型：${rel(MODEL_PATH)}`);
  process.exit(1);
}
const model = JSON.parse(readFileSync(MODEL_PATH, 'utf8'));
const ranges = model.ranges || {};
const counts = model.counts || {};

// ── 读取全部文档 ───────────────────────────────────────────────────────────
const specText = readOrFail(SPEC_PATH, '需求文档');
const overviewText = readOrFail(OVERVIEW_PATH, '概要设计');

const packFiles = collectMarkdown(PACK_DIR);
const designDocs = new Map(); // rel 路径 → 正文
if (overviewText) designDocs.set(rel(OVERVIEW_PATH), overviewText);
for (const f of packFiles) {
  const text = readFileSync(f, 'utf8');
  designDocs.set(rel(f), text);
}

console.log('=== 三边一致检查 ===');

// ── 边 1：需求 → 设计（覆盖）──────────────────────────────────────────────
// 只对“必须以设计落点收尾”的两类做覆盖检查：
//   REQ-FN（功能需求）、NF（非功能需求）。
// XIF 是外部接口清单、DQ 是裁决台账，它们不要求逐条出现在设计正文里。
if (specText) {
  const COVERAGE = [
    { prefix: 'REQ-FN', width: 3, label: '功能需求' },
    { prefix: 'NF', width: 3, label: '非功能需求' },
  ];

  for (const c of COVERAGE) {
    // 定义集合取 ranges，而不是从正文提取：正文里的历史说明会引入不存在的编号
    const defined = rangeSet(c.prefix, c.width);
    if (defined === null) {
      fail(`边 1：model.ranges 缺少 ${c.prefix}`);
      continue;
    }
    // 设计侧引用 = 概要设计 + 文档包全部文档的并集
    const referenced = new Set();
    for (const text of designDocs.values()) {
      for (const id of extractIds(text, c.prefix, c.width)) referenced.add(id);
    }

    const uncovered = [...defined].filter((id) => !referenced.has(id)).sort();
    if (uncovered.length === 0) {
      pass(`边 1：${c.label} ${defined.size}/${defined.size} 条在设计中有落点`);
    } else {
      // 只列前 15 个，避免一次刷屏；总数仍然准确
      const shown = uncovered.slice(0, 15).join('、');
      const more = uncovered.length > 15 ? `…等 ${uncovered.length} 条` : '';
      fail(`边 1：${c.label} 有 ${uncovered.length} 条未在设计中出现：${shown}${more}`);
    }
  }
}

// ── 边 2：设计 → 定义方（不悬空）──────────────────────────────────────────
// 每个前缀指定唯一定义方；引用方 = 其余文档。
const OWNERS = [
  { prefix: 'REQ-FN', width: 3, owner: SPEC_PATH, label: '需求' },
  { prefix: 'NF', width: 3, owner: SPEC_PATH, label: '非功能需求' },
  { prefix: 'XIF', width: 3, owner: SPEC_PATH, label: '外部接口' },
  { prefix: 'DQ', width: 3, owner: SPEC_PATH, label: '设计裁决' },
  { prefix: 'ADR', width: 3, owner: OVERVIEW_PATH, label: 'ADR' },
  { prefix: 'MOD', width: 3, owner: OVERVIEW_PATH, label: '模块' },
  { prefix: 'R', width: 3, owner: OVERVIEW_PATH, label: '风险' },
  { prefix: 'SYS', width: 2, owner: join(PACK_DIR, '02-系统-子系统设计说明.md'), label: '系统' },
  { prefix: 'SM', width: 3, owner: join(PACK_DIR, '03-软件设计说明.md'), label: '状态机' },
  { prefix: 'MCP', width: 3, owner: join(PACK_DIR, '04-接口设计说明.md'), label: 'MCP 工具' },
  { prefix: 'TBL', width: 3, owner: join(PACK_DIR, '05-数据库设计说明.md'), label: '数据表' },
  { prefix: 'SCR', width: 2, owner: join(PACK_DIR, '界面设计说明.md'), label: '界面' },
  { prefix: 'GAP', width: 2, owner: join(PACK_DIR, '界面设计说明.md'), label: '界面缺口' },
  { prefix: 'SAFE', width: 3, owner: join(PACK_DIR, '06-安全性设计支撑材料.md'), label: '安全性要求' },
];

// 引用方文档 = 需求文档 + 30-design 下全部 md（定义方本身除外）
const allDocs = new Map(designDocs);
if (specText) allDocs.set(rel(SPEC_PATH), specText);

let danglingTotal = 0;

for (const o of OWNERS) {
  if (!allDocs.has(rel(o.owner))) {
    // 定义方缺失已在读取阶段报过；这里跳过，避免重复噪音
    continue;
  }
  // 定义集合同样取 ranges：编号空间是显式声明的，不是从文字里猜的
  const defined = rangeSet(o.prefix, o.width);
  if (defined === null) {
    fail(`边 2：model.ranges 缺少 ${o.prefix}`);
    continue;
  }

  for (const [docPath, text] of allDocs) {
    if (docPath === rel(o.owner)) continue; // 自己引用自己不算悬空
    const referenced = extractIds(text, o.prefix, o.width);
    const dangling = [...referenced].filter((id) => !defined.has(id)).sort();
    if (dangling.length > 0) {
      danglingTotal += dangling.length;
      fail(
        `边 2：${docPath} 引用了 ${o.label} ${dangling.join('、')}，但 ${rel(o.owner)} 中没有定义`,
      );
    }
  }
}

if (danglingTotal === 0) pass(`边 2：全部跨文件引用都能在定义方找到（${OWNERS.length} 类编号）`);

// ── 边 3：文档 ↔ model.json ────────────────────────────────────────────────
// 3.1 版本：三份“头部文档”的 V2.0 必须与 model.doc_version 一致
const VERSION = model.doc_version;
if (VERSION) {
  const versionTargets = [
    ['20-spec', SPEC_PATH, specText],
    ['概要设计', OVERVIEW_PATH, overviewText],
  ];
  let versionOk = true;
  for (const [label, , text] of versionTargets) {
    if (text === null) continue;
    // 版本号允许出现在前 20 行（文档头通常有标题、版本、日期三行）
    const head = text.split(/\r?\n/).slice(0, 20).join('\n');
    if (!head.includes(VERSION)) {
      versionOk = false;
      fail(`边 3：${label} 头部未出现 model.doc_version=${VERSION}`);
    }
  }
  if (versionOk) pass(`边 3：文档版本头与 model.doc_version=${VERSION} 一致`);
} else {
  fail('边 3：model.json 缺少 doc_version');
}

// 3.2 计数与范围跨度必须自洽（两个字段都手写，容易改一漏一）
const COUNT_TO_PREFIX = {
  requirements: 'REQ-FN',
  acceptance: 'ACC',
  nonFunctional: 'NF',
  externalInterfaces: 'XIF',
  decisions: 'DQ',
  adrs: 'ADR',
  modules: 'MOD',
  risks: 'R',
  stateMachines: 'SM',
  tables: 'TBL',
  mcpTools: 'MCP',
  systems: 'SYS',
  screens: 'SCR',
  gaps: 'GAP',
  safety: 'SAFE',
};

let spanMismatch = 0;
for (const [key, prefix] of Object.entries(COUNT_TO_PREFIX)) {
  const [lo, hi] = ranges[prefix] || [];
  if (lo === undefined || counts[key] === undefined) {
    spanMismatch += 1;
    fail(`边 3：model.json 缺少 ${key} 或 ${prefix} 的计数/范围声明`);
    continue;
  }
  if (hi - lo + 1 !== counts[key]) {
    spanMismatch += 1;
    fail(`边 3：${key}=${counts[key]} 与 ${prefix} 范围 ${lo}~${hi} 不一致`);
  }
}
if (spanMismatch === 0) pass(`边 3：model.counts 与 model.ranges 全部自洽（${Object.keys(COUNT_TO_PREFIX).length} 类）`);

// 3.3 definitionOwners 指向的文件必须真实存在
const owners = model.definitionOwners || {};
let ownerMissing = 0;
for (const [prefix, path] of Object.entries(owners)) {
  const abs = join(REPO_ROOT, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    ownerMissing += 1;
    fail(`边 3：definitionOwners.${prefix} 指向不存在的文件 ${path}`);
  }
}
if (ownerMissing === 0) pass(`边 3：definitionOwners 的 ${Object.keys(owners).length} 个路径全部存在`);

// ── 输出 ───────────────────────────────────────────────────────────────────
for (const line of passes) console.log(`  [OK] ${line}`);

if (problems.length === 0) {
  console.log(`\n结果：三边一致（${passes.length} 项）`);
  process.exit(0);
}

console.log('');
for (const line of problems) console.log(`  [FAIL] ${line}`);
console.log(`\n结果：${problems.length} 项不一致，${passes.length} 项通过`);
process.exit(1);
