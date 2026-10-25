import { MAX_TASK_LIST_PAGES, TASK_LIST_PAGE_SIZE } from './constants.js';
import { McpClient } from './mcp-client.js';
import { planTasks } from './match.js';
import { parseTaskPage } from './task-parse.js';

/**
 * 只读预览层：dry-run 与 `--command` 的执行前确认共用。
 *
 * 放在独立文件的原因：runner.js 已经接近单文件行数上限，而这里只依赖 MCP
 * 读操作，不参与认领/执行/回报。调用方看到的是“和真实循环同一套过滤与排序”。
 */

const LIST_TIMEOUT_MS = 30_000;

export async function listPendingTasks(client) {
  const byId = new Map();
  for (let page = 1; page <= MAX_TASK_LIST_PAGES; page += 1) {
    const parsed = parseTaskPage(
      await client.call(
        'task.list',
        {
          status: 'pending',
          page,
          page_size: TASK_LIST_PAGE_SIZE,
        },
        { timeoutMs: LIST_TIMEOUT_MS },
      ),
    );
    for (const task of parsed.items) byId.set(task.id, task);
    if (!parsed.hasMore || parsed.items.length === 0) break;
  }
  return [...byId.values()];
}

/** 只读：连接、列出 pending、按配置匹配；不注册、不认领、不建卡。 */
export async function previewPendingTasks({ config, token }) {
  const client = new McpClient({ endpoint: config.endpoint, token });
  await client.connect({ timeoutMs: 15_000 });
  const tasks = await listPendingTasks(client);
  const { planned, skipped } = planTasks(tasks, config);
  return { pending: tasks.length, planned, skipped };
}

/** `dry-run`：只读列表与匹配结果；不注册、不认领、不执行、不建卡。 */
export async function runDryRun({ config, token }) {
  const preview = await previewPendingTasks({ config, token });
  return {
    pending: preview.pending,
    planned: preview.planned.map(({ task, rule }) => ({
      task_id: task.id,
      title: task.title,
      channel_key: task.channel_key,
      priority: task.priority,
      due_at: task.due_at ?? null,
      assignee: task.assignee ?? null,
      rule: rule.name,
      argv: rule.run.argv,
      cwd: rule.run.cwd,
    })),
    skipped: preview.skipped.map(({ task, reasons }) => ({
      task_id: task.id,
      title: task.title,
      channel_key: task.channel_key,
      reasons,
    })),
  };
}
