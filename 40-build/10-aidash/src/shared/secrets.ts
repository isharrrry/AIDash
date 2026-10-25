import { AppError } from './errors.js';

/**
 * “防手滑”而不是“防蓄意”（03 §3.2.4）。
 * 真正的边界是 AIDash 根本不持有这些凭证；这里只阻止调用方把令牌贴进卡片。
 */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'openai_key', re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { name: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'password_assign', re: /(?:password|passwd|pwd)\s*[:=]\s*\S{6,}/i },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: 'generic_token', re: /\b(?:token|secret|api[_-]?key)\s*[:=]\s*[A-Za-z0-9._-]{16,}/i },
];

/** 返回命中的模式名；不返回命中片段，避免把秘密写进错误与日志。 */
export function findSecret(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(text)) return pattern.name;
  }
  return null;
}

export function assertNoSecrets(fields: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== 'string') continue;
    const hit = findSecret(value);
    if (hit) {
      throw new AppError('INVALID_ARGUMENT', 'SENSITIVE_PATTERN_DETECTED', {
        field,
        pattern: hit,
      });
    }
  }
}

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_ARTIFACT_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

/**
 * 链接会进入 <a href>，必须封死 javascript:/data:。
 * 相对路径（无协议）按仓库内路径处理，允许用于 artifact。
 */
export function assertSafeUrl(raw: string, options: { allowFile?: boolean } = {}): void {
  const value = raw.trim();
  if (!value) throw new AppError('INVALID_ARGUMENT', 'URL_REQUIRED');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new AppError('INVALID_ARGUMENT', 'INVALID_URL');
    }
    const allowed = options.allowFile ? SAFE_ARTIFACT_PROTOCOLS : SAFE_LINK_PROTOCOLS;
    if (!allowed.has(url.protocol)) {
      throw new AppError('INVALID_ARGUMENT', 'UNSAFE_URL_SCHEME', { protocol: url.protocol });
    }
    return;
  }
  // 无协议：只接受不含空白的相对路径；拒绝 //evil.com 这种协议相对 URL。
  if (value.startsWith('//') || /\s/.test(value)) {
    throw new AppError('INVALID_ARGUMENT', 'INVALID_URL');
  }
}
