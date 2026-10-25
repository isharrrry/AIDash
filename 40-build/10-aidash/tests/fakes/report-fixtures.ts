import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';

import { AppError } from '../../src/shared/errors.js';
import type { ReportRow, ReportRunRow, ReportRepo } from '../../src/server/repos/report-repo.js';
import { ReportService, type ReportServiceDeps } from '../../src/server/services/report-service.js';
import { testCtx, type TestHarness } from '../helpers.js';

/**
 * report-branches 拆分后的共享夹具。
 *
 * 假 LLM 保留真实 HTTP：取消/超时分支只有走到 AbortSignal 才测得出来。
 * 夹具模块不注册 afterEach，生命周期仍由具体测试文件管理。
 */

export const CHANNEL = 'devhost/myproj/reports';
export const REPORT_CONTENT = '# 本期结论\n\n- 完成 3 项\n- 风险 1 项';

export interface FakeLlm {
  base: string;
  requests: Array<{ system: string; user: string }>;
  /** 延迟响应，用来制造“请求在途时取消”的窗口。 */
  delayMs: number;
  /** 从第 N 次汇报请求起返回 500（0 = 正常）。 */
  failFrom: number;
  close(): Promise<void>;
}

/**
 * 与 reports.test.ts 的同款桩：真实 HTTP 才能验证 AbortSignal。
 * 记忆学习器的调用单独分流，不计入 requests，否则会打乱“第几次汇报请求”的编号。
 */
export async function startFakeLlm(delayMs = 0): Promise<FakeLlm> {
  const requests: FakeLlm['requests'] = [];
  const state = { delayMs, failFrom: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: { messages?: Array<{ role: string; content: string }> } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
      } catch {
        // 请求体不是 JSON 不属于本文件要验证的现象，交给下游返回空内容即可。
      }
      const system = body.messages?.[0]?.content ?? '';
      const user = body.messages?.[1]?.content ?? '';
      if (system.includes('AIDash 的记忆整理助手')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"lines":[]}' } }] }));
        return;
      }
      requests.push({ system, user });
      const callNo = requests.length;
      const respond = (): void => {
        if (res.writableEnded || res.destroyed) return;
        if (state.failFrom > 0 && callNo >= state.failFrom) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('boom');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: REPORT_CONTENT } }] }));
      };
      if (state.delayMs > 0) setTimeout(respond, state.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    requests,
    get delayMs(): number {
      return state.delayMs;
    },
    set delayMs(value: number) {
      state.delayMs = value;
    },
    get failFrom(): number {
      return state.failFrom;
    },
    set failFrom(value: number) {
      state.failFrom = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 只配置到“能被 assertReady 放行”的程度；用例若真的发请求会自己换成 fake 地址。 */
export function configure(h: TestHarness, base = 'http://127.0.0.1:9/v1'): void {
  h.ctx.services.settings.update(
    {
      llm_endpoint: base,
      llm_model: 'deepseek-flash',
      llm_mode: 'max',
      llm_api_key: 'sk-test-key',
    },
    testCtx(),
  );
}

export async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 后台生成不阻塞调用方；按 id 等它落库到终态。 */
export async function waitForIdle(
  h: TestHarness,
  runId: string,
  timeoutMs = 5_000,
): Promise<ReportRunRow> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = h.ctx.services.reports.status();
    if (!state.running) {
      const run = h.ctx.repos.reports.getRun(runId);
      if (!run) throw new Error(`no report run recorded for ${runId}`);
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('report run did not finish in time');
}

export async function waitForRun(
  h: TestHarness,
  runId: string,
  statuses: ReportRunRow['status'][],
  timeoutMs = 5_000,
): Promise<ReportRunRow> {
  const started = Date.now();
  let last: ReportRunRow | undefined;
  while (Date.now() - started < timeoutMs) {
    last = h.ctx.repos.reports.getRun(runId);
    if (last && statuses.includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${runId} did not reach ${statuses.join('/')}; last=${JSON.stringify(last)}`);
}

/* ------------------------------------------------------------------ *
 * 直接构造服务 / 包装仓储
 * ------------------------------------------------------------------ */

export function makeService(
  h: TestHarness,
  overrides: Partial<ReportServiceDeps> = {},
): ReportService {
  return new ReportService({
    db: h.ctx.db,
    reports: h.ctx.repos.reports,
    llm: h.ctx.services.llm,
    settings: h.ctx.services.settings,
    audit: h.ctx.services.audit,
    clock: h.ctx.clock,
    offlineThresholdMs: h.config.offlineThresholdSeconds * 1000,
    ...overrides,
  });
}

/**
 * 只替换个别仓储方法的透明代理。
 * 为什么要 bind(target)：类方法内部用 this.db，代理对象本身没有该字段。
 */
export function wrapReports(repo: ReportRepo, overrides: Record<string, unknown>): ReportRepo {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as ReportRepo;
}

export interface ReportServiceInternals {
  collectMaterial(start: number, end: number): { text: string; count: number };
  executePeriod(run: ReportRunRow, signal: AbortSignal): Promise<void>;
  executeTopic(
    run: ReportRunRow,
    targets: Array<{ row: ReportRow; instruction: string }>,
    instruction: string,
    signal: AbortSignal,
  ): Promise<void>;
  finishSafely(runId: string, status: 'failed' | 'cancelled', message: string | null): void;
}

export function internals(service: ReportService): ReportServiceInternals {
  return service as unknown as ReportServiceInternals;
}

export function createRun(
  h: TestHarness,
  id: string,
  overrides: Partial<{
    kind: 'period' | 'topic';
    total: number;
    targetReportId: string | null;
    instruction: string | null;
  }> = {},
): ReportRunRow {
  return h.ctx.repos.reports.createRun({
    id,
    kind: overrides.kind ?? 'period',
    total: overrides.total ?? 6,
    targetReportId: overrides.targetReportId ?? null,
    instruction: overrides.instruction ?? null,
    now: h.clock.now(),
  });
}

export function expectAppError(fn: () => unknown, code: string, message: string): AppError {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  expect(appError.code).toBe(code);
  expect(appError.message).toBe(message);
  return appError;
}

/* ------------------------------------------------------------------ *
 * 直接落库的素材工厂（批量数据用服务 API 太慢，且部分状态组合入口不允许）
 * ------------------------------------------------------------------ */

export interface TaskSeed {
  id: string;
  channelId: string;
  title: string;
  status: string;
  priority?: string;
  kind?: string;
  assignee?: string | null;
  claimedBy?: string | null;
  claimToken?: string | null;
  claimExpiresAt?: number | null;
  blockedReason?: string | null;
  failReason?: string | null;
  cancelReason?: string | null;
  deferReason?: string | null;
  riskNote?: string | null;
  riskResolvedAt?: number | null;
  riskResolution?: string | null;
  completedAt?: number | null;
  failedAt?: number | null;
  cancelledAt?: number | null;
  blockedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export function seedTaskRow(h: TestHarness, seed: TaskSeed): void {
  h.db
    .prepare(
      `INSERT INTO task (
         id, channel_id, path, title, status, priority, kind, assignee,
         claimed_by, claim_token, claim_expires_at,
         blocked_at, completed_at, failed_at, cancelled_at,
         blocked_reason, fail_reason, cancel_reason, defer_reason,
         risk_note, risk_resolved_at, risk_resolution,
         evidence_json, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      seed.id,
      seed.channelId,
      `/${seed.id}/`,
      seed.title,
      seed.status,
      seed.priority ?? 'P2',
      seed.kind ?? 'task',
      seed.assignee ?? null,
      seed.claimedBy ?? null,
      seed.claimToken ?? null,
      seed.claimExpiresAt ?? null,
      seed.blockedAt ?? null,
      seed.completedAt ?? null,
      seed.failedAt ?? null,
      seed.cancelledAt ?? null,
      seed.blockedReason ?? null,
      seed.failReason ?? null,
      seed.cancelReason ?? null,
      seed.deferReason ?? null,
      seed.riskNote ?? null,
      seed.riskResolvedAt ?? null,
      seed.riskResolution ?? null,
      // done 状态有 CHECK：必须带 evidence_json，且 claim_token 必须为空。
      seed.status === 'done' ? '[]' : null,
      seed.createdAt,
      seed.updatedAt,
    );
}

export interface CardSeed {
  id: string;
  channelId: string;
  type: string;
  title?: string | null;
  summary?: string | null;
  detail?: string | null;
  body?: string | null;
  severity?: string | null;
  result?: string | null;
  createdAt: number;
}

export function seedCardRow(h: TestHarness, seed: CardSeed): void {
  h.db
    .prepare(
      `INSERT INTO card (
         id, channel_id, type, status, priority, title, body_md, summary, detail_md,
         background_md, options_json, severity, result, created_at, updated_at
       ) VALUES (?,?,?,'open','P2',?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      seed.id,
      seed.channelId,
      seed.type,
      seed.title ?? null,
      seed.body ?? null,
      seed.summary ?? null,
      seed.detail ?? null,
      // question 类型有 CHECK：background_md 与 options_json 必须非空。
      seed.type === 'question' ? '背景' : null,
      seed.type === 'question' ? '[]' : null,
      seed.severity ?? null,
      seed.result ?? null,
      seed.createdAt,
      seed.createdAt,
    );
}
