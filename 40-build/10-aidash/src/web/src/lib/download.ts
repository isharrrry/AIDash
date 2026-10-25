/**
 * 浏览器端 Markdown 下载。
 *
 * 为什么不用服务端下载接口：
 * 汇报列表与记忆正文在页面里已经拿到/可以按项目拉取，服务端再写一个附件接口
 * 只会多一套权限与编码逻辑；用 Blob + <a download> 由浏览器直接落盘，简单且
 * 不经过服务端的临时文件。
 *
 * 文件名必须清洗：标题来自 LLM 或用户输入，可能带 `/ : * ? " < > |`，
 * 在 Windows 上会直接导致保存失败，甚至把文件写到别的目录（路径分隔符）。
 */

const FORBIDDEN_FILENAME_CHARS = /[\\/:*?"<>|\r\n\t]/g;
const MAX_FILENAME_LENGTH = 120;

/**
 * 生成安全文件名。
 *
 * 规则：
 * - 非法字符替换为空格，连续空白压成一个；
 * - 去掉开头的点，避免生成 `.hidden` 这种隐藏文件；
 * - 截断到 120 字符，给扩展名和目录路径留余量；
 * - 清洗后为空则使用 fallback。
 */
export function safeFilename(raw: string, fallback = 'download'): string {
  const cleaned = raw
    .replace(FORBIDDEN_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim()
    .slice(0, MAX_FILENAME_LENGTH)
    .trim();
  return cleaned || fallback;
}

/** 汇报/记忆下载统一使用 .md 扩展名；已经带 .md 的标题不重复追加。 */
export function markdownFileName(raw: string, fallback = 'download'): string {
  const name = safeFilename(raw, fallback);
  return /\.md$/i.test(name) ? name : `${name}.md`;
}

/**
 * 触发浏览器下载一个文本文件。
 *
 * `URL.revokeObjectURL` 放在 setTimeout 里：部分浏览器在 click 同步返回前
 * 还没开始读取 Blob，立即 revoke 会得到空文件。延迟一帧足够，也不会泄漏内存。
 */
export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = markdownFileName(filename);
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
