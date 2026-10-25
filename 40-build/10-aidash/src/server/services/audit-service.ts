import type { AuditEntry, Ctx, Page } from '../../shared/types.js';
import type { Clock } from '../../shared/time.js';
import type { AuditFilter, AuditRepo } from '../repos/support-repos.js';

const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization/i;

/**
 * 审计链校验结果的缓存时长。
 *
 * 为什么必须缓存：`verifyChain()` 会把整张 audit_log 读进内存并逐行重算 sha256。
 * 而设置页每 30 秒轮询一次 `/api/health`，原先每次轮询都要全量校验一次；
 * 审计表只增不删，行数越大，健康检查越慢，最终会把事件循环卡住。
 * 改成缓存后，健康检查最多每 10 分钟触发一次全量校验，其余请求只读快照。
 *
 * 代价是“断链”最多延迟一个 TTL 才被发现；需要立即确认时走 POST /api/audit/verify。
 */
const VERIFY_CACHE_TTL_MS = 10 * 60 * 1000;

export interface AuditChainStatus {
  ok: boolean;
  broken_at?: number;
  /** 本次真实校验发生的时刻；缓存命中时仍是上一次校验的时间。 */
  checked_at: string;
}

/**
 * 审计写入的唯一入口。
 *
 * 两条纪律：
 * 1. 详情做键名级脱敏——宁可少记，也不把令牌写进库；
 * 2. request_id 有唯一索引，同一请求的第二次写入自动降级为 null；
 *    否则“一次请求发了两张卡”会因唯一约束把正常业务打成 500。
 */
export class AuditService {
  /**
   * 只保存“最近一次真实校验”的结果。
   * 不缓存中间状态：一旦校验发现断链，缓存里就是断链结果，直到下次按需/过期重算。
   */
  private cachedChain: AuditChainStatus | null = null;
  private cachedAtMs = 0;

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

  /** 立即做一次全量校验，并刷新缓存。按需接口与测试用。 */
  verifyFresh(): AuditChainStatus {
    const checkedAt = this.clock.now();
    const result = this.repo.verifyChain();
    this.cachedAtMs = checkedAt;
    this.cachedChain = {
      ...result,
      checked_at: new Date(checkedAt).toISOString(),
    };
    return this.cachedChain;
  }

  /** 健康检查用：TTL 内直接返回上次结果，不重复扫全表。 */
  verifyCached(): AuditChainStatus {
    if (this.cachedChain && this.clock.now() - this.cachedAtMs < VERIFY_CACHE_TTL_MS) {
      return this.cachedChain;
    }
    return this.verifyFresh();
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
