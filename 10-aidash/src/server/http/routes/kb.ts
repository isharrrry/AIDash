import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { asyncHandler, ok, queryInt, queryList, queryString, requireString } from '../respond.js';

/** 知识库路由：只读检索与读取；reindex 只重建本地索引，不写知识库文件。 */
export function kbRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/search',
    asyncHandler((req, res) => {
      const q = requireString(req.query.q, 'q');
      ok(
        res,
        ctx.services.kb.search(q, {
          type: queryString(req.query.type),
          tags: queryList(req.query.tags),
          top_k: queryInt(req.query.top_k, 10, 1, 50),
          page: queryInt(req.query.page, 1, 1, 1000),
          page_size: queryInt(req.query.page_size, 10, 1, 50),
        }),
      );
    }),
  );

  router.get(
    '/doc',
    asyncHandler((req, res) => {
      ok(res, ctx.services.kb.get(requireString(req.query.path, 'path')));
    }),
  );

  router.get(
    '/docs',
    asyncHandler((req, res) => {
      ok(
        res,
        ctx.services.kb.listDocs({
          type: queryString(req.query.type),
          page: queryInt(req.query.page, 1, 1, 1_000_000),
          page_size: queryInt(req.query.page_size, 50, 1, ctx.config.pageSizeMax),
        }),
      );
    }),
  );

  router.get(
    '/stats',
    asyncHandler((_req, res) => {
      ok(res, ctx.services.kb.stats());
    }),
  );

  router.post(
    '/reindex',
    asyncHandler((_req, res) => {
      ok(res, ctx.services.kb.index());
    }),
  );

  return router;
}
