import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  CARD_STATUSES,
  CARD_TYPES,
  PRIORITIES,
  cardAnswerSchema,
  cardAskSchema,
  cardPostSchema,
  cardUpdateSchema,
  idSchema,
} from '../../../shared/schemas.js';
import type { CardStatus, CardType, Priority } from '../../../shared/types.js';
import type { AppContext } from '../../context.js';
import { ctxOf } from '../middleware.js';
import {
  asyncHandler,
  ok,
  queryBool,
  queryInt,
  queryList,
  queryString,
  requireString,
} from '../respond.js';

const handoffSchema = z.object({
  state: z.enum(['draft', 'copied', 'sent', 'ack']),
});

const batchSchema = z.object({
  items: z
    .array(
      z.object({
        card_id: idSchema,
        answer: cardAnswerSchema,
      }),
    )
    .min(1)
    .max(100),
});

const sortSchema = z.enum(['created_at', 'updated_at', 'priority', 'due_at']);

function listValues<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  const raw = queryList(value);
  if (!raw) return undefined;
  const set = new Set<string>(allowed);
  for (const item of raw) {
    if (!set.has(item)) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['query'],
          message: `unsupported value: ${item}`,
          input: item,
        },
      ]);
    }
  }
  return raw as T[];
}

/**
 * `/api/ask` 单独挂在卡片路由之外：它是“发卡 + 阻塞等待”的组合操作，
 * 语义上不属于卡片资源本身；超时返回 pending 而不是错误。
 */
export function askHandler(ctx: AppContext): RequestHandler {
  return asyncHandler(async (req, res) => {
    const body = cardAskSchema.parse(req.body);
    const controller = new AbortController();
    // 客户端断开时立即释放等待槽位，避免 maxWaiting 被僵尸连接占满。
    res.on('close', () => controller.abort());
    const result = await ctx.services.decisions.ask(
      body,
      ctxOf(res, ctx.config),
      controller.signal,
    );
    ok(res, result);
  });
}

export function cardsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      const sort = queryString(req.query.sort);
      const result = ctx.services.cards.list({
        channelKey: queryString(req.query.channel_key),
        // project 过滤让 Web 能一次拉回“本项目所有话题通道”的卡，而不用先查通道再 IN。
        project: queryString(req.query.project),
        types: listValues<CardType>(req.query.type, CARD_TYPES),
        statuses: listValues<CardStatus>(req.query.status, CARD_STATUSES),
        priorities: listValues<Priority>(req.query.priority, PRIORITIES),
        includeArchived: queryBool(req.query.include_archived),
        // 列表默认为 null 的重字段；任务信息流/确实要全文的调用方显式传 true。
        includeBody: queryBool(req.query.include_body),
        q: queryString(req.query.q),
        taskId: queryString(req.query.task_id),
        // 历史遗留：旧版允许无任务发卡，升级后这些卡需要一个可查看的入口。
        unassigned: queryBool(req.query.unassigned),
        page: queryInt(req.query.page, 1, 1, 1_000_000),
        page_size: queryInt(req.query.page_size, 50, 1, ctx.config.pageSizeMax),
        sort: sort ? sortSchema.parse(sort) : undefined,
        order: req.query.order === 'asc' ? 'asc' : 'desc',
      });
      ok(res, result);
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const body = cardPostSchema.parse(req.body);
      const result = ctx.services.cards.post(body, ctxOf(res, ctx.config));
      ok(res, result, result.created ? 201 : 200);
    }),
  );

  router.post(
    '/batch-answer',
    asyncHandler((req, res) => {
      const body = batchSchema.parse(req.body);
      ok(
        res,
        ctx.services.cards.batchAnswer(
          body.items.map((item) => ({ card_id: item.card_id, answer: item.answer })),
          ctxOf(res, ctx.config),
        ),
      );
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      ok(res, ctx.services.cards.get(requireString(req.params.id, 'id')));
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const body = cardUpdateSchema.parse(req.body);
      const card = ctx.services.cards.updateMeta(
        requireString(req.params.id, 'id'),
        body,
        ctxOf(res, ctx.config),
      );
      ok(res, card);
    }),
  );

  /**
   * 标记已读。幂等：重复调用返回同一个 read_at。
   *
   * 为什么是 POST 而不是 PATCH：它不修改卡片本身，只追加一条“我读过了”的事实；
   * 用 POST 表达“执行一次动作”，也避免和 PATCH /cards/:id（改标题/优先级）混淆。
   */
  router.post(
    '/:id/read',
    asyncHandler((req, res) => {
      ok(
        res,
        ctx.services.cards.markRead(requireString(req.params.id, 'id'), ctxOf(res, ctx.config)),
      );
    }),
  );

  router.post(
    '/:id/answer',
    asyncHandler((req, res) => {
      const body = cardAnswerSchema.parse(req.body);
      const card = ctx.services.cards.answer(
        requireString(req.params.id, 'id'),
        body,
        ctxOf(res, ctx.config),
      );
      ok(res, card);
    }),
  );

  router.post(
    '/:id/dismiss',
    asyncHandler((req, res) => {
      ok(
        res,
        ctx.services.cards.dismiss(requireString(req.params.id, 'id'), ctxOf(res, ctx.config)),
      );
    }),
  );

  router.post(
    '/:id/archive',
    asyncHandler((req, res) => {
      ok(
        res,
        ctx.services.cards.archive(requireString(req.params.id, 'id'), ctxOf(res, ctx.config)),
      );
    }),
  );

  router.post(
    '/:id/handoff',
    asyncHandler((req, res) => {
      const body = handoffSchema.parse(req.body);
      ok(
        res,
        ctx.services.cards.setHandoffState(
          requireString(req.params.id, 'id'),
          body.state,
          ctxOf(res, ctx.config),
        ),
      );
    }),
  );

  return router;
}
