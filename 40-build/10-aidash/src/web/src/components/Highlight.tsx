/**
 * KB 搜索片段高亮。
 *
 * 后端 snippet 只应含 <mark>...</mark>。这里把这两个标记当“开关”，
 * 其余内容一律作为 React 文本节点输出；即使 snippet 里混入了 <script>，
 * 也只会显示成字面文字，不会被执行。
 */
import { Fragment } from 'react';
import type { ReactElement, ReactNode } from 'react';

export function Highlight({ text }: { text: string }): ReactElement {
  const parts = text.split(/(<mark>|<\/mark>)/i);
  let inside = false;
  const nodes: ReactNode[] = [];

  parts.forEach((part, index) => {
    const lowered = part.toLowerCase();
    if (lowered === '<mark>') {
      inside = true;
      return;
    }
    if (lowered === '</mark>') {
      inside = false;
      return;
    }
    if (!part) return;
    nodes.push(inside ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>);
  });

  return <>{nodes}</>;
}
