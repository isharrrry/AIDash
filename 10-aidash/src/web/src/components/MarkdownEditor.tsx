import { useRef, useState } from 'react';
import type { ClipboardEvent, ReactElement } from 'react';
import {
  MAX_EMBEDDED_IMAGE_CHARS,
  MAX_TASK_DESCRIPTION_CHARS,
  TASK_IMAGE_MAX_EDGE,
} from '../../../shared/constants';
import { insertAtSelection } from '../lib/markdown-image';
import { Markdown } from './Markdown';

/**
 * 任务描述编辑器：Markdown 文本 + 粘贴图片转 base64 + 预览。
 *
 * 为什么图片要压缩后再内嵌：
 * - 剪贴板里的原图可能是 4K 截图，直接 base64 会让一条任务描述达到几 MB；
 * - 截图阅读只需要 1440px 以内，WebP 质量 0.85 通常能把文本截图压到 100~300 KB；
 * - 压缩失败或仍然超限时明确报错，而不是把超大字符串塞给服务端再吃 413。
 */
export function MarkdownEditor({
  value,
  onChange,
  rows = 4,
  disabled = false,
  placeholder,
  label = '描述（Markdown）',
  onBusyChange,
}: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  disabled?: boolean;
  placeholder?: string;
  label?: string;
  /**
   * 把“正在压缩图片”告诉父组件。
   *
   * 压缩是异步的：如果这期间用户点了“保存字段/创建任务”，提交的是插入图片之前的旧值，
   * 图片会被静默丢掉。父组件拿到 busy 后禁用提交按钮，等插入完成再保存。
   */
  onBusyChange?: (busy: boolean) => void;
}): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // 压缩是异步的：用户可能在压缩期间继续输入，插入时要用“最新值”而不是粘贴瞬间的闭包值。
  const valueRef = useRef(value);
  valueRef.current = value;

  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (images.length === 0) return;

    // 只有剪贴板里确实有图片时才阻止默认行为；纯文本粘贴继续走浏览器原生逻辑。
    event.preventDefault();
    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;
    void insertImages(images, start, end);
  };

  const insertImages = async (files: File[], start: number, end: number): Promise<void> => {
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setStatus(null);
    try {
      const snippets: string[] = [];
      for (const file of files) {
        snippets.push(await imageToMarkdown(file));
      }
      const snippet = snippets.join('\n\n');
      const current = valueRef.current;
      const inserted = insertAtSelection(current, snippet, start, end);
      if (inserted.value.length > MAX_TASK_DESCRIPTION_CHARS) {
        setError(
          `插入后描述约 ${formatKb(inserted.value.length)}，超过上限 ${formatKb(
            MAX_TASK_DESCRIPTION_CHARS,
          )}；请裁剪图片或删掉部分内容。`,
        );
        return;
      }
      onChange(inserted.value);
      setStatus(`已插入 ${files.length} 张图片（${formatKb(snippet.length)}，base64 内嵌）`);
      // 等 React 把新值写回 textarea 后再恢复光标，避免光标跳到开头。
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(inserted.cursor, inserted.cursor);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '图片插入失败');
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const nearLimit = value.length > MAX_TASK_DESCRIPTION_CHARS * 0.8;

  return (
    <div className="md-editor">
      <div className="md-editor-toolbar">
        <span className="filter-label">{label}</span>
        <div className="inline">
          <button
            type="button"
            className={preview ? 'btn btn-small btn-ghost' : 'btn btn-small'}
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            编辑
          </button>
          <button
            type="button"
            className={preview ? 'btn btn-small' : 'btn btn-small btn-ghost'}
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            预览
          </button>
        </div>
        <span className={nearLimit ? 'muted small warn-text' : 'muted small'}>
          可直接粘贴截图 · {formatKb(value.length)} / {formatKb(MAX_TASK_DESCRIPTION_CHARS)}
        </span>
      </div>

      {preview ? (
        <div className="md-editor-preview">
          <Markdown source={value} />
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          rows={rows}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? '支持 Markdown；截图可直接 Ctrl+V 粘贴，自动转成 base64 图片'}
          onChange={(event) => onChange(event.target.value)}
          onPaste={handlePaste}
        />
      )}

      {busy ? <p className="muted small">正在压缩图片…</p> : null}
      {status && !busy ? <p className="muted small">{status}</p> : null}
      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 把剪贴板图片降采样并转成 Markdown 图片语法。
 *
 * 输出优先 WebP；若浏览器不支持 WebP，`toDataURL` 会静默回退成 PNG，
 * 这时按 PNG 的大小判断是否超限即可，不额外分支。
 */
async function imageToMarkdown(file: File): Promise<string> {
  if (file.size > 12_000_000) {
    throw new Error(`图片原文件 ${formatKb(file.size)}，超过 12 MB；请先裁剪再粘贴。`);
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('无法读取这张图片；请换一张 PNG/JPEG/WebP 截图。');
  });

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > TASK_IMAGE_MAX_EDGE ? TASK_IMAGE_MAX_EDGE / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建画布，图片插入失败。');
    // JPEG/WebP 不带透明通道；先铺白底，避免透明截图存成黑底。
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    // 质量依次下降：优先保清晰度，仍然超限再降质量，而不是直接拒绝。
    for (const quality of [0.85, 0.72, 0.6]) {
      const dataUrl = canvas.toDataURL('image/webp', quality);
      if (dataUrl.length <= MAX_EMBEDDED_IMAGE_CHARS) {
        return `![粘贴的截图](${dataUrl})`;
      }
    }
  } finally {
    bitmap.close();
  }

  throw new Error(
    `图片压缩后仍超过单张上限 ${formatKb(MAX_EMBEDDED_IMAGE_CHARS)}；请裁剪后再粘贴。`,
  );
}

function formatKb(chars: number): string {
  return `${Math.max(1, Math.round(chars / 1024))} KB`;
}
