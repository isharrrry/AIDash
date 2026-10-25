import { Router } from 'express';
import { z } from 'zod';
import {
  TASK_STATUSES,
  taskClaimSchema,
  taskCreateSchema,
  taskReleaseSchema,
  taskUpdateSchema,
} from '../../../shared/schemas.js';
import type { TaskStatus } from '../../../shared/types.js';
import type { AppContext } from '../../context.js';
import { ctxOf } from '../middleware.js';
import {
  asyncHandler,
  ok,
  queryBool,
  queryBoolOptional,
  queryInt,
  queryList,
  queryString,
  requireString,
} from '../respond.js';

const createSchema = taskCreateSchema.extend({
  submit: z.boolean().optional(),
});

const updateSchema = taskUpdateSchema.omit({ task_id: true });
const claimSchema = taskClaimSchema.omit({ task_id: true });
const releaseSchema = taskReleaseSchema.omit({ task_id: true });

const moveSchema = z.object({
  new_parent_id: z.string().max(64).nullable(),
});

const copySchema = z.object({
  new_parent_id: z.string().max(64).nullable().optional(),
});

function statusList(value: unknown): TaskStatus[] | undefined {
  const raw = queryList(value);
  if (!raw) return undefined;
  const allowed = new Set<string>(TASK_STATUSES);
  for (const item of raw) {
    if (!allowed.has(item)) {
      throw new z.ZodError([
        { code: 'custom', path: ['query'], message: `unsupported status: ${item}`, input: item },
      ]);
    }
  }
  return raw as TaskStatus[];
}

/** 任务路由。注意 `/tree` 必须注册在 `/:id` 之前，否则会被当成任务 id。 */
export function tasksRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      ok(
        res,
        ctx.services.tasks.list(
          {
            channel_key: queryString(req.query.channel_key),
            status: statusList(req.query.status),
            assignee: queryString(req.query.assignee),
            // 复盘入口：has_risk 含已解除，risk_open 只看仍未处理的隐患。
            // 必须保留三态：缺省 = 不筛；false 才是“排除带隐患任务”。
            has_risk: queryBoolOptional(req.query.has_risk),
            risk_open: queryBoolOptional(req.query.risk_open),
            page: queryInt(req.query.page, 1, 1, 1_000_000),
            page_size: queryInt(req.query.page_size, 50, 1, ctx.config.pageSizeMax),
          },
          // 默认不带 description_md：描述可能内嵌 base64 截图，批量列表不该背这个体积。
          // 需要正文的调用方显式传 include_description=true，或按 id 取详情。
          queryBool(req.query.include_description),
        ),
      );
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const body = createSchema.parse(req.body);
      const result = ctx.services.tasks.create(body, ctxOf(res, ctx.config), {
        submit: body.submit,
      });
      ok(res, result, result.created ? 201 : 200);
    }),
  );

  router.get(
    '/tree',
    asyncHandler((req, res) => {
      const channelKey = requireString(req.query.channel_key, 'channel_key');
      const depth = req.query.depth === undefined ? undefined : queryInt(req.query.depth, 20, 1, 50);
      ok(
        res,
        ctx.services.tasks.tree(
          channelKey,
          depth,
          queryBool(req.query.include_description),
        ),
      );
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      ok(res, ctx.services.tasks.get(requireString(req.params.id, 'id')));
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const id = requireString(req.params.id, 'id');
      const body = updateSchema.parse(req.body);
      ok(res, ctx.services.tasks.update({ ...body, task_id: id }, ctxOf(res, ctx.config)));
    }),
  );

  router.post(
    '/:id/claim',
    asyncHandler((req, res) => {
      const id = requireString(req.params.id, 'id');
      const body = claimSchema.parse(req.body);
      ok(res, ctx.services.tasks.claim({ ...body, task_id: id }, ctxOf(res, ctx.config)));
    }),
  );

  router.post(
    '/:id/release',
    asyncHandler((req, res) => {
      const id = requireString(req.params.id, 'id');
      const body = releaseSchema.parse(req.body);
      ok(res, ctx.services.tasks.release({ ...body, task_id: id }, ctxOf(res, ctx.config)));
    }),
  );

  router.post(
    '/:id/move',
    asyncHandler((req, res) => {
      const body = moveSchema.parse(req.body);
      ok(
        res,
        ctx.services.tasks.move(
          requireString(req.params.id, 'id'),
          body.new_parent_id,
          ctxOf(res, ctx.config),
        ),
      );
    }),
  );

  router.post(
    '/:id/copy',
    asyncHandler((req, res) => {
      const body = copySchema.parse(req.body ?? {});
      ok(
        res,
        ctx.services.tasks.copy(
          requireString(req.params.id, 'id'),
          body.new_parent_id ?? null,
          ctxOf(res, ctx.config),
        ),
      );
    }),
  );

  /**
   * 确认结束通知。
   *
   * 单独成一个动作而不是走 PATCH patch：它是“用户看过了”的查看回执，
   * 不应混进可编辑字段，否则任何调用方都能伪造/覆盖已读时间。
   * 服务端保证幂等；重复调用不会刷新第一次的已读时间。
   */
  router.post(
    '/:id/ack-end-notice',
    asyncHandler((req, res) => {
      ok(
        res,
        ctx.services.tasks.ackEndNotice(
          requireString(req.params.id, 'id'),
          ctxOf(res, ctx.config),
        ),
      );
    }),
  );

  return router;
}
