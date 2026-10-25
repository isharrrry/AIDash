import type { ReactElement } from 'react';
import { getAssistantMemory, updateAssistantMemory } from '../api/endpoints';
import { MemoryEditorPanel } from './MemoryEditorPanel';

/**
 * AIDash 自己的记忆面板。
 *
 * 与主对话记忆的区别（虽然共用同一个编辑组件）：
 * - 全局只有一篇，没有 project 维度；
 * - 不通过 MCP 暴露，外部 agent 读写不到；
 * - 内容会在每次 AI 能力调用时追加到 system 提示词末尾；
 * - 每次汇报批次成功完成后，学习器会自动追加几条经验。
 *
 * 保存后回调父级刷新侧栏元数据（行数/修改时间），否则用户刚写完，
 * 左侧列表还显示“还没有记忆”，会以为没保存成功。
 */
export function AssistantMemoryPanel({
  onChanged,
}: {
  onChanged?: () => void;
}): ReactElement {
  return (
    <MemoryEditorPanel
      title="AIDash 自己的记忆"
      badge={<span className="badge">内置</span>}
      description="只给 AIDash 内部的 AI 能力使用：卡片分析、知识库建议、记忆归纳与汇报生成时，会追加到提示词末尾。"
      ariaLabel="AIDash 自己的记忆"
      load={getAssistantMemory}
      save={(contentMd, expectedVersion) => updateAssistantMemory(contentMd, expectedVersion)}
      reloadKey="assistant"
      editingHint={
        <>
          一行一条经验，建议写成 <code>- [日期] [key] 内容</code>；
          汇报完成后系统会自动追加，你也可以在这里修改或删除过时条目。
          不要写令牌/密码，也不要写一次性的汇报结论。
        </>
      }
      emptyHint={
        <>
          还没有记忆。每次汇报成功生成后，AIDash 会自动从汇报里提炼几条可复用的经验；
          也可以点“写记忆”手动补充“以后遇到什么情况该怎么做”。
        </>
      }
      onSaved={onChanged}
    />
  );
}
