import type { AuditEntry, Ctx, Page } from '../../shared/types.js';
import type { Clock } from '../../shared/time.js';
import type { AuditFilter, AuditRepo } from '../repos/support-repos.js';

const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization/i;

/**
 * 审计写入的唯一入口。
 *
 * 两条纪律：
 * 1. 详情做键名级脱敏——宁可少记，也不把令牌写进库；
 * 2. request_id 有唯一索引，同一请求的第二次写入自动降级为 null；
 *    否则“一次请求发了两张卡”会因唯一约束把正常业务打成 500。
 */
export class AuditService {
  constructor(
    private readonly repo: AuditRepo,
    private readonly clock: Clock,
  ) {}

  record(
    ctx: Ctx,
    action: string,
    result: 'ok' | 'denied' | 'error',
    objectType?: string | null,
    objectId?: string | null,
    details?: Record<string, unknown>,
  ): AuditEntry {
    const base = {
      ts: this.clock.now(),
      actor_label: ctx.actorLabel,
      action,
      object_type: objectType ?? null,
      object_id: objectId ?? null,
      result,
      detail_json: details ? JSON.stringify(redact(details)) : null,
    };
    try {
      return this.repo.append({ ...base, request_id: ctx.requestId });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return this.repo.append({ ...base, request_id: null });
      }
      throw error;
    }
  }

  list(filter: AuditFilter): Page<AuditEntry> {
    return this.repo.list(filter);
  }

  verify(): { ok: boolean; broken_at?: number } {
    return this.repo.verifyChain();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  );
}

/** 结构保留、敏感键丢弃；数组递归处理。 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(inner);
    }
    return result;
  }
  return value;
}
