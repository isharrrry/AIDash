import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/web/src/components/Markdown.js';

/**
 * 汇报正文渲染回归。
 *
 * 这组用例只验证“解析出了什么块”，不渲染 React：
 * 1. GFM 表格必须成为 table，而不是把管道符留在段落里；
 * 2. `---` 成为分隔线，不能吞掉后面的内容；
 * 3. ```mermaid 围栏保留 lang，交给 MermaidDiagram 异步出图；
 * 4. 普通含竖线的句子不能被误判成表格。
 */
describe('Markdown 解析', () => {
  it('把 GFM 表格解析为表头与数据行', () => {
    const blocks = parseMarkdown(
      ['| 项 | 值 |', '| --- | --- |', '| 状态 | 完成 |', '| 风险 | 无 |', '', '收尾段落'].join(
        '\n',
      ),
    );
    expect(blocks[0]).toEqual({
      kind: 'table',
      header: ['项', '值'],
      rows: [
        ['状态', '完成'],
        ['风险', '无'],
      ],
    });
    expect(blocks[1]).toEqual({ kind: 'paragraph', text: '收尾段落' });
  });

  it('支持省略首尾竖线的表格与转义竖线', () => {
    const blocks = parseMarkdown(
      ['项 | 值', '--- | ---', '正则 | a \\| b'].join('\n'),
    );
    expect(blocks).toEqual([
      { kind: 'table', header: ['项', '值'], rows: [['正则', 'a | b']] },
    ]);
  });

  it('分隔线与 mermaid 围栏各自成为独立块', () => {
    const blocks = parseMarkdown(
      ['前文', '', '---', '', '```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n'),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'hr',
      'code',
    ]);
    expect(blocks[2]).toEqual({
      kind: 'code',
      lang: 'mermaid',
      text: 'flowchart LR\n  A --> B',
    });
  });

  it('普通含竖线的句子不会被误判成表格', () => {
    const blocks = parseMarkdown('条件 A | 条件 B 同时成立时继续。');
    expect(blocks).toEqual([{ kind: 'paragraph', text: '条件 A | 条件 B 同时成立时继续。' }]);
  });

  it('分隔行每列只写两个短横线（`| :-- |`）时仍识别为表格', () => {
    // 真实回归：harness 汇报里的 P0/P1 表写的是 `| :-- | :-- |`（每列 2 个短横线）。
    // GFM 规范要 3 个，但只认 3 个会把整张表退化成一段带竖线的文字——
    // 用户看到的就是“没有表格、行也不换行”。
    const blocks = parseMarkdown(
      [
        '| 编号 | 缺口 | 证据 |',
        '| :-- | :-- | :-- |',
        '| P0-1 | 线上格式只覆盖 3 个负载 | 04 §5.12 |',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      {
        kind: 'table',
        header: ['编号', '缺口', '证据'],
        rows: [['P0-1', '线上格式只覆盖 3 个负载', '04 §5.12']],
      },
    ]);
  });

  it('分隔行写成 `|:-:|`（1 个短横线加两端冒号）也识别为表格', () => {
    const blocks = parseMarkdown(['| a | b |', '|:-:|:-:|', '| 1 | 2 |'].join('\n'));
    expect(blocks).toEqual([{ kind: 'table', header: ['a', 'b'], rows: [['1', '2']] }]);
  });
});
