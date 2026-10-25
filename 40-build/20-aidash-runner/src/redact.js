/**
 * 脱敏与 ANSI 清理。
 *
 * 设计原则：脱敏放在“最后一厘米”（写终端/日志/卡片之前），而不是依赖每个调用点自觉。
 * 令牌可能出现在服务端错误回显、harness 输出、异常 message 里；只要有一个调用点漏了，
 * 令牌就会落到日志文件或卡片正文。
 */

const ANSI_PATTERN =
  // CSI 序列 + OSC 序列。前者是颜色/光标，后者常见于终端标题（\x1b]...\x07）。
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const SENSITIVE_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const AIDASH_ASSIGNMENT = /\b(AIDASH_TOKEN|AIDASH_LLM_API_KEY)\s*=\s*\S+/g;

/** 运行时登记的令牌（可能来自 --token/--token-file，不在环境变量里）。 */
const registeredSecrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) registeredSecrets.add(value);
}

export function resetSecrets() {
  registeredSecrets.clear();
}

function envSecrets() {
  const secrets = [];
  for (const key of ['AIDASH_TOKEN', 'AIDASH_PASSPHRASE', 'AIDASH_LLM_API_KEY']) {
    const value = process.env[key];
    if (value && value.length >= 6) secrets.push(value);
  }
  return secrets;
}

/** 文本脱敏：已知令牌值、Bearer 头、敏感 KEY=VALUE。 */
export function redact(text) {
  if (typeof text !== 'string' || !text) return text ?? '';
  let output = text;
  for (const secret of envSecrets()) output = output.split(secret).join('***');
  for (const secret of registeredSecrets) output = output.split(secret).join('***');
  output = output.replace(BEARER_PATTERN, '$1***');
  output = output.replace(AIDASH_ASSIGNMENT, '$1=***');
  // 通用键要放在最后：上面的规则已经处理过 AIDASH_*，避免二次替换把 `***` 再包一层。
  output = output.replace(SENSITIVE_ASSIGNMENT, (_match, key) => {
    // 保留键名、抹掉值：用户仍能看出“是哪个变量泄露了”，但拿不到内容。
    return `${key}=***`;
  });
  return output;
}

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_PATTERN, '');
}

/** 截断按字符数（卡片 schema 的上限是字符串长度，不是字节数）。 */
export function truncate(text, max) {
  const value = String(text ?? '');
  if (max <= 0) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** 卡片正文：先脱敏，再清 ANSI。顺序反了会把 ANSI 里的数字拼进令牌判断。 */
export function sanitizeForCard(text, max = Number.POSITIVE_INFINITY) {
  return truncate(stripAnsi(redact(text)), max);
}
