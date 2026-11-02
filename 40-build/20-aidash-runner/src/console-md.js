/**
 * 控制台 Markdown 轻量渲染（零第三方依赖）。
 *
 * 只服务于“前台 TTY 里人眼看 harness stdout”这一场景：
 * - 日志文件、证据卡、环形缓冲仍保存原文（Markdown），方便机器处理和复盘；
 * - 非 TTY（重定向/管道）、`--json`、`--no-md` 都不渲染，避免 ANSI 污染下游；
 * - 含 ANSI 或光标控制的行原样放行，不猜 harness 自己已经画好的界面。
 *
 * 覆盖标题、粗体/斜体/删除线、行内代码、代码围栏、列表/任务列表、引用、
 * 分隔线、链接和 GFM 表格；不追求 CommonMark 完备，宁可少渲染也不能改坏原文。
 */

const STYLE_CODES = {
  bold: '1',
  dim: '2',
  italic: '3',
  underline: '4',
  strike: '9',
  blue: '34',
  cyan: '36',
  green: '32',
  brightCyan: '96',
  gray: '90',
};

const H1_STYLE = ['bold', 'underline', 'brightCyan'];
const H2_STYLE = ['bold', 'cyan'];
const H3_STYLE = ['bold'];
const H4_STYLE = ['bold', 'dim'];
const LINK_STYLE = ['underline', 'blue'];
const ESCAPABLE = new Set('\\`*_{}[]()#+-.!~|<>'.split(''));

const ANSI_PATTERN =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

const FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_PATTERN = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const QUOTE_PATTERN = /^(\s*)((?:>\s?)+)(.*)$/;
const TASK_ITEM_PATTERN = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET_PATTERN = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_PATTERN = /^(\s*)(\d{1,9})([.)])\s+(.*)$/;
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;

/** 颜色能力判断：只认“真的在终端里”，并尊重 NO_COLOR / TERM=dumb / FORCE_COLOR=0。 */
export function supportsColor(stream = process.stdout, env = process.env) {
  if (env?.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env?.FORCE_COLOR === '0') return false;
  if (env?.TERM === 'dumb') return false;
  return stream?.isTTY === true;
}

/** 终端显示宽度：ANSI 不计，东亚宽字符/全角字符记 2，组合符记 0。 */
export function displayWidth(text) {
  const plain = String(text ?? '').replace(ANSI_PATTERN, '');
  let width = 0;
  for (const char of plain) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (char === '\t') {
      width += 4;
    } else if (isZeroWidth(code)) {
      // 组合字符不占列。
    } else if (isWide(code)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function isZeroWidth(code) {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  );
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 生成“重置 + 目标样式”的 SGR 序列；color=false 时整体退化为空串。 */
function sgr(styles, color) {
  if (!color) return '';
  if (styles.length === 0) return '\u001b[0m';
  return `\u001b[0m\u001b[${styles.map((style) => STYLE_CODES[style]).join(';')}m`;
}

/** 在已知样式下继续解析内联 Markdown；返回的文本末尾仍处于 styles 样式。 */
export function renderInline(text, styles = [], color = true) {
  let output = sgr(styles, color);
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    // 反斜杠转义：`\*` 输出 `*`，不再参与强调解析。
    if (char === '\\' && index + 1 < text.length && ESCAPABLE.has(text[index + 1])) {
      output += text[index + 1];
      index += 2;
      continue;
    }

    if (char === '`') {
      const span = readCodeSpan(text, index);
      if (span) {
        output += sgr([...styles, 'cyan'], color) + span.content + sgr(styles, color);
        index = span.end;
        continue;
      }
    }

    if (char === '!' && text[index + 1] === '[') {
      const link = readLink(text, index + 1);
      if (link) {
        output += renderInline(link.label || '图片', styles, color);
        output += sgr([...styles, 'gray'], color) + ` (${link.url})` + sgr(styles, color);
        index = link.end;
        continue;
      }
    }

    if (char === '[') {
      const link = readLink(text, index);
      if (link) {
        output += renderInline(link.label, [...styles, ...LINK_STYLE], color);
        output += sgr([...styles, 'gray'], color) + ` (${link.url})` + sgr(styles, color);
        index = link.end;
        continue;
      }
    }

    if (char === '<') {
      const auto = /^<((?:https?|ftp):\/\/[^>\s]+)>/.exec(text.slice(index));
      if (auto) {
        output += sgr([...styles, ...LINK_STYLE], color) + auto[1] + sgr(styles, color);
        index += auto[0].length;
        continue;
      }
    }

    // 粗体必须放在斜体前面判断，否则 `**x**` 会被单星号拆开。
    if (text.startsWith('**', index) || text.startsWith('__', index)) {
      const marker = text.slice(index, index + 2);
      const close = findClosing(text, marker, index + 2, 2);
      if (
        close !== -1 &&
        !/\s/.test(text[index + 2] ?? '') &&
        !/\s/.test(text[close - 1] ?? '') &&
        !(marker === '__' && /[A-Za-z0-9_]/.test(text[index - 1] ?? '')) &&
        !(marker === '__' && /[A-Za-z0-9]/.test(text[close + 2] ?? ''))
      ) {
        output += renderInline(text.slice(index + 2, close), [...styles, 'bold'], color);
        output += sgr(styles, color);
        index = close + 2;
        continue;
      }
    }

    if (text.startsWith('~~', index)) {
      const close = findClosing(text, '~~', index + 2, 2);
      if (close !== -1 && !/\s/.test(text[index + 2] ?? '') && !/\s/.test(text[close - 1] ?? '')) {
        output += renderInline(text.slice(index + 2, close), [...styles, 'strike'], color);
        output += sgr(styles, color);
        index = close + 2;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const close = findClosing(text, char, index + 1, 1);
      const canOpen = text[index + 1] !== undefined && !/\s/.test(text[index + 1]);
      // 下划线不跨词：`task_id`、`a_b` 这类标识符不能被当成强调。
      const openInWord = char === '_' && /[A-Za-z0-9_]/.test(text[index - 1] ?? '');
      if (canOpen && !openInWord && close !== -1) {
        const closeInWord = /[A-Za-z0-9]/.test(text[close + 1] ?? '');
        if (!/\s/.test(text[close - 1] ?? '') && !closeInWord) {
          output += renderInline(text.slice(index + 1, close), [...styles, 'italic'], color);
          output += sgr(styles, color);
          index = close + 1;
          continue;
        }
      }
    }

    output += char;
    index += 1;
  }

  return output;
}

/** 读取行内代码；返回内容与闭合位置，找不到闭合则返回 null（按普通字符处理）。 */
function readCodeSpan(text, start) {
  let markerLength = 0;
  while (text[start + markerLength] === '`') markerLength += 1;
  const marker = '`'.repeat(markerLength);
  const close = text.indexOf(marker, start + markerLength);
  if (close === -1) return null;
  let content = text.slice(start + markerLength, close);
  // CommonMark：两边各有一个空格且内容不全为空格时，去掉各一个空格。
  if (
    content.length >= 2 &&
    content.startsWith(' ') &&
    content.endsWith(' ') &&
    content.trim() !== ''
  ) {
    content = content.slice(1, -1);
  }
  return { content, end: close + markerLength };
}

/** 读取 `[label](url)`；label 不处理嵌套方括号，够覆盖 markdown 报告。 */
function readLink(text, start) {
  const close = text.indexOf(']', start + 1);
  if (close === -1 || text[close + 1] !== '(') return null;
  const urlEnd = text.indexOf(')', close + 2);
  if (urlEnd === -1) return null;
  const label = text.slice(start + 1, close);
  const url = text
    .slice(close + 2, urlEnd)
    .trim()
    .replace(/\s+("[^"]*"|'[^']*')$/, '');
  if (!url) return null;
  return { label, url, end: urlEnd + 1 };
}

/** 找闭合分隔符；单字符强调跳过 `**`/`__` 里的单字符位置。 */
function findClosing(text, marker, from, length) {
  for (let index = from; index <= text.length - length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (!text.startsWith(marker, index)) continue;
    if (length === 1 && (text[index - 1] === marker || text[index + 1] === marker)) {
      continue;
    }
    return index;
  }
  return -1;
}

/** 把一行拆成表格单元格；支持 `\|` 转义。 */
function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell.trim()));
}

function cellAlignment(cell) {
  const text = cell.trim();
  if (text.startsWith(':') && text.endsWith(':')) return 'center';
  if (text.endsWith(':')) return 'right';
  return 'left';
}

/** 流式控制台 Markdown 渲染器：按行处理，跨 chunk 的半个行会先缓存。 */
export class ConsoleMarkdown {
  constructor({ color = true, columns = 80 } = {}) {
    this.color = color === true;
    const width = Number(columns);
    this.columns = Number.isFinite(width) ? Math.min(120, Math.max(20, Math.floor(width))) : 80;
    this.buffer = '';
    this.tableLines = [];
    this.inFence = false;
    this.fenceChar = '';
    this.ended = false;
  }

  push(chunk) {
    if (this.ended || !chunk) return '';
    this.buffer += String(chunk);
    let output = '';
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      output += this.consumeLine(line, true);
      newline = this.buffer.indexOf('\n');
    }
    return output;
  }

  end() {
    if (this.ended) return '';
    this.ended = true;
    let output = '';
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = '';
      if (this.isTableRow(line)) {
        this.tableLines.push(line);
      } else {
        output += this.flushTable();
        output += this.renderLine(line);
      }
    }
    output += this.flushTable();
    this.inFence = false;
    this.fenceChar = '';
    return output;
  }

  consumeLine(line, hasNewline) {
    if (this.isTableRow(line)) {
      this.tableLines.push(line);
      return '';
    }
    const table = this.flushTable();
    return table + this.renderLine(line) + (hasNewline ? '\n' : '');
  }

  /** 表格要等到下一行才能判断是不是真的 GFM 表格，所以先按行缓存。 */
  isTableRow(line) {
    // 代码围栏里的 `|` 是代码内容，不能当成表格语法。
    if (this.inFence) return false;
    const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!raw.includes('|') || raw.includes('\u001b')) return false;
    const withoutEscapes = raw.replace(/\\\|/g, '');
    const pipes = withoutEscapes.match(/\|/g);
    if (!pipes) return false;
    if (/^\s*\|/.test(raw)) return true;
    return pipes.length >= 2;
  }

  flushTable() {
    if (this.tableLines.length === 0) return '';
    const lines = this.tableLines;
    this.tableLines = [];
    const rendered = this.renderTable(lines);
    return `${rendered.join('\n')}\n`;
  }

  renderTable(lines) {
    const rows = lines.map((line) => splitTableRow(line));
    // 第二行必须是 `|---|:---:|` 分隔行，否则只是恰好带竖线的普通文本。
    if (rows.length < 2 || !isTableSeparator(rows[1])) {
      return lines.map((line) => this.renderLine(line));
    }

    const alignments = rows[1].map(cellAlignment);
    const header = rows[0];
    const body = rows.slice(2);
    const columnCount = Math.max(header.length, ...body.map((row) => row.length), 1);
    const normalize = (row) => Array.from({ length: columnCount }, (_unused, index) => row[index] ?? '');

    // 表头粗体必须作为 renderInline 的基准样式带入：先渲染再包一层 bold
    // 会被内联代码/链接产生的 reset 序列抵消。单元格末尾统一复位，避免样式漏到边框。
    const headerCells = normalize(header).map((cell) =>
      this.withReset(renderInline(cell, ['bold'], this.color)),
    );
    const bodyCells = body.map((row) =>
      normalize(row).map((cell) => this.withReset(renderInline(cell, [], this.color))),
    );

    const widths = Array.from({ length: columnCount }, (_unused, column) => {
      const candidates = [headerCells[column], ...bodyCells.map((row) => row[column])];
      return Math.max(1, ...candidates.map((cell) => displayWidth(cell)));
    });

    const dim = (text) => this.paint(['gray'], text);
    const border = (left, middle, right, fill = '─') =>
      dim(left + widths.map((width) => fill.repeat(width + 2)).join(middle) + right);
    const rowText = (cells) => {
      const padded = cells.map((cell, column) => padCell(cell, widths[column], alignments[column]));
      return `${dim('│')} ${padded.join(` ${dim('│')} `)} ${dim('│')}`;
    };

    const out = [border('┌', '┬', '┐'), rowText(headerCells), border('├', '┼', '┤')];
    for (const cells of bodyCells) out.push(rowText(cells));
    out.push(border('└', '┴', '┘'));
    return out;
  }

  renderLine(line) {
    const raw = line.endsWith('\r') ? line.slice(0, -1) : line;

    // harness 自己带的 ANSI/光标控制行原样放行，避免和终端状态打架。
    if (raw.includes('\u001b') || raw.includes('\r')) return raw;

    const fence = FENCE_PATTERN.exec(raw);
    if (fence) {
      const marker = fence[2];
      if (!this.inFence) {
        this.inFence = true;
        this.fenceChar = marker[0];
        const language = fence[3].trim();
        return this.paint(['gray'], `┌─ ${language || 'code'}`);
      }
      if (marker[0] === this.fenceChar) {
        this.inFence = false;
        this.fenceChar = '';
        return this.paint(['gray'], '└─');
      }
    }
    if (this.inFence) {
      // 代码块内只上灰色，不再解释任何 Markdown 标记；保留两格缩进便于区分正文。
      if (raw === '') return '';
      return `  ${this.paint(['gray'], raw)}`;
    }

    const heading = HEADING_PATTERN.exec(raw);
    if (heading) {
      const level = heading[1].length;
      const styles =
        level === 1 ? H1_STYLE : level === 2 ? H2_STYLE : level === 3 ? H3_STYLE : H4_STYLE;
      return this.withReset(renderInline(heading[2], styles, this.color));
    }

    if (HR_PATTERN.test(raw)) {
      return this.paint(['gray'], '─'.repeat(Math.max(10, Math.min(this.columns, 72))));
    }

    const quote = QUOTE_PATTERN.exec(raw);
    if (quote) {
      const depth = (quote[2].match(/>/g) ?? []).length;
      const bar = this.paint(['dim', 'cyan'], '│ '.repeat(depth));
      return `${quote[1]}${bar}${renderInline(quote[3], [], this.color)}`;
    }

    const task = TASK_ITEM_PATTERN.exec(raw);
    if (task) {
      const done = task[2].toLowerCase() === 'x';
      const box = this.paint(done ? ['green'] : ['gray'], done ? '[x]' : '[ ]');
      return `${task[1]}${box} ${renderInline(task[3], [], this.color)}`;
    }

    const bullet = BULLET_PATTERN.exec(raw);
    if (bullet) {
      return `${bullet[1]}${this.paint(['cyan'], '•')} ${renderInline(bullet[2], [], this.color)}`;
    }

    const ordered = ORDERED_PATTERN.exec(raw);
    if (ordered) {
      const marker = this.paint(['cyan'], `${ordered[2]}${ordered[3]}`);
      return `${ordered[1]}${marker} ${renderInline(ordered[4], [], this.color)}`;
    }

    if (raw.trim() === '') return '';

    return renderInline(raw, [], this.color);
  }

  paint(styles, text) {
    if (!this.color || text === '') return text;
    return `\u001b[${styles.map((style) => STYLE_CODES[style]).join(';')}m${text}\u001b[0m`;
  }

  withReset(text) {
    return this.color ? `${text}\u001b[0m` : text;
  }
}

function padCell(text, width, alignment) {
  const gap = Math.max(0, width - displayWidth(text));
  if (alignment === 'right') return ' '.repeat(gap) + text;
  if (alignment === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  }
  return text + ' '.repeat(gap);
}
