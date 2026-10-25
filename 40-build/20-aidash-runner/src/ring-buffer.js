/**
 * 首尾各 8KB 的输出缓冲。
 *
 * 为什么不用“只留前 16KB”：失败原因几乎总在输出尾部（堆栈、最后一行错误），
 * 只留头部等于把最有用的信息丢掉。保留首尾两块，中间用一行标记说明截断了多少。
 */
export class EdgeBuffer {
  constructor(limit = 8 * 1024) {
    this.limit = limit;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.total = 0;
  }

  append(chunk) {
    if (!chunk || chunk.length === 0) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this.total += buffer.length;

    if (this.head.length < this.limit) {
      const room = this.limit - this.head.length;
      this.head = Buffer.concat([this.head, buffer.subarray(0, room)]);
    }

    const combined = Buffer.concat([this.tail, buffer]);
    this.tail = combined.length > this.limit ? combined.subarray(combined.length - this.limit) : combined;
  }

  get truncated() {
    return this.total > this.limit * 2;
  }

  /** 总输出不超过 16KB 时返回完整原文；超过时返回首 8KB + 尾 8KB，不重复输出重叠部分。 */
  toString() {
    if (this.total === 0) return '';
    if (this.total <= this.limit) return this.tail.toString('utf8');
    if (this.total <= this.limit * 2) {
      // 首尾块有重叠：把尾块里已被头部覆盖的部分切掉，避免同一段日志出现两次。
      const overlap = this.limit * 2 - this.total;
      const remainder = this.tail.subarray(overlap);
      return Buffer.concat([this.head, remainder]).toString('utf8');
    }
    const omitted = this.total - this.limit * 2;
    return `${this.head.toString('utf8')}\n…[输出过长，中间省略 ${omitted} 字节]…\n${this.tail.toString('utf8')}`;
  }
}
