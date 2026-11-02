// @vitest-environment jsdom
/**
 * Markdown 渲染层回归（DOM 级）。
 *
 * 和 markdown.test.ts 的分工：
 *   - markdown.test.ts 只验证“解析出什么块”（node 环境，不渲染 React）；
 *   - 本文验证“块变成了什么 DOM”，因为用户报的两类症状都发生在渲染层：
 *     表格分隔行认出来之后有没有真的成为 <table>，行尾两个空格（GFM 硬换行）
 *     有没有变成 <br> —— 这两件事解析层都看不出来。
 *
 * 约束：只用 react-dom/client + jsdom + React 自带 act，不引第三方测试库。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Markdown } from '../src/web/src/components/Markdown.js';

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

beforeAll(() => {
  // React 19 的 act 需要这个开关，否则会打印“环境未配置 act”的告警。
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => {
      item.root.unmount();
    });
    item.container.remove();
  }
});

function render(source: string): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(createElement(Markdown, { source }));
  });
  return container;
}

describe('Markdown 渲染：硬换行', () => {
  it('行尾两个空格渲染成 <br>，不是折叠成空格', () => {
    // 真实回归：汇报开头的“日期 / 范围 / 基线”三行都用行尾两个空格分行，
    // 折叠后会挤成一行，读起来就是“没有换行”。
    const container = render('日期：2026-10-26  \n范围：文档包  \n基线：00 V0.13');
    const paragraph = container.querySelector('p');
    expect(paragraph).toBeTruthy();
    expect(paragraph?.querySelectorAll('br').length).toBe(2);
    const parts = (paragraph?.textContent ?? '').split('\n');
    expect(parts.every((line) => line.trim().length > 0)).toBe(true);
    expect(paragraph?.textContent).toContain('日期：2026-10-26');
    expect(paragraph?.textContent).toContain('范围：文档包');
    expect(paragraph?.textContent).toContain('基线：00 V0.13');
  });

  it('单个换行不生成 <br>（GFM 语义仍是同一段）', () => {
    const container = render('第一句\n第二句');
    expect(container.querySelectorAll('br').length).toBe(0);
    expect(container.querySelector('p')?.textContent).toBe('第一句\n第二句');
  });

  it('行尾三个空格也算硬换行，且不留下多余空格', () => {
    const container = render('甲   \n乙');
    const paragraph = container.querySelector('p');
    expect(paragraph?.querySelectorAll('br').length).toBe(1);
    expect((paragraph?.textContent ?? '').startsWith('甲')).toBe(true);
    expect((paragraph?.textContent ?? '').includes('甲 ')).toBe(false);
  });
});

describe('Markdown 渲染：表格', () => {
  it('分隔行只写 `| :-- |` 时渲染出真表格', () => {
    const container = render(
      ['| 编号 | 缺口 |', '| :-- | :-- |', '| P0-1 | 线上格式 |'].join('\n'),
    );
    const table = container.querySelector('.md-table-wrap table');
    expect(table).toBeTruthy();
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      '编号',
      '缺口',
    ]);
    const cells = [...container.querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cells).toEqual(['P0-1', '线上格式']);
    // 表格不能再以裸竖线形式漏到段落里。
    expect(container.textContent).not.toContain('| :--');
  });
});
