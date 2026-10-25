import { z } from 'zod';
import { runTool } from './shared.js';
import type { ToolDeps } from './shared.js';

/** 注册知识库工具（MCP-017~018）。知识库只读，不提供写入工具。 */
export function registerKbTools({ server, ctx, log }: ToolDeps): void {
  server.registerTool(
    'kb.search',
    {
      title: '搜知识库',
      description: '全文检索只读知识库；中文按字粒度建索引，支持任意子串起点。',
      inputSchema: {
        query: z.string().min(1).max(500),
        type: z.string().max(64).optional(),
        tags: z.array(z.string().max(64)).max(10).optional(),
        top_k: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) =>
      runTool('kb.search', log, () => {
        const input = z
          .object({
            query: z.string().min(1).max(500),
            type: z.string().max(64).optional(),
            tags: z.array(z.string().max(64)).max(10).optional(),
            top_k: z.number().int().min(1).max(50).optional(),
          })
          .parse(args);
        return ctx.services.kb.search(input.query, {
          type: input.type,
          tags: input.tags,
          top_k: input.top_k,
        });
      }),
  );

  server.registerTool(
    'kb.get',
    {
      title: '读知识库文章',
      description: '按相对路径读取文章；路径越界（../）会被拒绝。',
      inputSchema: { path: z.string().min(1).max(500) },
    },
    async (args) =>
      runTool('kb.get', log, () => {
        const input = z.object({ path: z.string().min(1).max(500) }).parse(args);
        return ctx.services.kb.get(input.path);
      }),
  );
}
