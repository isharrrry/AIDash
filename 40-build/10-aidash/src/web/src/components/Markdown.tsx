/**
 * 最小安全 Markdown 渲染器。
 *
 * 为什么不用 dangerouslySetInnerHTML + marked：
 * 卡片正文来自 harness（可能是外部输入），一旦拼进 innerHTML，`<img onerror=...>`
 * 或 `javascript:` 链接就能直接执行脚本。本渲染器把 Markdown 解析成 React 节点，
 * 文本始终作为 text node 交给 React 转义；链接只放行 http/https。
 * 支持范围：标题、段落、无序/有序列表、围栏代码块、行内代码、加粗、==高亮==、链接、
 * 引用，以及任务描述里粘贴生成的 base64 图片。
 */
import { createElement, Fragment } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { MermaidDiagram } from './MermaidDiagram';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'hr' };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^[-*]\s+(.*)$/;
const OL_RE = /^\d+[.)]\s+(.*)$/;
const FENCE_RE = /^```([A-Za-z0-9_+-]*)\s*$/;
// 分隔线必须是整行；`---` 单独出现时是 <hr>，出现在表格第二行时由表格解析先截走。
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
// GFM 表格分隔行：允许首尾竖线省略，每列至少三个短横线，可带对齐冒号。
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const SAFE_LINK_RE = /^https?:\/\//i;
// 图片只放行 http(s) 与常见位图的 base64。不放行 svg：SVG 可以带脚本，
// 虽然 <img> 上下文通常不执行，但没有必要为这种边角需求扩大攻击面。
const SAFE_IMAGE_RE = /^(?:https?:\/\/|data:image\/(?:png|jpe?g|webp|gif);base64,)/i;

/** 供单测与调试使用：判断一个 Markdown 图片地址是否允许渲染。 */
export function isSafeImageSrc(url: string): boolean {
  return SAFE_IMAGE_RE.test(url.trim());
}

function isBlockStart(line: string): boolean {
  return (
    HEADING_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    FENCE_RE.test(line) ||
    HR_RE.test(line) ||
    line.startsWith('>')
  );
}

/** 按未转义的 `|` 切单元格；`\|` 还原成字面竖线，避免表格里的正则/代码被切成两列。 */
function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '\\' && trimmed[index + 1] === '|') {
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

/**
 * 识别 GFM 表格：当前行是表头，下一行是分隔行，再往下是数据行。
 * 返回 null 表示这里不是表格，调用方继续按段落处理。
 */
function tableAt(
  lines: string[],
  index: number,
): { header: string[]; rows: string[][]; next: number } | null {
  const headerLine = lines[index] ?? '';
  const separatorLine = lines[index + 1] ?? '';
  if (!headerLine.includes('|') || !TABLE_SEPARATOR_RE.test(separatorLine)) return null;
  const header = splitTableRow(headerLine);
  if (header.length < 2 || splitTableRow(separatorLine).length !== header.length) return null;

  const rows: string[][] = [];
  let cursor = index + 2;
  while (cursor < lines.length) {
    const rowLine = lines[cursor] ?? '';
    if (!rowLine.trim() || !rowLine.includes('|')) break;
    const cells = splitTableRow(rowLine);
    // 列数不齐时按表头宽度补齐/截断：报告里手写表格常漏单元格，渲染不能因此错位。
    rows.push(header.map((_, cellIndex) => cells[cellIndex] ?? ''));
    cursor += 1;
  }
  return { header, rows, next: cursor };
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith('```')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1; // 跳过收尾围栏
      blocks.push({ kind: 'code', lang, text: body.join('\n') });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: String(heading[1] ?? '#').length,
        text: heading[2] ?? '',
      });
      index += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    const table = tableAt(lines, index);
    if (table) {
      blocks.push({ kind: 'table', header: table.header, rows: table.rows });
      index = table.next;
      continue;
    }

    if (line.startsWith('>')) {
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('>')) {
        body.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    const firstUl = UL_RE.test(line);
    const firstOl = OL_RE.test(line);
    if (firstUl || firstOl) {
      const ordered = firstOl;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = ordered ? OL_RE.exec(current) : UL_RE.exec(current);
        if (!match) break;
        items.push(match[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // 普通段落：连续的行合并为一个段落，遇到空行或下一个块起始行停止。
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      // 表格的表头行本身不以 #/-/` 开头，必须用两行前瞻识别，否则会被并进上一段。
      if (!next.trim() || isBlockStart(next) || tableAt(lines, index) !== null) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let plainStart = 0;
  let key = 0;

  const flush = (end: number): void => {
    if (end > plainStart) nodes.push(text.slice(plainStart, end));
  };

  while (index < text.length) {
    // 行内代码优先级最高：里面的 ** 和 [] 都按字面量处理。
    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1);
      if (end > index + 1) {
        flush(index);
        nodes.push(<code key={`code-${key++}`}>{text.slice(index + 1, end)}</code>);
        index = end + 1;
        plainStart = index;
        continue;
      }
    }

    // ==高亮==：和 **加粗** 用同一套“成对标记”扫描规则。
    // 关键信息（止损条件、推荐项、风险）用高亮比加粗更醒目，适合扫读。
    // 内部再递归一次，允许“==**关键结论**==”这种叠加写法。
    if (text.startsWith('==', index)) {
      const end = text.indexOf('==', index + 2);
      if (end > index + 2) {
        flush(index);
        nodes.push(<mark key={`mark-${key++}`}>{renderInline(text.slice(index + 2, end))}</mark>);
        index = end + 2;
        plainStart = index;
        continue;
      }
    }

    if (text.startsWith('**', index)) {
      const end = text.indexOf('**', index + 2);
      if (end > index + 2) {
        flush(index);
        // 递归解析内部内容：加粗里可以再套高亮或行内代码。
        nodes.push(
          <strong key={`bold-${key++}`}>{renderInline(text.slice(index + 2, end))}</strong>,
        );
        index = end + 2;
        plainStart = index;
        continue;
      }
    }

    // 删除线（GFM）：报告里常用来标注“已废弃/已取消”的条目。
    if (text.startsWith('~~', index)) {
      const end = text.indexOf('~~', index + 2);
      if (end > index + 2) {
        flush(index);
        nodes.push(<del key={`del-${key++}`}>{renderInline(text.slice(index + 2, end))}</del>);
        index = end + 2;
        plainStart = index;
        continue;
      }
    }

    // 单星号斜体：要求开头后不是空白、结尾前不是空白，避免把 "2 * 3 * 4" 误判成斜体。
    if (
      text[index] === '*' &&
      text[index + 1] !== '*' &&
      text[index + 1] !== undefined &&
      !/\s/.test(text[index + 1] ?? '')
    ) {
      const end = text.indexOf('*', index + 1);
      if (end > index + 1 && !/\s/.test(text[end - 1] ?? '') && text[end + 1] !== '*') {
        flush(index);
        nodes.push(<em key={`em-${key++}`}>{renderInline(text.slice(index + 1, end))}</em>);
        index = end + 1;
        plainStart = index;
        continue;
      }
    }

    // 图片必须放在链接之前判断：`![alt](url)` 的第二个字符才是 `[`，
    // 如果先走链接分支，`!` 会被当普通文本，图片语法就失效了。
    if (text[index] === '!' && text[index + 1] === '[') {
      const altEnd = text.indexOf(']', index + 2);
      if (altEnd >= index + 2 && text[altEnd + 1] === '(') {
        const urlEnd = text.indexOf(')', altEnd + 2);
        if (urlEnd > altEnd + 2) {
          const alt = text.slice(index + 2, altEnd);
          const url = text.slice(altEnd + 2, urlEnd).trim();
          flush(index);
          if (isSafeImageSrc(url)) {
            nodes.push(
              <img
                key={`image-${key++}`}
                className="md-image"
                src={url}
                alt={alt || '任务图片'}
                loading="lazy"
              />,
            );
          } else {
            // 不安全或不受支持的图片地址只显示 alt 文本，不生成 <img>。
            nodes.push(alt);
          }
          index = urlEnd + 1;
          plainStart = index;
          continue;
        }
      }
    }

    if (text[index] === '[') {
      const labelEnd = text.indexOf(']', index + 1);
      if (labelEnd > index + 1 && text[labelEnd + 1] === '(') {
        const urlEnd = text.indexOf(')', labelEnd + 2);
        if (urlEnd > labelEnd + 2) {
          const label = text.slice(index + 1, labelEnd);
          const url = text.slice(labelEnd + 2, urlEnd).trim();
          flush(index);
          if (SAFE_LINK_RE.test(url)) {
            nodes.push(
              <a key={`link-${key++}`} href={url} target="_blank" rel="noopener noreferrer">
                {label}
              </a>,
            );
          } else {
            // 不安全协议只显示文字，不生成可点击链接。
            nodes.push(label);
          }
          index = urlEnd + 1;
          plainStart = index;
          continue;
        }
      }
    }

    index += 1;
  }

  flush(text.length);
  return nodes;
}

function renderBlock(block: Block, index: number): ReactElement {
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6);
      return createElement(`h${level}`, { key: index }, renderInline(block.text));
    }
    case 'paragraph':
      return <p key={index}>{renderInline(block.text)}</p>;
    case 'quote':
      return <blockquote key={index}>{renderInline(block.text)}</blockquote>;
    case 'code':
      // mermaid 围栏交给独立组件异步渲染；普通代码块仍走安全的文本节点。
      if (block.lang.toLowerCase() === 'mermaid') {
        return <MermaidDiagram key={index} code={block.text} />;
      }
      return (
        <pre key={index} className="md-code">
          <code data-lang={block.lang || undefined}>{block.text}</code>
        </pre>
      );
    case 'table':
      // 表格必须包一层横向滚动容器：报告里的列多时，不能把整页撑出横向滚动条。
      return (
        <div key={index} className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={cellIndex}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr key={index} />;
    case 'list': {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>{renderInline(item)}</li>
      ));
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    default:
      return <Fragment key={index} />;
  }
}

export function Markdown({
  source,
  className,
}: {
  source: string | null | undefined;
  className?: string;
}): ReactElement {
  if (!source || !source.trim()) {
    return <p className="muted">（无正文）</p>;
  }
  const blocks = parseMarkdown(source);
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}

/**
 * 行内 Markdown（只解析 **加粗**、==高亮==、`代码`、链接）。
 *
 * 列表里的标题/摘要本身只有一行，用完整 Markdown 会生成 <p> 把行高撑开；
 * 这里只渲染行内节点，外层仍由调用方控制省略号与布局。
 */
export function MarkdownInline({
  source,
  fallback = '—',
}: {
  source: string | null | undefined;
  fallback?: string;
}): ReactElement {
  if (!source || !source.trim()) return <span className="muted">{fallback}</span>;
  return <>{renderInline(source.replace(/\s+/g, ' ').trim())}</>;
}
