import { z } from 'zod';
import {
  // tools/list 只公开基础形状；cardAskSchema 已包 superRefine，取不到 .shape，
  // 所以这里单独导入 cardAskBase 给 MCP 客户端看参数。
  cardAskBase,
  cardAskSchema,
  cardPostBase,
  cardPostSchema,
  cardStatusSchema,
  cardTypeSchema,
  channelKeySchema,
  idSchema,
  prioritySchema,
} from '../../../shared/schemas.js';
import { capMcpWaitSeconds } from '../wait-cap.js';
import { pageShape, runTool } from './shared.js';
import type { ToolDeps } from './shared.js';

const mcpCardListShape = {
  channel_key: channelKeySchema.optional(),
  // 按通道所属项目过滤：一个项目下可能有多个话题通道，查重时要能跨通道看。
  project: z.string().min(1).max(200).optional(),
  type: cardTypeSchema.optional(),
  status: cardStatusSchema.optional(),
  priority: prioritySchema.optional(),
  q: z.string().max(200).optional(),
  task_id: z.string().max(64).optional(),
  include_archived: z.boolean().optional(),
  // 默认省略正文：列表只给 preview_md；需要全文（如任务信息流/导出）显式传 true。
  include_body: z.boolean().optional(),
  ...pageShape,
};

/** 注册卡片工具（MCP-004~008）。 */
export function registerCardTools({ server, ctx, mcpCtx, signal, log }: ToolDeps): void {
  server.registerTool(
    'card.post',
    {
      title: '发卡',
      description:
        '发一张六类型卡片（info/handoff/question/suggestion/status/artifact）。' +
        '一张卡只说一件事；正文命中令牌/密码模式会整单拒绝。' +
        '非 question 卡必须带 task_id：信息必须挂在任务下，用户才能按任务逐条查看并消除未读；' +
        '只有 question 允许不挂任务。',
      // MCP 的 tools/list 需要基础 shape；完整类型守卫在 handler 里用 cardPostSchema 再校验一次。
      inputSchema: cardPostBase.shape,
    },
    async (args) =>
      runTool('card.post', log, () => {
        const input = cardPostSchema.parse(args);
        const result = ctx.services.cards.post(input, mcpCtx);
        return { card: result.card, created: result.created };
      }),
  );

  server.registerTool(
    'card.ask',
    {
      title: '发决策卡并等待',
      description:
        '发一张 question 卡，MCP 侧最多阻塞 25 秒（AIDASH_MCP_WAIT_CAP_SECONDS 可调）。' +
        '返回 pending 不是失败：卡片已经创建，记下 card_id，先做别的，' +
        '稍后用 card.wait 或 card.get 取答案。不要一次挂 300 秒，客户端会先判超时。',
      // 只能取 base 的 shape；完整校验（四段 + 选项规则）在 handler 里跑 cardAskSchema。
      inputSchema: cardAskBase.shape,
    },
    async (args) =>
      runTool('card.ask', log, async () => {
        const input = cardAskSchema.parse(args);
        // 只改等待时长，不改卡片内容与返回结构：超时仍然返回 pending + card_id。
        return ctx.services.decisions.ask(
          {
            ...input,
            wait_seconds: capMcpWaitSeconds(
              input.wait_seconds,
              90,
              ctx.config.maxWaitSeconds,
              ctx.config.mcpWaitCapSeconds,
            ),
          },
          mcpCtx,
          signal,
        );
      }),
  );

  server.registerTool(
    'card.get',
    {
      title: '读单张卡',
      description: '按 card_id 读取卡片详情（含答案与增强信息）。',
      inputSchema: { card_id: idSchema },
    },
    async (args) =>
      runTool('card.get', log, () => {
        const input = z.object({ card_id: idSchema }).parse(args);
        return ctx.services.cards.get(input.card_id);
      }),
  );

  server.registerTool(
    'card.wait',
    {
      title: '继续等答案',
      description:
        '继续等待已有决策卡的答案；MCP 侧最多等 25 秒，超时仍返回 pending（卡片不会消失），' +
        '不替调用方做决定。可以多次调用，每次等一小段。',
      inputSchema: {
        card_id: idSchema,
        wait_seconds: z.number().int().min(0).max(300).optional(),
      },
    },
    async (args) =>
      runTool('card.wait', log, async () => {
        const input = z
          .object({
            card_id: idSchema,
            wait_seconds: z.number().int().min(0).max(300).optional(),
          })
          .parse(args);
        return ctx.services.decisions.wait(
          input.card_id,
          capMcpWaitSeconds(
            input.wait_seconds,
            90,
            ctx.config.maxWaitSeconds,
            ctx.config.mcpWaitCapSeconds,
          ),
          signal,
        );
      }),
  );

  server.registerTool(
    'card.list',
    {
      title: '列卡/查重',
      description:
        '按通道、类型、状态、优先级、关键词筛选卡片；发卡前先用它查重。' +
        '默认只返回 preview_md，正文/背景等重字段为 null；需要全文时传 include_body=true。',
      inputSchema: mcpCardListShape,
    },
    async (args) =>
      runTool('card.list', log, () => {
        const input = z.object(mcpCardListShape).parse(args);
        return ctx.services.cards.list({
          channelKey: input.channel_key,
          project: input.project,
          types: input.type ? [input.type] : undefined,
          statuses: input.status ? [input.status] : undefined,
          priorities: input.priority ? [input.priority] : undefined,
          includeArchived: input.include_archived,
          includeBody: input.include_body,
          q: input.q,
          taskId: input.task_id,
          page: input.page,
          page_size: input.page_size,
        });
      }),
  );
}
