import { z } from 'zod';
import { channelKeySchema } from '../../../shared/schemas.js';
import { runTool } from './shared.js';
import type { ToolDeps } from './shared.js';

/** 注册通道工具（MCP-003）。 */
export function registerChannelTools({ server, ctx, mcpCtx, log }: ToolDeps): void {
  server.registerTool(
    'channel.upsert',
    {
      title: '建/更新通道',
      description:
        '通道 key 用 host/project/topic 三段式；已归档通道会因发卡自动恢复。' +
        'alias 是给人看的一句话概述（例如“任务树界面改造”），可随时传新值修改；' +
        '不传不会清空已有别名。',
      inputSchema: {
        channel_key: channelKeySchema,
        title: z.string().max(200).optional(),
        // 别名是展示层标签：agent 中途改它不影响 channel_key 与历史链接。
        alias: z.string().max(200).optional().nullable(),
        // 可空：旧通道没有工作路径；传非空值时 service 会登记或更正。
        workdir: z.string().max(500).optional().nullable(),
      },
    },
    async (args) =>
      runTool('channel.upsert', log, () => {
        const input = z
          .object({
            channel_key: channelKeySchema,
            title: z.string().max(200).optional(),
            alias: z.string().max(200).optional().nullable(),
            workdir: z.string().max(500).optional().nullable(),
          })
          .parse(args);
        const result = ctx.services.channels.ensure(input, mcpCtx);
        return {
          channel_key: result.channel.channel_key,
          alias: result.channel.alias,
          id: result.channel.id,
          created: result.created,
          restored: result.restored,
        };
      }),
  );
}
