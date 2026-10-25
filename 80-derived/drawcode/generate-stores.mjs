/**
 * 从数据库设计说明生成孪生的持久化类型（drawcode 的 Store=true）。
 *
 * 无 importers/callers：手动执行的构建脚本，不参与服务启动与前端构建。
 * 输入只读：30-design/设计文档包/05-数据库设计说明.md。
 * 输出只写：80-derived/drawcode/stores/*.cs（本脚本的产物）。
 * 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」
 *
 * 为什么要生成而不是手写：
 * 18 张表约 200 个字段，手抄一遍必然和 DDL 对不上；而对不上的那几列，
 * 恰好是「孪生图看着没问题、实际早就不等于设计」的典型。生成 + 重跑，
 * 让「设计改了、孪生没跟上」变成一条命令就能发现的事。
 *
 * 为什么生成 class 而不是 record：
 * drawcode 的 C# 解析器会整段跳过 record 声明（csparse.ts 的 RECORD_DECL_RE），
 * 用 record 写出来的 Store 类型在模型里会彻底消失，Store=true 的 ER 视图就空了。
 * 这些类的字段没有 Direction 特性，因此不会变成信号、不会出现在交联图上 ——
 * 「持久化数据」和「跨模块流动的数据」在模型里是两件事。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const DDL_DOC = path.join(REPO, '30-design/设计文档包/05-数据库设计说明.md');
const OUT_DIR = path.join(HERE, 'stores');

/** 每张表归到哪个文件；按域分组，便于人工翻看。 */
const GROUPS = [
  { file: 'Store001To006CardTask.cs', from: 1, to: 6, title: '通道 / 卡片 / 任务三域的表' },
  { file: 'Store007To009HarnessKb.cs', from: 7, to: 9, title: 'Harness 与知识库' },
  { file: 'Store010To012AuditConfig.cs', from: 10, to: 12, title: '审计、配置快照与迁移记录' },
  { file: 'Store013To018MemoryReport.cs', from: 13, to: 18, title: '记忆与汇报' },
];

/** SQL 列类型 → C# 类型。只覆盖 DDL 里实际出现的几种，出现未知类型直接报错。 */
const TYPE_MAP = {
  TEXT: 'string',
  INTEGER: 'long',
  REAL: 'double',
  BLOB: 'byte[]',
};

/**
 * 解析一份 DDL 文本里的 CREATE TABLE 块。
 *
 * 只认顶层逗号分隔的列定义；PRIMARY KEY / FOREIGN KEY / UNIQUE / CHECK / CONSTRAINT
 * 这些「约束行」一律跳过 —— 它们不是列，写进 C# 会变成不存在的属性。
 */
function parseColumns(ddl, { fts = false } = {}) {
  const columns = [];
  // 先把注释剥掉再找列：列名后面可能跟 `-- 说明`，注释里的逗号会干扰切分。
  const lines = ddl.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('--')) continue;
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
    // fts5 的选项行（tokenize = 'unicode61'）不是列。
    if (/^[a-z_]+\s*=/i.test(line)) continue;

    if (fts) {
      // FTS5 虚表的列只有名字没有类型（title, description, ...）；取首个标识符即可。
      const nameOnly = /^([a-z_][a-z0-9_]*)\s*,?$/i.exec(line);
      if (nameOnly === null) continue;
      columns.push({
        name: nameOnly[1],
        // FTS 的列都可空：文档缺 description 是正常情况。
        csharp: 'string?',
        notNull: false,
        comment: 'FTS5 虚表列（无 SQL 类型，按 TEXT 处理）',
      });
      continue;
    }

    // 列定义：<名字> <类型>[约束...]，以逗号结尾（最后一行可能没有逗号）
    const m = /^([a-z_][a-z0-9_]*)\s+([A-Z][A-Z0-9_]*)(\([^)]*\))?(.*?)(,)?$/i.exec(line);
    if (!m) continue;

    const [, name, sqlType, , rest] = m;
    const base = sqlType.toUpperCase();
    const csharp = TYPE_MAP[base];
    if (csharp === undefined) {
      throw new Error(`未知的列类型 ${sqlType}（列 ${name}）—— 请在 TYPE_MAP 里补一条映射`);
    }

    // 主键隐含非空；NOT NULL 显式声明非空。其余列可能为 null。
    const notNull = /\bNOT\s+NULL\b/i.test(rest) || /\bPRIMARY\s+KEY\b/i.test(rest);
    // 行尾 `-- 说明` 作为字段注释。
    const commentMatch = /--\s*(.+)$/.exec(rest) ?? /--\s*(.+)$/.exec(raw);
    columns.push({
      name,
      csharp: notNull ? csharp : `${csharp}?`,
      notNull,
      comment: commentMatch === null ? '' : commentMatch[1].trim(),
    });
  }
  return columns;
}

/**
 * 从设计文档里抽出全部表：### 3.x TBL-xxx `表名` — 说明 + 紧随其后的 ```sql 块。
 *
 * 不用「全文找到所有 CREATE TABLE」的简化做法：那样拿不到 TBL 编号与中文说明，
 * 而这两样正是孪生要跟设计基线对齐的东西。
 */
function parseTables(markdown) {
  const tables = [];
  // 标题行：### 3.1 TBL-001 `channel` — 会话通道
  const headingRe = /^###\s+3\.\d+\s+(TBL-\d{3})\s+`([^`]+)`\s*[—-]\s*(.+)$/gm;
  const headings = [...markdown.matchAll(headingRe)];

  headings.forEach((heading, i) => {
    const start = heading.index + heading[0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : markdown.length;
    const section = markdown.slice(start, end);
    const sqlBlock = /```sql\s*\n([\s\S]*?)```/.exec(section);
    if (sqlBlock === null) {
      throw new Error(`${heading[1]} 小节里找不到 sql 代码块`);
    }
    // 有些小节里后续还有别的 sql 块（索引），只取第一个 CREATE TABLE。
    // TBL-009 是 FTS5 虚表：CREATE VIRTUAL TABLE ... USING fts5(...)，列没有 SQL 类型。
    const virtualTable = /CREATE\s+VIRTUAL\s+TABLE\s+([a-z_][a-z0-9_]*)\s+USING\s+fts5\s*\(([\s\S]*?)\n\);/.exec(
      sqlBlock[1],
    );
    const createTable =
      virtualTable ??
      /CREATE\s+TABLE\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/.exec(sqlBlock[1]);
    if (createTable === null) {
      throw new Error(`${heading[1]} 的 sql 块里找不到 CREATE TABLE`);
    }
    tables.push({
      id: heading[1],
      sqlName: createTable[1],
      title: heading[3].trim(),
      columns: parseColumns(createTable[2], { fts: virtualTable !== null }),
    });
  });

  return tables;
}

/**
 * C# 关键字：DDL 里的列名直接搬过来会撞上，例如 TBL-003/TBL-005 都有 `event` 列。
 * 用 @ 前缀转义，同时保证生成物能编译。
 * 注意 drawcode 的字段正则不认 `@`，所以这类列在模型里看不到 —— 但它们本来就没有
 * Direction，不是信号，不进交联图；缺失只影响 ER 视图的这一列，不影响构件可编译性。
 */
const CSHARP_KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked',
  'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else',
  'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for',
  'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock',
  'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params',
  'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short',
  'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual',
  'void', 'volatile', 'while',
]);

/** 列名 → 可编译的 C# 标识符。 */
function fieldName(name) {
  return CSHARP_KEYWORDS.has(name) ? `@${name}` : name;
}

/** TBL-001 `channel` → Store001Channel */
function className(table) {
  const num = table.id.slice(4); // '001'
  const pascal = table.sqlName
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `Store${num}${pascal}`;
}

function renderClass(table) {
  const lines = [];
  lines.push(`/// <summary>${table.id} \`${table.sqlName}\` — ${table.title}</summary>`);
  lines.push('[Drawcode(Store = true)]');
  lines.push(`public sealed class ${className(table)}`);
  lines.push('{');
  for (const col of table.columns) {
    if (col.comment !== '') lines.push(`    /// <summary>${col.comment}</summary>`);
    // 非空 string 必须给初值，否则 nullable 下 CS8618；数值类型默认 0 无需初始化。
    // 分号统一在模板里加 —— 曾经把分号写进 init 里，非空字段有、可空字段没有，
    // 生成了一堆编译不过的声明，而脚本本身不报错（它只负责拼字符串）。
    const init = col.csharp === 'string' ? ' = string.Empty' : '';
    lines.push(`    public ${col.csharp} ${fieldName(col.name)}${init};`);
    lines.push('');
  }
  lines.push('}');
  return lines.join('\n');
}

function main() {
  const markdown = fs.readFileSync(DDL_DOC, 'utf8');
  const tables = parseTables(markdown);

  if (tables.length !== 18) {
    throw new Error(`设计文档里解析出 ${tables.length} 张表，期望 18 张 —— 先修解析器，不要静默少生成`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const group of GROUPS) {
    const picked = tables.filter((t) => {
      const n = Number(t.id.slice(4));
      return n >= group.from && n <= group.to;
    });
    const body = [
      `// 本文件由 generate-stores.mjs 从 30-design/设计文档包/05-数据库设计说明.md 生成。`,
      `// 不要手改：改设计文档后运行 node 80-derived/drawcode/generate-stores.mjs 重新生成。`,
      `// 分组：${group.title}（${group.from}~${group.to}）。`,
      '',
      'using Drawcode;',
      '',
      'namespace AidashTwin.Stores;',
      '',
      picked.map(renderClass).join('\n\n'),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(OUT_DIR, group.file), body, 'utf8');
    console.log(`${group.file}: ${picked.length} 张表，${picked.reduce((n, t) => n + t.columns.length, 0)} 列`);
  }

  console.log(`共 ${tables.length} 张表`);
}

main();
