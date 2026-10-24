import { Router } from 'express';
import { z } from 'zod';
import type { ReportKind, ReportPeriod } from '../../../shared/types.js';
import type { AppContext } from '../../context.js';
import { ctxOf } from '../middleware.js';
import { asyncHandler, ok, queryInt, queryString } from '../respond.js';

const periodSchema = z.enum(['day', 'week', 'month', 'quarter', 'half', 'year', 'topic']);
const kindSchema = z.enum(['period', 'topic']);

const topicSchema = z.object({
  // 标题可以不填：服务层回退到“要求首行”，保证列表里能认出这条汇报。
  topic: z.string().trim().max(200).optional().nullable(),
  instruction: z.string().trim().min(1).max(4_000),
  // “更新某些汇报条目”：允许一次指定多条目标，服务层逐条生成。
  target_report_ids: z.array(z.string().min(1)).max(10).optional(),
});

/**
 * 汇报 REST 入口。
 *
 * 路由顺序有讲究：`/status`、`/update`、`/topic`、`/runs/:id/cancel` 必须排在
 * `/:id` 之前，否则 Express 会把 `status` 当成汇报 ID，返回 404 REPORT_NOT_FOUND。
 */
export function reportsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      const period = parsePeriod(req.query.period);
      const kind = parseKind(req.query.kind);
      const page = queryInt(req.query.page, 1, 1, 10_000);
      const pageSize = queryInt(req.query.page_size, 20, 1, 50);
      ok(res, ctx.services.reports.list({ period, kind, page, page_size: pageSize }));
    }),
  );

  router.get(
    '/status',
    asyncHandler((_req, res) => {
      ok(res, ctx.services.reports.status());
    }),
  );

  // “更新汇报”按钮：立即返回批次，生成在后台进行；页面轮询 /status 看进度。
  router.post(
    '/update',
    asyncHandler((_req, res) => {
      ok(res, ctx.services.reports.startPeriodUpdate(ctxOf(res, ctx.config)), 202);
    }),
  );

  // 专题汇报：不传 target_report_ids 就是新建一条；传了就是按同一段要求更新那些汇报。
  router.post(
    '/topic',
    asyncHandler((req, res) => {
      const body = topicSchema.parse(req.body);
      ok(
        res,
        ctx.services.reports.startTopic(
          {
            topic: body.topic ?? null,
            instruction: body.instruction,
            targetReportIds: body.target_report_ids ?? [],
          },
          ctxOf(res, ctx.config),
        ),
        202,
      );
    }),
  );

  router.post(
    '/runs/:id/cancel',
    asyncHandler((req, res) => {
      const id = requireParam(req.params.id);
      ok(res, ctx.services.reports.cancel(id, ctxOf(res, ctx.config)));
    }),
  );

  // 删除后不可恢复，页面必须二次确认；服务端在生成中直接拒绝（REPORT_GENERATING）。
  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      ok(
        res,
        ctx.services.reports.delete(requireParam(req.params.id), ctxOf(res, ctx.config)),
      );
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      ok(res, ctx.services.reports.get(requireParam(req.params.id)));
    }),
  );

  return router;
}

function parsePeriod(value: unknown): ReportPeriod | undefined {
  const raw = queryString(value);
  if (!raw) return undefined;
  return periodSchema.parse(raw);
}

function parseKind(value: unknown): ReportKind | undefined {
  const raw = queryString(value);
  if (!raw) return undefined;
  return kindSchema.parse(raw);
}

/** Express 5 的 params 值可能缺失；缺了就是调用方拼错路径，按参数错误返回。 */
function requireParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !value) {
    throw new z.ZodError([
      { code: 'custom', path: ['id'], message: '缺少路径参数 id', input: value },
    ]);
  }
  return value;
}
