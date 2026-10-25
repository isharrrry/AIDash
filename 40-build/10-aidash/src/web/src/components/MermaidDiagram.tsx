import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { viewBoxFromBounds } from '../lib/mermaid-viewbox';

type MermaidApi = typeof import('mermaid')['default'];

/**
 * mermaid 是重依赖（解析器 + 布局引擎），只在页面真的出现 ```mermaid 围栏时才加载。
 *
 * 用一个模块级 Promise 做单例：
 *  * 避免每个图各初始化一次，重复注册主题与安全配置；
 *  * 动态 import 让首屏（任务树/决策台）不必为“可能永远不出现的图”付下载成本。
 */
let mermaidLoader: Promise<MermaidApi> | null = null;
let renderSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  mermaidLoader ??= import('mermaid').then((module) => {
    const api = module.default;
    api.initialize({
      startOnLoad: false,
      // strict 是 mermaid 官方为“不可信输入”提供的档位：
      // 标签里的 HTML 会被转义，click 回调与 javascript: 链接会被禁用。
      // 报告正文来自模型输出，不能按可信 HTML 处理。
      securityLevel: 'strict',
      // 渲染失败时不要让 mermaid 自己往 body 注入一张错误图；错误由本组件接管。
      suppressErrorRendering: true,
      theme: 'neutral',
      fontFamily: 'inherit',
    });
    return api;
  });
  return mermaidLoader;
}

/**
 * 把 ```mermaid 围栏渲染成 SVG。
 *
 * 为什么允许 dangerouslySetInnerHTML：
 * 这里的 HTML 不是原文，而是 mermaid 在 strict 模式下生成的 SVG；
 * 原文只作为图定义传入，标签文本已被转义。失败时退回普通代码块，绝不吞掉内容。
 */
export function MermaidDiagram({ code }: { code: string }): ReactElement {
  const reactId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // mermaid.render 返回的 SVG 可能带着一个过早计算的 viewBox：
  // 它在最终布局前调用 getBBox()，把临时测量尺寸写进画布，图就被缩成空白中的小点。
  // 插入 DOM 后按真实包围盒校正一次；requestAnimationFrame 保证节点已完成布局。
  useEffect(() => {
    if (!svg) return;
    const apply = (): void => {
      const node = containerRef.current?.querySelector('svg');
      // querySelector 的类选择器只能推断出 Element，getBBox 是 SVG 元素专有 API，需要显式收窄。
      const root = (node?.querySelector('g.root') ?? node?.querySelector('g')) as SVGGElement | null;
      if (!node || !root) return;
      const box = root.getBBox();
      const fixed = viewBoxFromBounds(box);
      if (!fixed) return;
      node.setAttribute('viewBox', fixed);
      node.style.maxWidth = `${box.width + 16}px`;
    };
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [svg]);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    // useId 自带冒号，不能直接进 DOM id；再拼自增序号，避免同一毫秒内多个图撞 id。
    const safeId = reactId.replace(/[^A-Za-z0-9_-]/g, '');
    const renderId = `aidash-mermaid-${safeId}-${++renderSeq}`;

    loadMermaid()
      .then((mermaid) => mermaid.render(renderId, code))
      .then((result) => {
        if (!cancelled) setSvg(result.svg);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        // 只留第一行：mermaid 的解析错误常带一大段内部栈，整段塞进页面会淹没正文。
        setError(message.split('\n')[0]?.slice(0, 300) || '未知错误');
        // 解析失败时 mermaid 可能残留临时容器；清理掉，避免刷新后 body 越积越多。
        document.getElementById(renderId)?.remove();
      });

    return () => {
      cancelled = true;
    };
  }, [code, reactId]);

  if (error) {
    return (
      <div className="mermaid-block mermaid-error">
        <p className="muted small">Mermaid 图渲染失败：{error}</p>
        <pre className="md-code">
          <code data-lang="mermaid">{code}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    // 加载/渲染期间先显示源码：用户至少能看到图定义，不会面对一块空白。
    return (
      <pre className="md-code mermaid-pending">
        <code data-lang="mermaid">{code}</code>
      </pre>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-block"
      role="img"
      aria-label="Mermaid 图"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
