import { Router } from 'express';
import { z } from 'zod';
import { channelKeySchema } from '../../../shared/schemas.js';
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
const patchSchema = z
  .object({
    status: z.enum(['active', 'archived']).optional(),
    alias: z.string().max(200).nullable().optional(),
  })
  .refine((value) => value.status !== undefined || value.alias !== undefined, {
    message: 'status or alias is required',
  });

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
      // 两个字段各自独立：只改别名时状态不动，只归档时别名保留。
      let view: ChannelView | undefined;
      if (body.status !== undefined) {
        view = ctx.services.channels.setStatus(key, body.status, serviceCtx);
      }
      if (body.alias !== undefined) {
        view = ctx.services.channels.setAlias(key, body.alias, serviceCtx);
      }
      ok(res, view);
    }),
  );

  return router;
}
