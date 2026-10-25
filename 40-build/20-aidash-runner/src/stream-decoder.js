/**
 * 子进程输出解码：默认按 UTF-8 流式解码；首次遇到非法 UTF-8 时锁定 GBK。
 *
 * 背景（缺陷现场）：Windows 中文系统的 cmd.exe 及不少 CLI 按代码页 936（GBK）
 * 写 stdout/stderr。runner 若一律按 UTF-8 解码，「写个py」的 GBK 字节
 * D0 B4 B8 F6 会被解成 `д` + 替换符，日志与证据卡里出现 `'д��py'`。
 *
 * 为什么不能简单地对每个 chunk 调用 decode('utf-8', { fatal:true })：
 * 管道会把一个多字节字符切成两块（例如 UTF-8 的「中」= E4 B8 AD 可能先到 E4）。
 * 半截字符会被 fatal 解码判成"非法"，从而把原本正常的 UTF-8 流误锁成 GBK。
 *
 * 做法（不依赖第三方库，Node >= 24 自带 full ICU 的 TextDecoder('gbk')）：
 * 1. 自己保留「末尾可能是半个字符」的最多 3 个字节，只对确认完整的部分做严格
 *    UTF-8 解码；这与 TextDecoder 的 { stream:true } 语义一致，但好处是保留了
 *    原始字节——TextDecoder 内部缓冲的字节无法取回，回退 GBK 时会丢掉它们。
 * 2. 严格解码抛 TypeError 说明字节序列确实不是合法 UTF-8：把「保留字节 + 当前块」
 *    整体按 GBK 重解，并锁定该流为 GBK；之后的块直接走 GBK。
 * 3. GBK 双字节同样可能被管道切断，所以回退解码器使用 { stream:true }，end() 再 flush。
 *
 * 一旦锁定 GBK，就不再尝试 UTF-8：中文 Windows 的一条命令输出通常来自同一种编码，
 * 来回切换只会让同一行文本一半 UTF-8 一半 GBK，反而更难读。
 */

const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;
const MAX_UTF8_SEQUENCE = 4;
const MAX_UTF8_HOLD = MAX_UTF8_SEQUENCE - 1;
const EMPTY = Buffer.alloc(0);

/** Node 是否真的提供该编码的解码器（Node 24 默认 full ICU，这里只是防御性检查）。 */
export function supportsEncoding(label) {
  try {
    // 某些精简构建的 ICU 会抛 RangeError；不能让它把整条输出链路打死。
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * 末尾有多少字节「可能是尚未收齐的 UTF-8 字符」。
 *
 * 只回看最多 3 个续字节：UTF-8 单字符最长 4 字节。
 * 返回 0 表示末尾不是可等待的合法前缀——交给严格解码去判定非法。
 */
export function incompleteTailBytes(data) {
  const length = data.length;
  if (length === 0) return 0;

  let index = length - 1;
  let continuation = 0;
  while (index >= 0 && continuation < MAX_UTF8_HOLD && (data[index] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION) {
    continuation += 1;
    index -= 1;
  }
  // 整个可见窗口都是续字节：不是任何合法前缀，交给严格解码报错。
  if (index < 0) return 0;

  const lead = data[index];
  let needed;
  if ((lead & 0x80) === 0) return 0; // ASCII 永远完整
  if ((lead & 0xe0) === 0xc0) needed = 2;
  else if ((lead & 0xf0) === 0xe0) needed = 3;
  else if ((lead & 0xf8) === 0xf0) needed = 4;
  else return 0; // 非法前导字节（含孤立的 0x80..0xBF）

  const available = length - index;
  return available < needed ? available : 0;
}

export class StreamTextDecoder {
  /**
   * @param {{ fallbackEncoding?: string }} [options]
   */
  constructor({ fallbackEncoding = 'gbk' } = {}) {
    this.fallbackEncoding = fallbackEncoding;
    this.canFallback = supportsEncoding(fallbackEncoding);
    this.mode = 'utf8';
    this.pending = EMPTY;
    this.utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    this.fallbackDecoder = null;
    // 仅在没有 GBK 解码器的精简 ICU 环境下使用；复用实例以正确处理跨 chunk 的
    // UTF-8 多字节字符（每次新建会把半个字符解成替换符）。
    this.lenientDecoder = null;
  }

  /** 当前锁定的编码，便于日志/测试确认是否发生过回退。 */
  get encoding() {
    return this.mode === 'utf8' ? 'utf-8' : this.fallbackEncoding;
  }

  /**
   * 喂入一块原始字节，返回可立即输出的文本（可能为空：块只有半个字符）。
   * @param {Buffer|Uint8Array} chunk
   * @returns {string}
   */
  write(chunk) {
    if (!chunk || chunk.length === 0) return '';
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    if (this.mode === 'gbk') return this.decodeFallback(bytes, true);

    // 与上一次留下的半截字符拼起来再判断边界。
    const data = this.pending.length > 0 ? Buffer.concat([this.pending, bytes]) : bytes;
    const hold = incompleteTailBytes(data);
    const headEnd = data.length - hold;
    this.pending = hold > 0 ? Buffer.from(data.subarray(headEnd)) : EMPTY;
    if (headEnd === 0) return '';

    try {
      // headEnd 之前都是完整序列；不使用 stream 选项，避免解码器再私藏字节。
      return this.utf8Decoder.decode(data.subarray(0, headEnd));
    } catch {
      // 真正的非法 UTF-8：当前缓冲区（含之前等待的半截字节）整体按 GBK 重解。
      this.mode = 'gbk';
      this.pending = EMPTY;
      return this.decodeFallback(data, true);
    }
  }

  /** 流结束：flush 遗留字节。 */
  end() {
    if (this.mode === 'gbk') {
      if (this.fallbackDecoder) return this.fallbackDecoder.decode();
      return this.lenientDecoder ? this.lenientDecoder.decode() : '';
    }
    const tail = this.pending;
    this.pending = EMPTY;
    if (tail.length === 0) return '';
    // 流在字符中间结束，无法再判定编码；沿用 StringDecoder 的既有行为输出替换符，
    // 不贸然把半截字节当 GBK（那会凭空造出一个错误汉字）。
    return new TextDecoder('utf-8').decode(tail);
  }

  decodeFallback(bytes, stream) {
    if (!this.canFallback) {
      // 没有 GBK 解码器时退回宽松 UTF-8：宁可出现替换符，也不能抛错中断任务。
      this.lenientDecoder ??= new TextDecoder('utf-8');
      return this.lenientDecoder.decode(bytes, { stream });
    }
    this.fallbackDecoder ??= new TextDecoder(this.fallbackEncoding);
    return this.fallbackDecoder.decode(bytes, { stream });
  }
}
