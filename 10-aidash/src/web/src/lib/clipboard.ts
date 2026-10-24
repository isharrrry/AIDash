/**
 * 剪贴板写入。非安全上下文（http 非 localhost）下 Clipboard API 可能不可用，
 * 此时抛错让调用方提示用户手动复制，而不是静默失败。
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error('当前浏览器不支持剪贴板 API，请手动选择文本复制');
  }
  await navigator.clipboard.writeText(text);
}
