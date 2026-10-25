import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * {task_file} 临时文件。
 *
 * 为什么要落文件而不是只给环境变量：很多本地 harness（claude/codex 包装器）
 * 以“读一个文件”为入口；把 JSON 塞进环境变量受长度与引号限制，Windows 上尤其脆。
 * 目录用 mkdtemp 独立创建，命令结束整体删除，避免把任务正文里的业务信息
 * 留在系统临时目录里过夜。
 */
export function writeTaskFiles(task, { baseDir = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(baseDir, 'aidash-runner-task-'));
  const jsonPath = path.join(dir, 'task.json');
  const mdPath = path.join(dir, 'task.md');
  const payload = taskPayload(task);
  try {
    fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(mdPath, `${taskMarkdown(task)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    removeDir(dir);
    throw error;
  }
  return {
    dir,
    jsonPath,
    mdPath,
    cleanup: () => removeDir(dir),
  };
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // 清理失败不能覆盖任务本身的结论；临时目录最终由系统清理。
  }
}

/** 只暴露 harness 真正需要的字段，不把认领令牌/租约等控制信息写进文件。 */
export function taskPayload(task) {
  return {
    id: task.id,
    channel_key: task.channel_key,
    title: task.title,
    description_md: task.description_md ?? null,
    priority: task.priority ?? 'P2',
    tags: Array.isArray(task.tags) ? task.tags : [],
    due_at: task.due_at ?? null,
    kind: task.kind ?? 'task',
    status: task.status ?? 'pending',
    assignee: task.assignee ?? null,
  };
}

export function taskMarkdown(task) {
  const tags = Array.isArray(task.tags) && task.tags.length > 0 ? task.tags.join(', ') : '(无)';
  return [
    `# ${task.title ?? task.id}`,
    '',
    `- 任务 ID: ${task.id}`,
    `- 通道: ${task.channel_key ?? ''}`,
    `- 优先级: ${task.priority ?? 'P2'}`,
    `- 标签: ${tags}`,
    `- 截止时间: ${task.due_at ?? '(无)'}`,
    '',
    '## 描述',
    '',
    task.description_md?.trim() ? task.description_md : '(无描述)',
  ].join('\n');
}

/** 按 input=stdin 的配置生成 stdin 内容。 */
export function taskStdin(task, format = 'task_json') {
  if (format === 'task_md') return `${taskMarkdown(task)}\n`;
  return `${JSON.stringify(taskPayload(task), null, 2)}\n`;
}

export function substitutePlaceholders(argv, paths) {
  return argv.map((item) =>
    item.split('{task_file}').join(paths.jsonPath).split('{task_md_file}').join(paths.mdPath),
  );
}

/**
 * 读取 harness 的结果文件。
 *
 * 约定：读不到/不是 JSON/字段不合法都返回 null，由调用方回退到“退出码 + 输出尾部”。
 * 不能因为 harness 少写一个字段就把整个任务判失败——结果文件是增强，不是契约。
 */
export function readResultFile(filePath) {
  if (!filePath) return null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const allowed = ['success', 'failed', 'blocked', 'partial'];
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    detail_md: typeof parsed.detail_md === 'string' ? parsed.detail_md : '',
    result: allowed.includes(parsed.result) ? parsed.result : null,
  };
}
