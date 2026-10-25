import { z } from 'zod';
import { channelKeySchema } from '../../../shared/schemas.js';
import { runTool } from './shared.js';
import type { ToolDeps } from './shared.js';

const digestShape = {
  channel_key: channelKeySchema.optional(),
  since: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(50).optional(),
};

/** 注册摘要工具（MCP-019）。 */
export function registerDigestTools({ server, ctx, log }: ToolDeps): void {
  server.registerTool(
    'digest.get',
    {
      title: '取当前摘要',
      description: '拿到用户当前最关心的 P0/P1 决策、最近状态与建议；开场先调它。',
      inputSchema: digestShape,
    },
    async (args) =>
      runTool('digest.get', log, () => {
        const input = z.object(digestShape).parse(args);
        const digest = ctx.services.cards.digest(input.channel_key);
        const sinceMs = input.since ? Date.parse(input.since) : null;
        const limit = input.limit ?? digest.p0_cards.length;
        const trim = <T extends { updated_at: string }>(items: T[]): T[] =>
          items
            .filter((item) => sinceMs === null || Date.parse(item.updated_at) >= sinceMs)
            .slice(0, limit);
        return {
          ...digest,
          p0_cards: trim(digest.p0_cards),
          p1_cards: trim(digest.p1_cards),
          recent_status: trim(digest.recent_status),
          recent_suggestions: trim(digest.recent_suggestions),
        };
      }),
  );
}
