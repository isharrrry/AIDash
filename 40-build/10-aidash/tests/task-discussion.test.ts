import { describe, expect, it } from 'vitest';
import {
  findOversizedTitle,
  MAX_CHILD_LINES,
  MAX_CHILD_TITLE,
  parseChildTitles,
} from '../src/web/src/lib/task-discussion.js';

/**
 * 讨论任务批量拆分的解析规则。
 *
 * 这组用例守的是“用户从 Markdown 里直接粘贴一堆问题”时的真实输入：
 * 空行、项目符号、有序列表都必须被清理，否则拆出来的任务标题会带着 “- ” 前缀。
 */
describe('讨论子任务拆分', () => {
  it('每行一个问题，忽略空行与首尾空白', () => {
    expect(parseChildTitles('  第一个问题\n\n  第二个问题  \n')).toEqual([
      '第一个问题',
      '第二个问题',
    ]);
  });

  it('剥离 Markdown 列表前缀（无序与有序）', () => {
    const source = ['- 风险是什么？', '* 成本多少？', '+ 还有什么备选？', '1. 什么时候做？', '2) 谁负责？'].join(
      '\n',
    );
    expect(parseChildTitles(source)).toEqual([
      '风险是什么？',
      '成本多少？',
      '还有什么备选？',
      '什么时候做？',
      '谁负责？',
    ]);
  });

  it('标题里的普通数字/符号不会被误剥', () => {
    // 只有“行首 + 分隔符”才当列表标记，2.0 版本、3D 这类内容必须原样保留。
    expect(parseChildTitles('2.0 版本要不要兼容？\n3D 打印方案可行吗？')).toEqual([
      '2.0 版本要不要兼容？',
      '3D 打印方案可行吗？',
    ]);
  });

  it('上限常量与超长检测保持一致', () => {
    expect(MAX_CHILD_LINES).toBeGreaterThan(0);
    expect(findOversizedTitle(['正常', 'x'.repeat(MAX_CHILD_TITLE)])).toBeNull();
    expect(findOversizedTitle(['正常', 'x'.repeat(MAX_CHILD_TITLE + 1)])).not.toBeNull();
  });
});
