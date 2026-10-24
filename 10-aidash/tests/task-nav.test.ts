import { describe, expect, it } from 'vitest';
import { stepTaskId } from '../src/web/src/lib/task-nav.js';

// 仅测试纯函数：不启动服务、不写数据库、不涉及任何 API 或 schema。
// 用户要求“左右方向键上下翻阅”，这里固定住边界与循环语义，防止后续改树排序时悄悄改变行为。
describe('stepTaskId', () => {
  const ids = ['a', 'b', 'c'];

  it('没有选中项时从列表头/尾进入', () => {
    expect(stepTaskId(ids, null, 'next')).toBe('a');
    expect(stepTaskId(ids, null, 'prev')).toBe('c');
  });

  it('中间项前后移动', () => {
    expect(stepTaskId(ids, 'b', 'next')).toBe('c');
    expect(stepTaskId(ids, 'b', 'prev')).toBe('a');
  });

  it('到边界后循环，避免用户卡在最后一项', () => {
    expect(stepTaskId(ids, 'c', 'next')).toBe('a');
    expect(stepTaskId(ids, 'a', 'prev')).toBe('c');
  });

  it('选中项被筛选掉时按入口语义处理', () => {
    expect(stepTaskId(ids, 'missing', 'next')).toBe('a');
    expect(stepTaskId(ids, 'missing', 'prev')).toBe('c');
  });

  it('空列表返回 null', () => {
    expect(stepTaskId([], 'a', 'next')).toBeNull();
  });
});
