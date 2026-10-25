import { describe, expect, it } from 'vitest';
import { viewBoxFromBounds } from '../src/web/src/lib/mermaid-viewbox.js';

/**
 * Mermaid viewBox 校正回归。
 *
 * 这组用例守的是“图能被看见”：
 * 1. 正常包围盒按内容加 padding 换算，不能把图缩进巨大的空白画布；
 * 2. 空尺寸或非有限值说明布局还没完成，必须返回 null，交由调用方保留原 viewBox；
 * 3. padding 可配置，方便以后与 mermaid 的 diagramPadding 对齐。
 */
describe('Mermaid viewBox 校正', () => {
  it('用真实内容包围盒加内边距', () => {
    expect(viewBoxFromBounds({ x: 8, y: 8, width: 226, height: 51 })).toBe('0 0 242 67');
  });

  it('空尺寸或非有限值返回 null，不覆盖原 viewBox', () => {
    expect(viewBoxFromBounds({ x: 0, y: 0, width: 0, height: 51 })).toBeNull();
    expect(viewBoxFromBounds({ x: Number.NaN, y: 0, width: 10, height: 10 })).toBeNull();
  });

  it('支持自定义内边距', () => {
    expect(viewBoxFromBounds({ x: 0, y: 0, width: 100, height: 50 }, 4)).toBe('-4 -4 108 58');
  });
});
