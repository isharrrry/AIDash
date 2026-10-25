import type { ReactElement } from 'react';
import { getProjectMemory, updateProjectMemory } from '../api/endpoints';
import { MemoryEditorPanel } from './MemoryEditorPanel';

/**
 * 主通道记忆面板。
 *
 * “主通道”= channel_key 的 project 段（AGENTS §3.4）：同一个项目的多个话题通道
 * 共用一份记忆，agent 通过 MCP 追加/搜索，用户在 Web 上整体编辑与预览。
 *
 * 编辑/冲突/渲染逻辑在 MemoryEditorPanel 里，和 AIDash 自己的记忆共用一份：
 * 两者只是“存哪里、给谁用”不同，读写体验必须一致。
 */
export function ProjectMemoryPanel({
  project,
  compact = false,
}: {
  project: string;
  compact?: boolean;
}): ReactElement {
  return (
    <MemoryEditorPanel
      title="主通道记忆"
      badge={<span className="tag">{project}</span>}
      ariaLabel={`主通道记忆 ${project}`}
      load={() => getProjectMemory(project)}
      save={(contentMd, expectedVersion) =>
        updateProjectMemory(project, contentMd, expectedVersion)
      }
      reloadKey={project}
      compact={compact}
      editingHint={
        <>
          一行一条长期约束，建议写成 <code>- [日期] [key] 内容</code>；
          agent 会用 key 搜索这些行。不要写令牌/密码，也不要写进度流水。
        </>
      }
      emptyHint={
        <>
          还没有记忆。点“写记忆”记录跨会话仍需遵守的约束、踩过的坑和项目偏好；
          agent 下次开场会通过 MCP 读取或搜索这里。
        </>
      }
    />
  );
}
