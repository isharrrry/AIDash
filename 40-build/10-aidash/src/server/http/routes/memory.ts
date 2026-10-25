import { Router } from 'express';
import { z } from 'zod';
import {
  assistantMemoryUpdateSchema,
  memoryUpdateSchema,
  projectNameSchema,
} from '../../../shared/schemas.js';
import type { AppContext } from '../../context.js';
import { ctxOf } from '../middleware.js';
import { asyncHandler, ok, queryInt, requireString } from '../respond.js';

/**
 * 主通道记忆的 REST 入口。
 *
 * Web 只需要两件事：读取整篇、整体替换。追加与按 key 搜索是 agent 的高频操作，
 * 放在 MCP 里；REST 不重复提供，避免两个入口对去重/版本的语义各写一份。
 */
export function memoryRouter(ctx: AppContext): Router {
  const router = Router();

  // Express 的 `'/'` 只匹配根路径，不会吞掉 `/projects`；这里仍把列表写在前面，
  // 方便读者按“先列表、后单篇”的顺序理解接口。
  router.get(
    '/projects',
    asyncHandler((_req, res) => {
      ok(res, ctx.services.memory.listProjects());
    }),
  );

  /**
   * 手动触发一次归纳。
   *
   * 这是“立即试一下”的入口，不改变定时器节奏；并发保护在服务层，
   * 同一项目已有归纳在跑时返回 409 DIGEST_RUNNING，而不是排队。
   */
  router.post(
    '/digest',
    asyncHandler(async (req, res) => {
      const body = z.object({ project: projectNameSchema }).parse(req.body);
      ok(res, await ctx.services.memoryDigest.run(body.project, 'manual'));
    }),
  );

  // 归纳历史：用户要能看到“为什么这次没新增/失败原因”，所以连失败记录一起返回。
  router.get(
    '/digest/runs',
    asyncHandler((req, res) => {
      const project = projectNameSchema.parse(requireString(req.query.project, 'project'));
      const limit = queryInt(req.query.limit, 10, 1, 50);
      ok(res, ctx.services.memoryDigest.listRuns(project, limit));
    }),
  );

  /**
   * AIDash 自己的记忆：全局只有一篇，没有 project 参数。
   *
   * 与下面的 `/` 分开：`/` 按 project 取主对话记忆，两者存储、归属、读写者都不同，
   * 不共用一个接口是为了让调用方无法“误把项目名传成 AIDash 记忆”。
   */
  router.get(
    '/assistant',
    asyncHandler((_req, res) => {
      ok(res, ctx.services.assistantMemory.get());
    }),
  );

  router.put(
    '/assistant',
    asyncHandler((req, res) => {
      const body = assistantMemoryUpdateSchema.parse(req.body);
      const result = ctx.services.assistantMemory.replace(body, ctxOf(res, ctx.config));
      ok(res, result.memory);
    }),
  );

  router.get(
    '/',
    asyncHandler((req, res) => {
      const project = projectNameSchema.parse(requireString(req.query.project, 'project'));
      ok(res, ctx.services.memory.get(project));
    }),
  );

  router.put(
    '/',
    asyncHandler((req, res) => {
      const body = memoryUpdateSchema.parse(req.body);
      const result = ctx.services.memory.replace(body, ctxOf(res, ctx.config));
      ok(res, result.memory);
    }),
  );

  return router;
}
