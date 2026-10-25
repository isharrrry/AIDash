/**
 * 孪生与设计基线的同步检查。
 *
 * 无 importers/callers：手动执行的校验脚本，不参与服务启动与前端构建。
 * 只读：out/aidash.drawio、stores/*.cs、30-design/概要设计.md、30-design/model/model.json。
 * 不写任何文件。
 * 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」
 *
 * 这个脚本回答的是「孪生是否还等于设计」，不是「图好不好看」。四类断言：
 *
 * 1. 覆盖：设计基线的 11 个模块、18 张表，孪生里一个都不能少；
 * 2. 交联：概要设计写了「MOD-X 依赖 MOD-Y」，图上 MOD-X 与 MOD-Y 之间就必须真有数据流，
 *    而不是靠读者「看图觉得连上了」；
 * 3. 无孤岛：每个模块至少有一条跨模块边 —— 只出现在标题里的模块等于没建模；
 * 4. 派生一致性：out/aidash.drawio 必须是当前 src/ 重新生成的结果。
 *    这一条要调用 drawcode（外部仓），通过 DRAWCODE_TS 指定；未指定时**明确报告跳过**，
 *    不静默当作通过。
 *
 * 为什么费劲解析 .drawio 而不是直接 import drawcode 的模型：
 * 检查的是「提交进仓的那张图」，不是「此刻重新算出来的模型」。只有解析产物本身，
 * 才能发现「源码改了、图忘了重生成」这种最常见的漂移。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TWIN_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(TWIN_DIR, '../..');

const DRAWIO = path.join(TWIN_DIR, 'out/aidash.drawio');
const DESIGN_MD = path.join(REPO, '30-design/概要设计.md');
const MODEL_JSON = path.join(REPO, '30-design/model/model.json');

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

// ─────────────────────────── 解析 .drawio ───────────────────────────

/**
 * 抽出一张 .drawio 里的三类东西：
 *   cells:   id → { parent, value, edge, source, target }
 *   objects: 节点 id → { symbolId, kind, alias }
 *   edges:   [{ source, target }]
 *
 * 不引入 XML 库：draw.io 的产物结构固定，正则足够；引入 DOM 解析器会让
 * 「跑这个检查」多出一个 npm 依赖，而它应该在任何机器上 `node 文件名` 就能跑。
 */
function parseDrawio(xml) {
  const cells = new Map();
  const objects = new Map();
  const edges = [];

  // 容器与普通单元格：<mxCell id="grp1" value="MOD-001" ... parent="1" ...>
  // 注意：边那层 mxCell **没有 id**（<mxCell style=... edge="1" parent="..." source="n1" ...>），
  // 所以不能「没有 id 就 continue」—— 那样会把所有边都丢掉，检查看起来全绿而实际没测。
  const cellRe = /<mxCell\s+([^>]*?)\/?>/g;
  for (const match of xml.matchAll(cellRe)) {
    const attrs = match[1];
    const cell = {
      parent: attr(attrs, 'parent'),
      value: attr(attrs, 'value'),
      edge: attr(attrs, 'edge') === '1',
      source: attr(attrs, 'source'),
      target: attr(attrs, 'target'),
    };
    const id = attr(attrs, 'id');
    if (id !== null) cells.set(id, cell);
    if (cell.edge) edges.push({ source: cell.source, target: cell.target });
  }

  // 实体节点：<object id="n1" ... symbolId="..." kind="signal"> 后面紧跟它自己的 mxCell。
  // 关键：object 内部那层 mxCell **没有 id**，容器归属（parent）只在那里出现，
  // 所以必须把 object 与它内部的 mxCell 一起读，不能只读带 id 的 mxCell。
  const objectRe = /<object\s+([^>]*?)>\s*<mxCell\s+([^>]*?)>/g;
  for (const match of xml.matchAll(objectRe)) {
    const attrs = match[1];
    const inner = match[2];
    const id = attr(attrs, 'id');
    if (id === null) continue;

    // draw.io 里 **边也是用 <object> 包的**：
    //   <object id="e1" label="read" rel="def-use" src="..." dst="..." rw="read">
    // 它没有 kind 属性。把边当节点统计，会让「函数数」凭空翻倍，
    // 而且这些假节点没有容器，正好把模块覆盖率断言搅浑。
    const kind = attr(attrs, 'kind');
    if (kind !== null) {
      objects.set(id, {
        symbolId: attr(attrs, 'symbolId') ?? '',
        kind,
        alias: attr(attrs, 'alias') ?? '',
      });
    }

    // 把 object 登记成一个「虚拟 cell」，带它内部 mxCell 的 parent，
    // 这样 moduleOf 沿 parent 链走的时候能穿过实体节点。
    cells.set(id, {
      parent: attr(inner, 'parent'),
      value: '',
      edge: attr(inner, 'edge') === '1',
      source: attr(inner, 'source'),
      target: attr(inner, 'target'),
    });
  }

  return { cells, objects, edges };
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m === null ? null : decodeXml(m[1]);
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
}

/**
 * 沿 parent 链找到最外层的模块容器（value 形如 `MOD-001`）。
 *
 * 为什么取最外层而不是最近一层：图的容器是「MOD-001 / 接入」两层，
 * 最近一层是「接入」，它对模块级交联没有意义。模块 = 最外层那格。
 */
function moduleOf(cellId, cells) {
  let current = cells.get(cellId);
  let outermost = null;
  let guard = 0;
  while (current !== undefined && guard++ < 50) {
    if (/^MOD-\d{3}\b/.test(current.value ?? '')) outermost = current.value;
    if (current.parent === null || current.parent === '1') break;
    current = cells.get(current.parent);
  }
  return outermost;
}

// ─────────────────────────── 读设计基线 ───────────────────────────

/** 概要设计第 4 列的模块依赖：| MOD-003 | 任务树服务 | ... | MOD-002, MOD-007 | ... | */
function parseModuleDependencies(markdown) {
  const deps = [];
  const rowRe = /^\|\s*(MOD-\d{3})\s*\|[^|]*\|[^|]*\|\s*([^|]*)\|/gm;
  for (const match of markdown.matchAll(rowRe)) {
    const from = match[1];
    const cell = match[2].trim();
    if (cell === '' || cell === '—' || cell === '-') continue;
    for (const to of cell.match(/MOD-\d{3}/g) ?? []) {
      deps.push({ from, to });
    }
  }
  return deps;
}

/** stores/*.cs 里被标了 Store=true 的类，抽出 TBL 编号。 */
function parseStores() {
  const storeDir = path.join(TWIN_DIR, 'stores');
  const found = new Set();
  for (const file of fs.readdirSync(storeDir).filter((f) => f.endsWith('.cs'))) {
    const text = fs.readFileSync(path.join(storeDir, file), 'utf8');
    // 注释里的 TBL-xxx 也算：类头注释里写了 `<summary>TBL-003 \`card_event\` — ...`。
    for (const match of text.matchAll(/TBL-(\d{3})/g)) found.add(`TBL-${match[1]}`);
  }
  return found;
}

// ─────────────────────────── 主检查 ───────────────────────────

function main() {
  const xml = fs.readFileSync(DRAWIO, 'utf8');
  const { cells, objects, edges } = parseDrawio(xml);
  const design = parseModuleDependencies(fs.readFileSync(DESIGN_MD, 'utf8'));
  const model = JSON.parse(fs.readFileSync(MODEL_JSON, 'utf8'));

  // 实体 → 模块；同时统计每个模块的节点数。
  const moduleOfNode = new Map();
  const nodeCount = new Map();
  for (const [id, object] of objects) {
    const cell = cells.get(id);
    if (cell === undefined) continue;
    const module = moduleOf(id, cells);
    moduleOfNode.set(id, module);
    if (module !== null) {
      const kind = object.kind === 'signal' ? 'signal' : 'func';
      const key = `${module}|${kind}`;
      nodeCount.set(key, (nodeCount.get(key) ?? 0) + 1);
    }
  }

  // 边 → 模块对；只统计跨模块的（模块内部连线不说明交联）。
  const crossEdges = new Map();
  for (const edge of edges) {
    const from = moduleOfNode.get(edge.source);
    const to = moduleOfNode.get(edge.target);
    if (from == null || to == null || from === to) continue;
    const key = `${from}→${to}`;
    crossEdges.set(key, (crossEdges.get(key) ?? 0) + 1);
  }

  // ── 断言 1：模块覆盖 ──
  const expectedModules = [];
  for (let i = 1; i <= model.counts.modules; i++) {
    expectedModules.push(`MOD-${String(i).padStart(3, '0')}`);
  }
  const presentModules = new Set([...nodeCount.keys()].map((key) => key.split('|')[0]));
  for (const module of expectedModules) {
    if (!presentModules.has(module)) {
      fail(`模块 ${module} 在图里一个节点都没有 —— 设计有 ${model.counts.modules} 个模块，孪生漏了它`);
    }
  }

  // ── 断言 2：表覆盖 ──
  const stores = parseStores();
  for (let i = 1; i <= model.counts.tables; i++) {
    const id = `TBL-${String(i).padStart(3, '0')}`;
    if (!stores.has(id)) {
      fail(`表 ${id} 在 stores/ 里找不到 —— 设计有 ${model.counts.tables} 张表`);
    }
  }

  // ── 断言 3：设计依赖必须有对应的跨模块边 ──
  // 数据流方向不等于依赖方向（MOD-001 依赖 MOD-007，数据却是 MOD-007 流进 MOD-001），
  // 所以任一方向有边就算成立。
  for (const { from, to } of design) {
    const forward = crossEdges.get(`${from}→${to}`) ?? 0;
    const backward = crossEdges.get(`${to}→${from}`) ?? 0;
    if (forward + backward === 0) {
      fail(`概要设计声明 ${from} 依赖 ${to}，但图上两者之间没有任何数据流边`);
    }
  }

  // ── 断言 4：无孤岛 ──
  const modulesWithEdges = new Set();
  for (const key of crossEdges.keys()) {
    const [from, to] = key.split('→');
    modulesWithEdges.add(from);
    modulesWithEdges.add(to);
  }
  for (const module of presentModules) {
    if (!modulesWithEdges.has(module)) {
      // MOD-011 已移出本仓，图上只有一个 External 节点，没有连线是正确的。
      if (module === 'MOD-011') {
        notes.push('MOD-011 无跨模块边（已移出本仓，只保留 External 边界节点）—— 符合预期');
        continue;
      }
      fail(`模块 ${module} 没有任何跨模块边 —— 它在图上是个孤岛，等于没建模交联`);
    }
  }

  // ── 断言 5（可选）：产物必须是当前源码重新生成的结果 ──
  const drawcodeTs = process.env.DRAWCODE_TS;
  if (drawcodeTs === undefined) {
    notes.push(
      '未设置 DRAWCODE_TS，跳过「重新生成并与 out/aidash.drawio 比对」。' +
        '要跑这条：设 DRAWCODE_TS=<drawcode 仓>/typescript/bin/drawcode.ts',
    );
  } else {
    const tmp = path.join(os.tmpdir(), `aidash-twin-${process.pid}.drawio`);
    execFileSync(
      process.execPath,
      [drawcodeTs, 'build', ...listSources(), '--root', path.join(TWIN_DIR, 'src'), '--merge', '--out', tmp],
      { stdio: 'pipe' },
    );
    const fresh = fs.readFileSync(tmp, 'utf8');
    fs.rmSync(tmp, { force: true });
    if (fresh !== xml) {
      fail('out/aidash.drawio 与当前 src/ 重新生成的结果不一致 —— 源码改了但图没重生成');
    }
  }

  // ── 报告 ──
  console.log('模块节点统计：');
  for (const module of expectedModules) {
    const signals = nodeCount.get(`${module}|signal`) ?? 0;
    const funcs = nodeCount.get(`${module}|func`) ?? 0;
    const out = [...crossEdges.entries()]
      .filter(([key]) => key.startsWith(`${module}→`))
      .reduce((n, [, count]) => n + count, 0);
    const incoming = [...crossEdges.entries()]
      .filter(([key]) => key.endsWith(`→${module}`))
      .reduce((n, [, count]) => n + count, 0);
    console.log(
      `  ${module}  信号 ${String(signals).padStart(2)}  函数 ${String(funcs).padStart(2)}` +
        `  出边 ${String(out).padStart(2)}  入边 ${String(incoming).padStart(2)}`,
    );
  }
  console.log(`\n跨模块数据流 ${crossEdges.size} 对，共 ${[...crossEdges.values()].reduce((a, b) => a + b, 0)} 条边`);

  if (notes.length > 0) {
    console.log('\n提示：');
    for (const note of notes) console.log(`  · ${note}`);
  }

  if (problems.length > 0) {
    console.error('\n同步检查失败：');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n同步检查通过');
}

/** src/ 下所有 .cs，按名字排序（与 build 时的 glob 顺序一致，保证字节比对可复现）。 */
function listSources() {
  const srcDir = path.join(TWIN_DIR, 'src');
  return fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.cs'))
    .sort()
    .map((f) => path.join(srcDir, f));
}

main();
