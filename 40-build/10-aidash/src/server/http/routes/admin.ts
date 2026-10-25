import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import type { Harness, HarnessStatus } from '../../../shared/types.js';
import type { AppContext } from '../../context.js';
import { ctxOf } from '../middleware.js';
import {
  asyncHandler,
  ok,
  parseTime,
  queryInt,
  queryString,
  requireString,
} from '../respond.js';

export const SERVER_VERSION = '2.0.0';

/**
 * settings 里刻意保留 `llm_api_key`：zod 默认会剥掉未知键，
 * 若这里不声明，服务层的 SECRET_MUST_USE_ENV 守卫永远触发不到。
 */
const settingsPatchSchema = z.object({
  enrichment_enabled: z.boolean().optional(),
  enrichment_timeout_ms: z.number().int().optional(),
  llm_endpoint: z.string().max(2000).nullable().optional(),
  llm_model: z.string().max(200).nullable().optional(),
  llm_mode: z.enum(['fast', 'standard', 'max']).optional(),
  // 与旧版不同：现在允许页面写入，但服务层只把它放进 SecretStore 的加密文件，
  // 不并入 setting.runtime；null / 空串表示清除页面密钥（环境变量仍兜底）。
  llm_api_key: z.union([z.string().max(1000), z.null()]).optional(),
  prompts: z
    .record(
      z.enum(['card_analysis', 'kb_suggestion', 'memory_digest', 'report', 'assistant_memory']),
      z.string().max(8000),
    )
    .optional(),
  memory_digest_enabled: z.boolean().optional(),
  memory_digest_interval_hours: z.number().int().optional(),
  memory_digest_window_days: z.number().int().optional(),
  kb_root: z.string().max(2000).nullable().optional(),
  card_retention_days: z.number().int().optional(),
  audit_min_retention_days: z.number().int().optional(),
  log_retention_days: z.number().int().optional(),
});

const harnessPatchSchema = z.object({
  status: z.enum(['online', 'offline', 'disabled']),
});

function toHarnessView(row: Harness): Harness & {
  capabilities: string[];
  last_seen_at: string;
  registered_at_iso: string;
} {
  return {
    ...row,
    capabilities: parseCapabilities(row.capabilities_json),
    last_seen_at: new Date(row.last_seen).toISOString(),
    registered_at_iso: new Date(row.registered_at).toISOString(),
  };
}

function parseCapabilities(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function dbSizeBytes(ctx: AppContext): number {
  try {
    return fs.statSync(ctx.config.dbPath).size;
  } catch {
    return 0;
  }
}

function groupCount(ctx: AppContext, table: 'card' | 'task', column: string): Record<string, number> {
  // 表名与列名来自本文件的字面量白名单，不接收外部输入，因此可以拼接。
  const rows = ctx.db
    .prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`)
    .all() as Array<{ k: string; n: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) result[row.k] = row.n;
  return result;
}

/** 面板管理路由：摘要、设置、审计、harness、健康与备份。 */
export function adminRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/digest',
    asyncHandler((req, res) => {
      ok(res, ctx.services.cards.digest(queryString(req.query.channel_key)));
    }),
  );

  router.get(
    '/settings',
    asyncHandler((_req, res) => {
      ok(res, ctx.services.settings.view());
    }),
  );

  router.patch(
    '/settings',
    asyncHandler((req, res) => {
      const body = settingsPatchSchema.parse(req.body);
      ok(res, ctx.services.settings.update(body, ctxOf(res, ctx.config)));
    }),
  );

  /**
   * 测试连接：与正式调用共用 LlmService.chat，避免“测试通过、实际不通”。
   * 失败按 AppError 走统一错误信封；前端只显示收敛后的错误码。
   */
  router.post(
    '/llm/test',
    asyncHandler(async (_req, res) => {
      ok(res, await ctx.services.llm.test());
    }),
  );

  router.get(
    '/audit',
    asyncHandler((req, res) => {
      const result = queryString(req.query.result);
      ok(
        res,
        ctx.services.audit.list({
          since: parseTime(req.query.since, 'since'),
          until: parseTime(req.query.until, 'until'),
          action: queryString(req.query.action),
          object_type: queryString(req.query.object_type),
          object_id: queryString(req.query.object_id),
          result: result ? z.enum(['ok', 'denied', 'error']).parse(result) : undefined,
          page: queryInt(req.query.page, 1, 1, 1_000_000),
          page_size: queryInt(req.query.page_size, 50, 1, ctx.config.pageSizeMax),
        }),
      );
    }),
  );

  router.get(
    '/harnesses',
    asyncHandler((_req, res) => {
      ok(res, ctx.repos.harnesses.list().map(toHarnessView));
    }),
  );

  router.patch(
    '/harnesses/:id',
    asyncHandler((req, res) => {
      const harnessId = requireString(req.params.id, 'id');
      const body = harnessPatchSchema.parse(req.body);
      const existing = ctx.repos.harnesses.get(harnessId);
      if (!existing) {
        throw new AppError('NOT_FOUND', 'HARNESS_NOT_FOUND', { harness_id: harnessId });
      }
      const now = ctx.clock.now();
      ctx.repos.harnesses.setStatus(harnessId, body.status as HarnessStatus, now);
      ctx.services.audit.record(
        ctxOf(res, ctx.config),
        'harness.status',
        'ok',
        'harness',
        harnessId,
        { status: body.status },
      );
      ok(res, toHarnessView(ctx.repos.harnesses.get(harnessId)!));
    }),
  );

  router.get(
    '/health',
    asyncHandler((_req, res) => {
      ok(res, {
        status: 'ok',
        version: SERVER_VERSION,
        uptime_seconds: Math.round((Date.now() - ctx.startedAt) / 1000),
        db: { path: ctx.config.dbPath, size_bytes: dbSizeBytes(ctx) },
        audit_chain: ctx.services.audit.verify(),
        waiting_requests: ctx.services.decisions.waitingCount(),
      });
    }),
  );

  router.get(
    '/metrics',
    asyncHandler((_req, res) => {
      ok(res, {
        version: SERVER_VERSION,
        uptime_seconds: Math.round((Date.now() - ctx.startedAt) / 1000),
        cards_by_status: groupCount(ctx, 'card', 'status'),
        cards_by_type: groupCount(ctx, 'card', 'type'),
        tasks_by_status: groupCount(ctx, 'task', 'status'),
        channels: ctx.repos.channels.countActive(),
        harnesses: ctx.repos.harnesses.list().length,
        waiting_requests: ctx.services.decisions.waitingCount(),
        kb: ctx.services.kb.stats(),
        db: { size_bytes: dbSizeBytes(ctx) },
      });
    }),
  );

  router.post(
    '/backup',
    asyncHandler(async (_req, res) => {
      const dir = path.resolve(ctx.config.backupDir);
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date(ctx.clock.now()).toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `aidash-${stamp}.db`);
      // better-sqlite3 的 backup 会使用 SQLite 在线备份 API，WAL 下也能得到一致快照。
      await ctx.db.backup(file);
      const size = fs.statSync(file).size;
      ctx.services.audit.record(ctxOf(res, ctx.config), 'db.backup', 'ok', 'database', null, {
        file: path.basename(file),
        size_bytes: size,
      });
      ok(res, { file, size_bytes: size });
    }),
  );

  return router;
}
