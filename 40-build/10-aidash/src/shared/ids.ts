import { randomBytes } from 'node:crypto';

/**
 * ULID：48 位时间 + 80 位随机，Crockford Base32。
 * 为什么不用 uuid：ULID 可按时间排序，SQLite 主键局部性更好，日志里也更容易看出先后。
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number, length: number): string {
  let value = ms;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < length; i += 1) {
    out += CROCKFORD[bytes[i]! % 32];
  }
  while (out.length < length) {
    out += CROCKFORD[randomBytes(1)[0]! % 32];
  }
  return out;
}

export function ulid(now = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

export type IdPrefix = 'ch' | 'cd' | 'tk' | 'ar' | 'rp' | 'rn';

export function newId(prefix: IdPrefix, now = Date.now()): string {
  return `${prefix}_${ulid(now)}`;
}

/** 认领令牌必须有足够熵，不能从任务 ID 推导。 */
export function newClaimToken(): string {
  return `cl_${randomBytes(32).toString('base64url')}`;
}

/** 请求 ID：用于日志与审计串联。 */
export function newRequestId(): string {
  return `req_${ulid()}`;
}
