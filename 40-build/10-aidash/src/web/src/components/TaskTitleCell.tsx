import type { CSSProperties, DragEvent, ReactElement } from 'react';
import { TREE_STEP, treeParentLineX } from '../lib/task-tree';
import type { TreeNode } from '../types';
import { MarkdownInline } from './Markdown';

export interface TaskTitleCellProps {
  node: TreeNode;
  depth: number;
  isLast: boolean;
  trunks: number[];
  hasChildren: boolean;
  expanded: boolean;
  busyId: string | null;
  onToggle: () => void;
  onDragStart: (node: TreeNode, event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

/**
 * 标题列：层级线、展开按钮、拖拽把手、未读/结束通知标记。
 *
 * 为什么单独拆成组件：这一列的几何规则最多、注释最长，
 * 和 TaskNode 的行操作混在一起会让递归组件继续膨胀；拆开后 TaskTree 各文件都能保持短小。
 */
export function TaskTitleCell({
  node,
  depth,
  isLast,
  trunks,
  hasChildren,
  expanded,
  busyId,
  onToggle,
  onDragStart,
  onDragEnd,
}: TaskTitleCellProps): ReactElement {
  return (
    <span
      className={
        hasChildren
          ? `task-title-cell has-children${expanded ? ' expanded' : ''}`
          : 'task-title-cell'
      }
      style={{ '--task-depth': depth } as CSSProperties}
      // data-depth 给 CSS 用：根层没有缩进块，要单独补回一个间距，
      // 否则根节点收纳按钮的中心会比公式算出来的位置左 4px。
      data-depth={depth}
    >
      {/*
        层级线：一条把当前行接到直接父节点的竖线 + 一个横向分支，
        再加上祖先延续线。用独立缩进块而不是给整行加 padding，
        是为了让状态/类型/时间列在所有层级上保持对齐。

        祖先延续线只画「还有下一个兄弟」的层级：
        深度优先展开后，兄弟之间隔着对方整棵子树，不贯穿就会断线；
        而没有下一个兄弟的祖先不需要延续，多画反而会把两个不同父节点的
        同深度行接成一条假连线（这正是上一版按每行独立画线的问题）。
        自己那一段在 isLast 时只画上半截，
        和父节点下来的线在行中线接成 └ 形。

        缩进档位和所有 x 坐标都由 lib/task-tree.ts 的 TREE_STEP /
        treeParentLineX 推导，styles.css 里写的是同一组数字的另一半——
        改布局时三处必须一起改，tests/task-tree-geometry.test.ts 会看着。
      */}
      {depth > 0 ? (
        <span
          className="task-indent"
          style={{ width: `${depth * TREE_STEP}px` }}
          aria-hidden="true"
        >
          {trunks.map((level) => (
            <span
              key={`trunk-${level}`}
              className="task-trunk"
              // 延续线要落在那一级祖先的收纳按钮中心下方。
              style={{ left: `${treeParentLineX(level)}px` }}
            />
          ))}
          <span
            className={isLast ? 'task-branch task-branch-last' : 'task-branch'}
            // 自己这根竖线接的是直接父节点（depth - 1）的按钮中心。
            style={{ left: `${treeParentLineX(depth)}px` }}
          />
          <span className="task-elbow" />
        </span>
      ) : null}
      {hasChildren ? (
        <button
          type="button"
          className="task-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? '收起子任务' : '展开子任务'}
          title={expanded ? '收起子任务' : '展开子任务'}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className="task-toggle-spacer" aria-hidden="true" />
      )}
      {/*
        只有标题是拖拽把手，不是整行：整行 draggable 会让点击打开详情、
        选中文字、拖滚动条都变得别扭；标题是用户按住时的自然目标。
      */}
      <span
        className="task-title"
        title={`${node.title}（按住可拖动到其他任务下）`}
        draggable={busyId !== node.id}
        onDragStart={(event) => onDragStart(node, event)}
        onDragEnd={onDragEnd}
      >
        <MarkdownInline source={node.title} />
      </span>
      {/*
        未读红点放在标题后面，而不是单独一列：
        它的作用是“这条任务有新消息”，和标题是同一个判断动作；
        单独成列会让本来就紧张的横向空间再挤掉一截。
      */}
      {node.unread_count > 0 ? (
        <span
          className="task-unread-dot"
          title={`${node.unread_count} 条未读信息`}
          aria-label={`${node.unread_count} 条未读信息`}
        >
          {node.unread_count > 99 ? '99+' : node.unread_count}
        </span>
      ) : null}
      {/*
        背景色之外再留一个小圆点：色觉差异或高对比度主题下，
        纯背景高亮可能不够明显；圆点带 title，仍属于“点整行确认”。
      */}
      {node.end_notice_pending ? (
        <span
          className="task-end-notice-dot"
          title="任务已结束，点一下确认"
          aria-label="任务已结束，点一下确认"
        />
      ) : null}
    </span>
  );
}
