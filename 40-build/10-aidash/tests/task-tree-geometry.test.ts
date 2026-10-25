import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TREE_GAP,
  TREE_STEP,
  TREE_TOGGLE_SIZE,
  treeElbowToTitleWidth,
  treeElbowToToggleWidth,
  treeParentLineX,
  treeToggleCenterX,
} from '../src/web/src/lib/task-tree.js';

/**
 * 任务树几何契约：JSX 算的 x、CSS 画的线、缩放手感，三者必须说同一件事。
 *
 * 为什么单独守这一处像素：用户已经连着反馈两轮「三角形偏移」「线粗细不一致」。
 * 根因不是某一次写错，而是同一套几何被拆成三处各写一遍
 * （TaskTree.tsx 的 inline style、styles.css 的规则、以及 125% 缩放下的物理像素），
 * 谁都不知道另外两处的存在。这里把它们钉在一起。
 *
 * 推导（相对标题列左边缘）：
 *   [缩进块 depth*16] gap 4 [收纳按钮 22] gap 4 [标题]
 *   第 d 层按钮中心 = d*16 + 4 + 11 = d*16 + 15
 *   第 d 层的父连线 = 第 d-1 层按钮中心 = d*16 - 1
 */

const CSS = readFileSync(new URL('../src/web/src/styles.css', import.meta.url), 'utf8');

/** 取出某条规则的大括号内容；规则体内不会嵌套 }，所以不必做括号配对。 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(css);
  if (!match) throw new Error(`样式表里找不到规则：${selector}`);
  return match[1];
}

function pxOf(body: string, pattern: RegExp): number {
  const match = pattern.exec(body);
  if (!match) throw new Error(`规则里找不到 ${pattern}`);
  return Number(match[1]);
}

describe('任务树几何：坐标推导', () => {
  it('按钮中心随层级线性右移，根层靠补 4px 间距与公式对齐', () => {
    // 根层没有缩进块，styles.css 给它补了 TREE_GAP 的 margin-left。
    expect(treeToggleCenterX(0)).toBe(TREE_GAP + TREE_TOGGLE_SIZE / 2); // 15
    expect(treeToggleCenterX(1)).toBe(31);
    expect(treeToggleCenterX(2)).toBe(47);
    // 每深一层恰好右移一格，不多不少。
    expect(treeToggleCenterX(2) - treeToggleCenterX(1)).toBe(TREE_STEP);
  });

  it('子节点的竖线正对父节点按钮中心', () => {
    expect(treeParentLineX(1)).toBe(treeToggleCenterX(0));
    expect(treeParentLineX(2)).toBe(treeToggleCenterX(1));
    expect(treeParentLineX(5)).toBe(treeToggleCenterX(4));
  });

  it('横臂长度：到按钮中心 16px，到标题前 30px', () => {
    expect(treeElbowToToggleWidth(1)).toBe(16);
    // 标题起点 16 + 4 + 22 + 4 = 46，竖线在 15，再留 1px 空隙 → 30。
    expect(treeElbowToTitleWidth(1)).toBe(30);
    // 横臂起点是竖线，终点是按钮中心，长度等于一格加半个按钮再减回去，
    // 所以对任意层级都应该是同一个常数。
    for (const depth of [1, 2, 3, 7]) {
      expect(treeElbowToToggleWidth(depth)).toBe(16);
    }
  });
});

describe('任务树几何：125% 缩放下各层粗细一致', () => {
  /**
   * 线的视觉粗细由「CSS 像素 × 缩放比」落在物理像素的哪个小数位置决定。
   * 只要所有层级的线小数位置相同，抗锯齿结果就相同，看上去才一样粗。
   * 旧档位 18px 时 18 × 1.25 = 22.5，逐层在 .0 / .5 之间跳，这正是粗细差异的来源。
   */
  const scales = [1, 1.25, 1.5, 1.75, 2];

  it.each(scales)('缩放 %s 下所有层级的竖线落在同一小数位置', (scale) => {
    const fractions = [1, 2, 3, 4, 5].map((depth) => {
      const physical = treeParentLineX(depth) * scale;
      return Number((physical % 1).toFixed(4));
    });
    expect(new Set(fractions).size).toBe(1);
  });

  it.each(scales)('缩放 %s 下父节点竖线与子节点横臂互相对齐', (scale) => {
    // ::before 从父节点按钮中心下来，子节点横臂从父连线出去，两者必须同 x。
    // 父节点在 depth，子节点在 depth + 1。
    const parentLine = treeToggleCenterX(1) * scale;
    const childLine = treeParentLineX(2) * scale;
    expect(parentLine).toBe(childLine);
  });
});

describe('任务树几何：styles.css 与 lib 常量不能各写一套', () => {
  it('父节点竖线公式用的是同一组数字', () => {
    const body = ruleBody(CSS, '.task-title-cell.has-children.expanded::before');
    const match = /calc\(var\(--task-depth, 0\) \* (\d+)px \+ (\d+)px\)/.exec(body);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(TREE_STEP);
    expect(Number(match?.[2])).toBe(TREE_GAP + TREE_TOGGLE_SIZE / 2);
  });

  it('收纳按钮边长与 font-size 都是 22px', () => {
    const box = ruleBody(CSS, '.task-toggle,\n.task-toggle-spacer');
    expect(pxOf(box, /flex: 0 0 (\d+)px/)).toBe(TREE_TOGGLE_SIZE);
    expect(pxOf(box, /width: (\d+)px/)).toBe(TREE_TOGGLE_SIZE);

    const toggle = ruleBody(CSS, '.task-toggle');
    // 三角形字号跟按钮同尺寸：18px 的 ▾ 在密集任务树里偏小，也是用户点名的问题。
    expect(pxOf(toggle, /font-size: (\d+)px/)).toBe(TREE_TOGGLE_SIZE);
  });

  it('横臂从缩进块右侧 1px 起画，长度与 lib 算出来的一致', () => {
    const elbow = ruleBody(CSS, '.task-elbow');
    // 竖线 x = 16d - 1，缩进块宽 16d，所以相对右边缘是 -1px。
    expect(pxOf(elbow, /left: calc\(100% - (\d+)px\)/)).toBe(TREE_STEP - treeParentLineX(1));
    expect(pxOf(elbow, /width: (\d+)px/)).toBe(treeElbowToTitleWidth(1));

    const withChildren = ruleBody(CSS, '.task-title-cell.has-children .task-elbow');
    expect(pxOf(withChildren, /width: (\d+)px/)).toBe(treeElbowToToggleWidth(1));
  });

  it('根层补回缺失的 4px 间距，否则根按钮中心比子节点的线左 4px', () => {
    // 这条规则是「根层没有缩进块」的唯一补偿点，删了偏移就会回来。
    expect(CSS).toContain(".task-title-cell[data-depth='0'] > .task-toggle");
    expect(CSS).toContain(".task-title-cell[data-depth='0'] > .task-toggle-spacer");
    const rootPad = ruleBody(CSS, ".task-title-cell[data-depth='0'] > .task-toggle,\n.task-title-cell[data-depth='0'] > .task-toggle-spacer");
    expect(pxOf(rootPad, /margin-left: (\d+)px/)).toBe(TREE_GAP);
  });

  it('缩进块靠 margin-bottom 压过行边框，这条也不能丢', () => {
    // 丢了就会在每行底部露出一段 1px 的断口，看起来像虚线。
    const indent = ruleBody(CSS, '.task-indent');
    expect(indent).toContain('margin-bottom: -1px');
  });

  it('横臂中心与按钮中心在同一 y 上（浏览器实测过的那 1px）', () => {
    /*
     * 缩进块因为有 margin-bottom: -1px，比行高多 1px，它的 50% 就比行中线低 0.5px；
     * 横线自身 1px 高、几何中心再低 0.5px。两段加起来正好 1px，
     * 表现为「三角在横线上方一点」。这两个补偿值不能省。
     */
    expect(ruleBody(CSS, '.task-elbow')).toContain('top: calc(50% - 1px)');
    expect(ruleBody(CSS, '.task-branch-last')).toContain('bottom: calc(50% - 0.5px)');
  });
});
