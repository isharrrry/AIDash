import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleMarkdown, displayWidth, renderInline, supportsColor } from '../src/console-md.js';
import { parseArgv } from '../src/args.js';

/**
 * 前台控制台 Markdown 渲染的回归测试。
 *
 * 现场缺陷：runner 把 harness stdout 原样打到终端，`## 标题`、`**加粗**`、
 * 反引号和 Markdown 表格分隔线全部裸露，长报告在 cmd 里很难扫读。
 * 这里同时锁住“渲染不改变日志原文”的边界——渲染器只接收文本、返回展示文本。
 */

const ESC = '\u001b';

test('displayWidth：中文/全角按 2 列，ANSI 不占列', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('ＡＢ'), 4);
  assert.equal(displayWidth(`${ESC}[31m红色${ESC}[0m`), 4);
  assert.equal(displayWidth('a\tb'), 6);
});

test('supportsColor：非 TTY/NO_COLOR/TERM=dumb/FORCE_COLOR=0 都关闭', () => {
  assert.equal(supportsColor({ isTTY: false }, {}), false);
  assert.equal(supportsColor({ isTTY: true }, {}), true);
  assert.equal(supportsColor({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(supportsColor({ isTTY: true }, { TERM: 'dumb' }), false);
  assert.equal(supportsColor({ isTTY: true }, { FORCE_COLOR: '0' }), false);
});

test('标题去掉 #，按级别加粗上色', () => {
  const md = new ConsoleMarkdown({ color: true });
  const heading = md.push('## 大白话结论\n');
  assert.equal(heading.includes('##'), false);
  assert.equal(heading, `${ESC}[0m${ESC}[1;36m大白话结论${ESC}[0m\n`);

  const h1 = new ConsoleMarkdown({ color: true }).push('# 一级标题\n');
  assert.match(h1, /\u001b\[1;4;96m一级标题/);
  assert.equal(h1.includes('#'), false);
});

test('粗体/斜体/删除线/行内代码/链接不再裸露 Markdown 标记', () => {
  const md = new ConsoleMarkdown({ color: true });
  const out = md.push('这次**只读分析**，`F:\\x.json` 与 *强调*、~~删除~~、[报告](https://example.com/a)。\n');

  assert.equal(out.includes('**'), false);
  assert.equal(out.includes('`'), false);
  assert.equal(out.includes('~~'), false);
  assert.match(out, /\u001b\[1m只读分析/);
  assert.match(out, /\u001b\[36mF:\\x\.json/);
  assert.match(out, /\u001b\[3m强调/);
  assert.match(out, /\u001b\[9m删除/);
  assert.equal(out.includes('[报告]('), false);
  assert.ok(out.includes('(https://example.com/a)'));
});

test('下划线和星号不误伤标识符/文件通配符', () => {
  const plain = new ConsoleMarkdown({ color: false });
  assert.equal(plain.push('task_id 与 other_id 保持原样\n'), 'task_id 与 other_id 保持原样\n');
  assert.equal(plain.push('2*3*4 和 *.mjs 保持原样\n'), '2*3*4 和 *.mjs 保持原样\n');
});

test('代码围栏内不再解释 Markdown，内容原样保留', () => {
  const md = new ConsoleMarkdown({ color: false });
  const out = md.push(['```js', 'const a = **not bold**;', '## not heading', '```', ''].join('\n'));

  assert.match(out, /┌─ js/);
  assert.match(out, /  const a = \*\*not bold\*\*;/);
  assert.match(out, /  ## not heading/);
  assert.match(out, /└─/);
  assert.equal(out.includes('\u001b'), false);
});

test('列表/任务列表/引用/分隔线渲染为可扫读的符号', () => {
  const md = new ConsoleMarkdown({ color: false });
  const out = md.push(
    [
      '- 第一项',
      '1. 第二项',
      '- [x] 已完成',
      '- [ ] 待办',
      '> 引用内容',
      '---',
      '',
    ].join('\n'),
  );

  assert.match(out, /^• 第一项$/m);
  assert.match(out, /^1\. 第二项$/m);
  assert.match(out, /^\[x\] 已完成$/m);
  assert.match(out, /^\[ \] 待办$/m);
  assert.match(out, /^│ 引用内容$/m);
  assert.match(out, /─{3,}/);
});

test('GFM 表格画成对齐的方框，中英文列宽一致', () => {
  const md = new ConsoleMarkdown({ color: false, columns: 100 });
  const out =
    md.push(
      ['| 名称 | 说明 |', '| --- | :---: |', '| a | 中文 |', '| bbbb | x |', ''].join('\n'),
    ) + md.end();

  const lines = out.trimEnd().split('\n');
  assert.equal(lines.length, 6, out);
  assert.match(lines[0], /^┌─+┬─+┐$/);
  assert.match(lines[2], /^├─+┼─+┤$/);
  assert.match(lines[5], /^└─+┴─+┘$/);
  assert.ok(lines[1].includes('名称') && lines[1].includes('说明'));
  assert.ok(lines[3].includes('中文'));
  // 每一行的显示宽度必须一致，否则边框会歪。
  const widths = new Set(lines.map((line) => displayWidth(line)));
  assert.equal(widths.size, 1, [...widths].join(','));
});

test('带竖线但不是表格的文本保持原样', () => {
  const md = new ConsoleMarkdown({ color: false });
  const out = md.push('命令：echo a | grep b | wc -l\n') + md.end();
  assert.equal(out, '命令：echo a | grep b | wc -l\n');
});

test('跨 chunk 的半个行会缓存后再渲染', () => {
  const md = new ConsoleMarkdown({ color: true });
  assert.equal(md.push('## 大'), '');
  const out = md.push('白话结论\n正文\n');
  assert.equal(out.includes('##'), false);
  assert.match(out, /大白话结论/);
  assert.match(out, /正文/);
});

test('含 ANSI 的行原样放行，不改变 harness 自己的界面', () => {
  const md = new ConsoleMarkdown({ color: true });
  const line = `${ESC}[31mRED-ANSI${ESC}[0m`;
  assert.equal(md.push(`${line}\n`), `${line}\n`);
});

test('end 冲刷末尾无换行内容且幂等', () => {
  const md = new ConsoleMarkdown({ color: false });
  assert.equal(md.push('没有换行的末尾'), '');
  assert.equal(md.end(), '没有换行的末尾');
  assert.equal(md.end(), '');
});

test('color=false 时不产生任何 ANSI，但仍去掉 Markdown 标记', () => {
  const md = new ConsoleMarkdown({ color: false });
  const out = md.push('# 标题\n**加粗**\n');
  assert.equal(out.includes('\u001b'), false);
  assert.equal(out, '标题\n加粗\n');
});

test('--no-md 是已知布尔开关', () => {
  const { flags } = parseArgv(['start', '--no-md']);
  assert.equal(flags.noMd, true);
  assert.equal(parseArgv(['start']).flags.noMd, false);
});

test('renderInline 可独立用于表格单元格等场景', () => {
  assert.equal(renderInline('a **b** c', [], false), 'a b c');
  assert.equal(renderInline('a `x|y` c', [], false), 'a x|y c');
});
