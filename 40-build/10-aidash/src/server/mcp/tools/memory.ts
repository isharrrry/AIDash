import {
  memoryAppendSchema,
  memoryGetSchema,
  memorySearchSchema,
  memoryUpdateSchema,
  projectNameSchema,
} from '../../../shared/schemas.js';
import { runTool } from './shared.js';
import type { ToolDeps } from './shared.js';

/** 注册主通道记忆工具（MCP-020~023）。 */
export function registerMemoryTools({ server, ctx, mcpCtx, log }: ToolDeps): void {
  server.registerTool(
    'memory.get',
    {
      title: '读主通道记忆',
      description:
        '读取某个主通道（project，即 channel_key 第二段）的完整记忆 Markdown。' +
        '记忆是跨话题通道复用的长期约束/踩坑/偏好；开场或接手项目时先读。' +
        '内容很长时优先用 memory.search 按 key 找行，避免把整篇灌进上下文。',
      inputSchema: { project: projectNameSchema },
    },
    async (args) =>
      runTool('memory.get', log, () => {
        const input = memoryGetSchema.parse(args);
        return ctx.services.memory.get(input.project);
      }),
  );

  server.registerTool(
    'memory.append',
    {
      title: '追加记忆行',
      description:
        '向主通道记忆追加若干行（一条约束一行，建议以日期/key 开头）。' +
        '默认按行去重：已经记过的行不会重复追加。' +
        '不要写进度流水、临时状态、令牌/密码；记忆只放长期有效的内容。',
      inputSchema: memoryAppendSchema.shape,
    },
    async (args) =>
      runTool('memory.append', log, () => {
        const input = memoryAppendSchema.parse(args);
        return ctx.services.memory.append(input, mcpCtx);
      }),
  );

  server.registerTool(
    'memory.search',
    {
      title: '按 key 搜记忆行',
      description:
        '在主通道记忆里按 key（大小写不敏感的子串）搜索，返回 1 基行号与命中行。' +
        '上下文有限时先搜再决定是否 memory.get；limit 控制最多返回几行。',
      inputSchema: memorySearchSchema.shape,
    },
    async (args) =>
      runTool('memory.search', log, () => {
        const input = memorySearchSchema.parse(args);
        return ctx.services.memory.search(input);
      }),
  );

  server.registerTool(
    'memory.update',
    {
      title: '整体编辑记忆',
      description:
        '用新内容整体替换主通道记忆；必须带 expected_version（先 memory.get 获取）。' +
        '版本不匹配返回 MEMORY_VERSION_CONFLICT，说明别人刚改过，需要重新读取并合并；' +
        '只是想补一条约束时用 memory.append，不要整体覆盖。',
      inputSchema: memoryUpdateSchema.shape,
    },
    async (args) =>
      runTool('memory.update', log, () => {
        const input = memoryUpdateSchema.parse(args);
        const result = ctx.services.memory.replace(input, mcpCtx);
        // 不回传整篇正文：调用方刚提交过 content_md，再回一份只会重复占用上下文。
        return {
          project: input.project,
          version: result.memory.version,
          changed: result.changed,
          line_count: result.memory.line_count,
          updated_at: result.memory.updated_at,
        };
      }),
  );
}
