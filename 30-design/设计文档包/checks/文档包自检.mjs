#!/usr/bin/env node
/**
 * 文件名：文档包自检.mjs
 * 作用：检查 AIDash 设计文档包（30-design/设计文档包）的结构完整性。
 *
 * 设计原理：
 * 1) 文档包的价值在于“任何一条设计结论都能被机器找到并核对”。所以检查分三层：
 *    - 存在层：文件在不在；
 *    - 结构层：关键章节在不在（风险索引、状态机完整转移表）；
 *    - 编号层：引用到的编号有没有越界（防止复制粘贴导致编号漂移）。
 * 2) 不引入第三方依赖：检查工具要能在任何装了 Node 20 的机器上直接跑，
 *    避免“检查工具本身装不上”这种低级阻塞。
 * 3) 退出码是唯一契约：0 = 通过，1 = 有问题。CI 只需要看退出码。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 路径定位：以脚本自身位置为锚，避免依赖调用者的当前工作目录 ──────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_DIR = join(HERE, '..');
const REPO_ROOT = join(PACK_DIR, '..', '..');
const MODEL_PATH = join(REPO_ROOT, '30-design', 'model', 'model.json');

// ── 编号工具：所有编号都是“前缀 + 固定宽度数字”，宽度不一致会导致排序错乱 ──
const pad = (n, width) => String(n).padStart(width, '0');
const seq3 = (prefix, from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${pad(from + i, 3)}`);
const seq2 = (prefix, from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${pad(from + i, 2)}`);

const model = JSON.parse(readFileSync(MODEL_PATH, 'utf8'));
const ranges = model.ranges || {};

const problems = [];
const passes = [];
const fail = (msg) => problems.push(msg);
const pass = (msg) => passes.push(msg);

/** 读取文件；不存在时返回 null，由调用方决定是报错还是跳过 */
function tryRead(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** 把绝对路径转成仓库内相对路径，报错信息才对读者友好 */
function rel(path) {
  return relative(REPO_ROOT, path).split('\\').join('/');
}

// ── 1. 包内文件清单：顺序即阅读顺序，README 固定收尾 ───────────────────────
const PACK_FILES = [
  { id: '01', name: '01-设计总纲与设计基线管理.md' },
  { id: '02', name: '02-系统-子系统设计说明.md' },
  { id: '03', name: '03-软件设计说明.md' },
  { id: '04', name: '04-接口设计说明.md' },
  { id: '05', name: '05-数据库设计说明.md' },
  { id: '06', name: '06-安全性设计支撑材料.md' },
  { id: '07', name: '07-质量记录包.md' },
  { id: 'UI', name: '界面设计说明.md' },
  { id: 'README', name: 'README-核心包.md' },
];

const texts = new Map(); // 文件相对路径 → 正文，后续检查复用，避免重复读盘

for (const f of PACK_FILES) {
  const abs = join(PACK_DIR, f.name);
  const text = tryRead(abs);
  if (text === null) {
    fail(`缺少包内文件：${f.name}`);
    continue;
  }
  texts.set(rel(abs), text);

  // 版本头检查只看前 12 行：防止正文里偶然提到 V2.0 被误判成“有版本头”
  const head = text.split(/\r?\n/).slice(0, 12).join('\n');
  if (!head.includes('V2.0')) {
    fail(`${f.name}：前 12 行未找到版本号 V2.0`);
  } else {
    pass(`${f.name} 存在且带 V2.0 版本头`);
  }
}

// ── 2. 权威章节：这两个章节是“设计与追踪”的锚点，缺了就等于断了链 ──────────
/** 检查“某个标题行存在”（允许标题后缀，如“### 4.4 风险索引（R-001~R-020）”）。 */
function requireHeading(text, fileLabel, prefix) {
  const lines = text.split(/\r?\n/);
  const hit = lines.some((line) => line.startsWith(prefix));
  if (hit) pass(`${fileLabel} 含章节「${prefix}」`);
  else fail(`${fileLabel} 缺少章节「${prefix}」`);
  return hit;
}

/** 检查一组编号是否全部出现（全文搜索，因为编号可能散落在表格与正文里）。 */
function requireIds(text, fileLabel, ids) {
  const missing = ids.filter((id) => !text.includes(id));
  if (missing.length === 0) {
    pass(`${fileLabel} 编号齐全（${ids.length} 个：${ids[0]}~${ids[ids.length - 1]}）`);
  } else {
    fail(`${fileLabel} 缺少编号：${missing.join('、')}`);
  }
}

const t01 = texts.get('30-design/设计文档包/01-设计总纲与设计基线管理.md');
if (t01) {
  requireHeading(t01, '01', '### 4.4 风险索引');
  requireIds(t01, '01 §4.4', seq3('R', ranges.R[0], ranges.R[1]));
}

const t03 = texts.get('30-design/设计文档包/03-软件设计说明.md');
if (t03) {
  requireHeading(t03, '03', '### 4.4 状态机设计');
  requireIds(t03, '03 §4.4 状态机', seq3('SM', ranges.SM[0], ranges.SM[1]));
  // 转移 ID 的编号空间由 03 自行定义（T-/C-/H-/CH-），不在 model.ranges 里，
  // 所以这里写死数量：数量变了说明转移表被悄悄改过，必须人工确认。
  requireIds(t03, '03 §4.4 任务转移', seq3('T', 1, 19));
  requireIds(t03, '03 §4.4 卡片转移', seq3('C', 1, 9));
  requireIds(t03, '03 §4.4 Harness 转移', seq3('H', 101, 107));
  requireIds(t03, '03 §4.4 通道转移', seq2('CH', 1, 5));
}

const t02 = texts.get('30-design/设计文档包/02-系统-子系统设计说明.md');
if (t02) requireIds(t02, '02', seq2('SYS', ranges.SYS[0], ranges.SYS[1]));

const t04 = texts.get('30-design/设计文档包/04-接口设计说明.md');
if (t04) requireIds(t04, '04', seq3('MCP', ranges.MCP[0], ranges.MCP[1]));

const t05 = texts.get('30-design/设计文档包/05-数据库设计说明.md');
if (t05) requireIds(t05, '05', seq3('TBL', ranges.TBL[0], ranges.TBL[1]));

const t06 = texts.get('30-design/设计文档包/06-安全性设计支撑材料.md');
if (t06) requireIds(t06, '06 §2 安全性要求', seq3('SAFE', ranges.SAFE[0], ranges.SAFE[1]));

const tUI = texts.get('30-design/设计文档包/界面设计说明.md');
if (tUI) {
  requireIds(tUI, '界面 §1 界面清单', seq2('SCR', ranges.SCR[0], ranges.SCR[1]));
  requireIds(tUI, '界面 §7.3 缺口清单', seq2('GAP', ranges.GAP[0], ranges.GAP[1]));
}

// ── 3. 编号越界：扫描全部活跃文档，任何出现的编号都必须落在 ranges 内 ──────
// 只扫活跃基线（20-spec + 30-design），90-archive 里的历史编号不参与，
// 否则归档文档里的 V1 编号会被误报成“越界”。
const ACTIVE_DOCS = [
  join(REPO_ROOT, '20-spec', '需求与验收判据文档.md'),
  join(REPO_ROOT, '30-design', '概要设计.md'),
  ...PACK_FILES.map((f) => join(PACK_DIR, f.name)),
];

// 前缀 → 正则。注意 SYS 是两位编号，其余是三位；宽度不一致必须分开写，
// 否则 SYS-01 会被当成 SYS-010 一类而误判。
const PREFIX_RULES = [
  { label: 'REQ-FN', re: /\bREQ-FN-(\d{3})\b/g },
  { label: 'ACC', re: /\bACC-(\d{3})\b/g },
  { label: 'NF', re: /\bNF-(\d{3})\b/g },
  { label: 'XIF', re: /\bXIF-(\d{3})\b/g },
  { label: 'DQ', re: /\bDQ-(\d{3})\b/g },
  { label: 'ADR', re: /\bADR-(\d{3})\b/g },
  { label: 'MOD', re: /\bMOD-(\d{3})\b/g },
  { label: 'SM', re: /\bSM-(\d{3})\b/g },
  { label: 'TBL', re: /\bTBL-(\d{3})\b/g },
  { label: 'MCP', re: /\bMCP-(\d{3})\b/g },
  { label: 'R', re: /\bR-(\d{3})\b/g },
  { label: 'SYS', re: /\bSYS-(\d{2})\b/g },
  { label: 'SCR', re: /\bSCR-(\d{2})\b/g },
  { label: 'GAP', re: /\bGAP-(\d{2})\b/g },
  { label: 'SAFE', re: /\bSAFE-(\d{3})\b/g },
];

let outOfRangeCount = 0;

for (const abs of ACTIVE_DOCS) {
  const text = tryRead(abs);
  if (text === null) {
    fail(`活跃文档缺失：${rel(abs)}`);
    continue;
  }

  for (const rule of PREFIX_RULES) {
    const [lo, hi] = ranges[rule.label] || [];
    if (lo === undefined) continue; // ranges 没声明的前缀不检查（如 T-/C-/H-）

    // 正则带 g 标志且有状态，复用前必须重置 lastIndex，否则第二次匹配从上次位置开始
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (n < lo || n > hi) {
        outOfRangeCount += 1;
        const line = text.slice(0, m.index).split(/\r?\n/).length;
        fail(`${rel(abs)}:${line} 编号 ${rule.label}-${m[1]} 越界（允许 ${lo}~${hi}）`);
      }
    }
  }
}

if (outOfRangeCount === 0) pass(`活跃文档编号全部在 model.ranges 内（${ACTIVE_DOCS.length} 个文件）`);

// ── 4. 汇总输出 ────────────────────────────────────────────────────────────
console.log('=== 文档包自检 ===');
for (const line of passes) console.log(`  [OK] ${line}`);

if (problems.length === 0) {
  console.log(`\n结果：全部通过（${passes.length} 项）`);
  process.exit(0);
}

console.log('');
for (const line of problems) console.log(`  [FAIL] ${line}`);
console.log(`\n结果：${problems.length} 项失败，${passes.length} 项通过`);
process.exit(1);
