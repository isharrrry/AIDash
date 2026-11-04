import { Router } from 'express';
import { z } from 'zod';
import {
  ITEM_STAGES,
  PRIORITIES,
  channelKeySchema,
} from '../../../shared/schemas.js';
import type { ChannelView } from '../../../shared/types.js';
import type { AppContext } from '../../context.js';
import { ctxOf } from '../middleware.js';
import {
  asyncHandler,
  ok,
  queryBool,
  queryInt,
  queryString,
  requireString,
} from '../respond.js';

const createSchema = z.object({
  channel_key: channelKeySchema,
  title: z.string().max(200).optional().nullable(),
  // 别名是展示层的一句话概述；允许为空，空值回退到 topic/title/channel_key。
  alias: z.string().max(200).optional().nullable(),
  // 工作路径允许为空（兼容旧通道），有值时由 channel-service 登记/更正。
  workdir: z.string().max(500).optional().nullable(),
});

/**
 * 通道补丁。
 *
 * status 与 alias 都可选，但至少给一个：只传 `{}` 的请求既不会改状态也不会改别名，
 * 直接拒绝比“200 但什么都没发生”更容易排查。
 */
const metaTextSchema = z.string().trim().max(200).nullable().optional();
const metaListSchema = z
  .array(z.string().trim().min(1).max(50))
  .max(30)
  .optional();

/** 事项人工属性补丁：字段可选，出现即覆盖，null 表示清空。 */
const metaPatchSchema = z
  .object({
    owner: metaTextSchema,
    priority: z.enum(PRIORITIES).nullable().optional(),
    stage: z.enum(ITEM_STAGES).nullable().optional(),
    group: metaTextSchema,
    participants: metaListSchema,
    tags: metaListSchema,
    iteration: metaTextSchema,
    product: metaTextSchema,
    category: metaTextSchema,
    remark: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    status: z.enum(['active', 'archived']).optional(),
    alias: z.string().max(200).nullable().optional(),
    meta: metaPatchSchema.optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined || value.alias !== undefined || value.meta !== undefined,
    {
      message: 'status, alias or meta is required',
    },
  );

/** 通道路由：列表、建通道、归档/恢复。发卡与建任务会自动 ensure，不需要先建。 */
export function channelsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      const result = ctx.services.channels.list({
        includeArchived: queryBool(req.query.include_archived),
        q: queryString(req.query.q),
        page: queryInt(req.query.page, 1, 1, 1_000_000),
        page_size: queryInt(req.query.page_size, 50, 1, ctx.config.pageSizeMax),
      });
      ok(res, result);
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const body = createSchema.parse(req.body);
      const result = ctx.services.channels.ensure(body, ctxOf(res, ctx.config));
      ok(res, result, result.created ? 201 : 200);
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const idOrKey = requireString(req.params.id, 'id');
      const body = patchSchema.parse(req.body);
      // 前端可能拿 id 也可能拿 key，这里统一解析成 key 再交给 service。
      const key = ctx.repos.channels.get(idOrKey)?.channel_key ?? idOrKey;
      const serviceCtx = ctxOf(res, ctx.config);
      // 三个字段各自独立：只改别名时状态不动，只归档时别名/属性保留。
      let view: ChannelView | undefined;
      if (body.status !== undefined) {
        view = ctx.services.channels.setStatus(key, body.status, serviceCtx);
      }
      if (body.alias !== undefined) {
        view = ctx.services.channels.setAlias(key, body.alias, serviceCtx);
      }
      if (body.meta !== undefined) {
        view = ctx.services.channels.setMeta(key, body.meta, serviceCtx);
      }
      ok(res, view);
    }),
  );

  /**
   * 生成事项 AI 建议。
   *
   * 会先做本事项范围内的 grep（任务/卡片/汇报/项目记忆），再让模型按需追加检索，
   * 最后把建议写回 channel.meta_json。生成是同步等待：一轮通常 2~4 次 LLM 调用，
   * 页面按钮会显示“生成中”，不需要轮询任务队列。
   */
  router.post(
    '/:id/suggestion',
    asyncHandler(async (req, res) => {
      const idOrKey = requireString(req.params.id, 'id');
      const key = ctx.repos.channels.get(idOrKey)?.channel_key ?? idOrKey;
      const serviceCtx = ctxOf(res, ctx.config);
      const result = await ctx.services.itemSuggestions.generate(key);
      const channel = ctx.services.channels.setMeta(
        key,
        {
          ai_suggestion: result.suggestion,
          ai_suggestion_at: result.generated_at,
        },
        serviceCtx,
      );
      ok(res, { ...result, channel });
    }),
  );

  return router;
}
