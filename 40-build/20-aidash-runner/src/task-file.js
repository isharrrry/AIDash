import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from './util.js';

/**
 * {task_file} 临时文件。
 *
 * 为什么要落文件而不是只给环境变量：很多本地 harness（claude/codex 包装器）
 * 以“读一个文件”为入口；把 JSON 塞进环境变量受长度与引号限制，Windows 上尤其脆。
 * 目录用 mkdtemp 独立创建，命令结束整体删除，避免把任务正文里的业务信息
 * 留在系统临时目录里过夜。
 */
export function writeTaskFiles(task, { baseDir = os.tmpdir(), resultFileTemplate = null } = {}) {
  const dir = fs.mkdtempSync(path.join(baseDir, 'aidash-runner-task-'));
  const jsonPath = path.join(dir, 'task.json');
  const mdPath = path.join(dir, 'task.md');
  const resultPath = resolveResultFile(resultFileTemplate, { taskId: task.id, taskDir: dir });
  const payload = taskPayload(task, { resultPath });
  try {
    // 只有把结果放进本次任务的临时目录时才替它建父目录：
    // 临时目录由 runner 掌管，任务结束即删除；配置里的其它路径交给 harness 自己处理。
    if (resultPath && String(resultFileTemplate).includes('{task_file_dir}')) {
      fs.mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(mdPath, `${taskMarkdown(task, { resultPath })}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    removeDir(dir);
    throw error;
  }
  return {
    dir,
    jsonPath,
    mdPath,
    resultPath,
    taskId: task.id,
    cleanup: () => removeDir(dir),
  };
}

/**
 * 解析结果文件路径模板。
 *
 * 为什么需要按任务解析：多个 runner 实例（甚至一次执行里的多个任务）可能共用
 * 同一个工作目录。固定文件名会让 A 任务的结果被 B 任务读走——证据卡里出现
 * 另一个任务的内容，比卡片空白更糟，因为它看起来“有据可查”。
 *
 * 支持的占位符：
 * - `{task_id}`：当前任务 id，便于按任务落盘；
 * - `{task_file_dir}`：本次执行独有的临时目录，任务结束即清理。
 */
export function resolveResultFile(template, { taskId = '', taskDir = '' } = {}) {
  if (!template) return null;
  const raw = String(template).split('{task_file_dir}').join(taskDir).split('{task_id}').join(taskId);
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(taskDir || process.cwd(), raw);
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // 清理失败不能覆盖任务本身的结论；临时目录最终由系统清理。
  }
}

/** 只暴露 harness 真正需要的字段，不把认领令牌/租约等控制信息写进文件。 */
export function taskPayload(task, { resultPath = null } = {}) {
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
    parent_id: task.parent_id ?? null,
    // 结果文件必须按本次执行落盘。写进 task.json 是为了让任何读到任务文件的
    // harness 都能拿到绝对路径，而不是靠“当前目录 + 固定文件名”去猜。
    ...(resultPath ? { result_file: resultPath } : {}),
    // task.json 是给程序读的：只挑讨论上下文需要的字段。
    // 这里显式重建对象（而不是展开祖先），防止 claim_token/租约等字段
    // 被服务端顺手塞进 ancestors 后跟着落盘。
    ancestors: Array.isArray(task.ancestors) ? task.ancestors.map(ancestorPayload) : [],
  };
}

function ancestorPayload(ancestor) {
  return {
    id: ancestor?.id ?? '',
    title: ancestor?.title ?? '',
    kind: ancestor?.kind ?? 'task',
    status: ancestor?.status ?? 'unknown',
    depth: ancestor?.depth ?? null,
    description_md: ancestor?.description_md ?? null,
    discussion_answer_md: ancestor?.discussion_answer_md ?? null,
  };
}

const KIND_LABELS = {
  task: '任务',
  suggestion: '建议',
  discussion: '讨论',
};

/**
 * task.md 是模型阅读的主要入口：除了任务正文，还要把“这是什么类型的任务、
 * 上级已经问过什么/结论是什么”写成自然语言。父链只放 id 不够——模型拿不到
 * 标题和结论时会把已经回答过的问题再问一遍。
 */
export function taskMarkdown(task, { resultPath = null } = {}) {
  const tags = Array.isArray(task.tags) && task.tags.length > 0 ? task.tags.join(', ') : '(无)';
  const lines = [
    `# ${task.title ?? task.id}`,
    '',
    `- 任务 ID: ${task.id}`,
    `- 通道: ${task.channel_key ?? ''}`,
    `- 类型: ${KIND_LABELS[task.kind] ?? '任务'}`,
    `- 优先级: ${task.priority ?? 'P2'}`,
    `- 标签: ${tags}`,
    `- 截止时间: ${task.due_at ?? '(无)'}`,
    '',
  ];

  if (resultPath) lines.push(...resultContractSection(task, resultPath), '');
  if (task.kind === 'discussion') lines.push(...discussionSection(), '');
  if (Array.isArray(task.ancestors) && task.ancestors.length > 0) {
    lines.push(...ancestorSection(task.ancestors), '');
  }

  lines.push('## 描述', '', task.description_md?.trim() ? task.description_md : '(无描述)');
  return lines.join('\n');
}

/**
 * 结果文件契约。
 *
 * 固定文件名（如所有任务都写 `claude-result.json`）在多实例/多任务并发时会串号：
 * 后完成的任务读到的是先完成者留下的文件。这里把本次执行独有的绝对路径写进
 * 任务文件，并明确要求 task_id，runner 落卡前会据此核对归属。
 */
function resultContractSection(task, resultPath) {
  return [
    '## 输出契约',
    '',
    `完成后把结果写成 JSON 到：\`${resultPath}\``,
    '',
    '- `summary`：一句话结论；',
    '- `detail_md`：完整说明（Markdown，不要只写“已完成”）；',
    '- `result`：`success` / `failed` / `blocked` / `partial`；',
    `- \`task_id\`：\`${task.id}\`（runner 用它核对结果归属，必须与当前任务一致）。`,
    '',
    '不要写到共享的固定文件名：每次任务的结果路径都是独立的，任务结束即清理。',
  ];
}

/** 讨论任务的输出契约：要的是判断和答案，不是改动清单或过程日志。 */
function discussionSection() {
  return [
    '## 讨论任务',
    '',
    '这是一条**讨论任务**：用户要的是对问题的判断和答案，不是工程实施。请遵守：',
    '',
    '1. **先用大白话直接回答**：第一段就给出明确结论，再解释理由、取舍和适用条件。',
    '2. **不要写代码改动清单，不要跑工程命令，也不要堆过程日志**；除非用户在描述里明确要求。',
    '3. 你的回答会写入任务详情页的“讨论结论”，并作为下级讨论任务的父级上下文，所以正文要能独立读懂。',
    '4. **必须结合下方的「父级讨论上下文」**：不要重复追问已知信息，不要忘记上级已经确认的前提；如果当前问题与上级结论冲突，要明确指出。',
    '5. 最终仍按约定写结果 JSON（路径见「输出契约」/ task.json 的 `result_file`）：`summary` 用一句话给出结论，`detail_md` 放完整的大白话回答（不要只写“已完成”）。',
  ];
}

/** 按数组原顺序（根 → 直接父）渲染每一层，描述与上级结论都放正文。 */
function ancestorSection(ancestors) {
  const lines = [
    '## 父级讨论上下文',
    '',
    '以下按从根到直接父的顺序排列。请把它们当作已经确认的背景，不要重复询问。',
    '',
  ];
  ancestors.forEach((ancestor, index) => {
    const title = nonEmpty(ancestor.title) ?? nonEmpty(ancestor.id) ?? '(未命名父任务)';
    const position =
      ancestors.length === 1
        ? '根/直接父'
        : index === 0
          ? '根'
          : index === ancestors.length - 1
            ? '直接父'
            : '中间层';
    lines.push(
      `### 父级 ${index + 1}/${ancestors.length}：${title}（${position}）`,
      '',
      `- 任务 ID: ${nonEmpty(ancestor.id) ?? '(无)'}`,
      `- 类型: ${KIND_LABELS[ancestor.kind] ?? nonEmpty(ancestor.kind) ?? '任务'}`,
      `- 状态: ${nonEmpty(ancestor.status) ?? 'unknown'}`,
      `- 距离当前任务: ${ancestor.depth ?? '未知'} 层`,
      '',
      '**描述**：',
      '',
      ancestor.description_md?.trim() ? ancestor.description_md.trim() : '(无描述)',
      '',
    );
    if (ancestor.discussion_answer_md?.trim()) {
      lines.push('**上级结论**：', '', ancestor.discussion_answer_md.trim(), '');
    }
  });
  return lines;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 按 input=stdin 的配置生成 stdin 内容。 */
export function taskStdin(task, format = 'task_json', { resultPath = null } = {}) {
  if (format === 'task_md') return `${taskMarkdown(task, { resultPath })}\n`;
  return `${JSON.stringify(taskPayload(task, { resultPath }), null, 2)}\n`;
}

const ARGV_PLACEHOLDER_RE = /\{(task_file|task_md_file|result_file|task_id)\}/g;

/**
 * 替换 argv 里的占位符。
 *
 * 用一次正则而不是链式 split/join：`{task_file}` 是 `{task_file_dir}` 的前缀，
 * 链式替换会先吃掉前缀，留下 `_dir}` 这种半截文本。
 */
export function substitutePlaceholders(argv, paths) {
  const values = {
    task_file: paths.jsonPath,
    task_md_file: paths.mdPath,
    result_file: paths.resultPath ?? '',
    task_id: paths.taskId ?? '',
  };
  return argv.map((item) => String(item).replace(ARGV_PLACEHOLDER_RE, (_, key) => values[key] ?? ''));
}

/**
 * 读取 harness 的结果文件。
 *
 * 约定：读不到/不是 JSON/字段不合法都返回 null，由调用方回退到“退出码 + 输出尾部”。
 * 不能因为 harness 少写一个字段就把整个任务判失败——结果文件是增强，不是契约。
 */
export function readResultFile(filePath) {
  return readResultFileForTask(filePath).file;
}

/**
 * 读取“本次任务”的结果文件，并核对归属。
 *
 * 为什么不能只 readFileSync：结果文件是证据卡的正文来源，一旦读到别的任务
 * 留下的文件，任务证据就会张冠李戴（内容看着完整，实际与任务无关）。
 * 三道校验：
 * 1. `baseline`：执行前文件已存在时记录 mtime+size，执行后没变化 → 不是本次写的；
 * 2. `sinceMs`：文件修改时间早于本次执行开始（留 2s 容差）→ 旧文件；
 * 3. `task_id`：结果 JSON 里带 task_id 时，必须与当前任务一致。
 *
 * 返回 `{ file, issue, path, foreignTaskId? }`。`issue` 为 null 表示可用；
 * 其它值用于日志与卡片正文说明“为什么没有采用结果文件”。
 */
export function readResultFileForTask(
  filePath,
  { sinceMs = null, taskId = null, baseline = null, toleranceMs = 2_000 } = {},
) {
  if (!filePath) return { file: null, issue: 'unconfigured', path: null };

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { file: null, issue: 'missing', path: filePath };
  }
  if (!stat.isFile()) return { file: null, issue: 'missing', path: filePath };

  // 先看文件是否被本次执行碰过：这比时间戳更可靠，也能覆盖“系统时钟不准”。
  // 除 mtime+size 外再比对内容摘要：同一毫秒内、同长度的改写不能让 runner
  // 误判成“没动过”（快速任务里很常见）。
  if (baseline && baseline.mtimeMs === stat.mtimeMs && baseline.size === stat.size) {
    const unchanged = !baseline.digest || baseline.digest === fileDigest(filePath);
    if (unchanged) return { file: null, issue: 'unchanged', path: filePath };
  }
  if (sinceMs !== null && stat.mtimeMs < sinceMs - toleranceMs) {
    return { file: null, issue: 'stale', path: filePath };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { file: null, issue: 'invalid', path: filePath };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { file: null, issue: 'invalid', path: filePath };
  }
  const reportedTaskId = typeof parsed.task_id === 'string' ? parsed.task_id.trim() : '';
  if (reportedTaskId && taskId && reportedTaskId !== taskId) {
    return { file: null, issue: 'foreign', path: filePath, foreignTaskId: reportedTaskId };
  }
  const allowed = ['success', 'failed', 'blocked', 'partial'];
  return {
    file: {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      detail_md: typeof parsed.detail_md === 'string' ? parsed.detail_md : '',
      result: allowed.includes(parsed.result) ? parsed.result : null,
      ...(reportedTaskId ? { task_id: reportedTaskId } : {}),
    },
    issue: null,
    path: filePath,
  };
}

/** 执行前记录结果文件的 mtime+size+内容摘要，用于判断执行后是否真的被写过。 */
export function snapshotResultFile(filePath) {
  if (!filePath) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size, digest: fileDigest(filePath) };
  } catch {
    return null;
  }
}

function fileDigest(filePath) {
  try {
    return sha256Hex(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}
