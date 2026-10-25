import { z } from 'zod';
import {
  channelKeySchema,
  idSchema,
  taskClaimSchema,
  taskCreateSchema,
  taskReleaseSchema,
  taskStatusSchema,
  taskUpdateSchema,
} from '../../../shared/schemas.js';
import type { TaskStatus, TreeNode } from '../../../shared/types.js';
import { pageShape, runTool } from './shared.js';
import type { ToolDeps } from './shared.js';

const moveShape = {
  task_id: idSchema,
  new_parent_id: z.string().max(64).nullable(),
};

const copyShape = {
  task_id: idSchema,
  new_parent_id: z.string().max(64).nullable().optional(),
};

const mcpTaskListShape = {
  channel_key: channelKeySchema.optional(),
  status: taskStatusSchema.optional(),
  assignee: z.string().max(100).optional(),
  // 默认不返回完成/取消，节省调用方上下文；显式传 status=done|cancelled 时以显式筛选为准。
  include_closed: z.boolean().optional(),
  // 描述可能含 base64 截图；默认只给 null，真正要看正文时显式打开。
  include_description: z.boolean().optional(),
  // 复盘：has_risk 含已解除，risk_open 只看仍未处理的隐患。
  has_risk: z.boolean().optional(),
  risk_open: z.boolean().optional(),
  ...pageShape,
};

/**
 * MCP 查询默认忽略的终态。
 *
 * 为什么放在 MCP 层而不是 service/repo：
 * REST/Web 仍要能一次看到全量（任务树统计、历史复盘）；这是“调用方上下文预算”的策略，
 * 只影响 agent 的查询入口，不应改变数据接口的默认语义。
 */
const OPEN_TASK_STATUSES: TaskStatus[] = [
  'draft',
  'pending',
  'claimed',
  'in_progress',
  'blocked',
  'failed',
];

/**
 * 从任务树中移除完成/取消节点，但保留其未结束子代（提升一级）。
 *
 * 与 Web 的“隐藏完成/取消”同一规则：父任务完成、验收又拆出待办时，
 * 不能因为过滤把仍然活着的子任务一起藏掉。
 */
function withoutClosedNodes(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    const children = withoutClosedNodes(node.children);
    if (node.status === 'done' || node.status === 'cancelled') {
      result.push(...children);
      continue;
    }
    result.push({ ...node, children });
  }
  return result;
}

/** 注册任务工具（MCP-009~016）。 */
export function registerTaskTools({ server, ctx, mcpCtx, log }: ToolDeps): void {
  server.registerTool(
    'task.create',
    {
      title: '建任务',
      description:
        '创建任务。默认是 draft；提交（submit=true）后才可被 claim。' +
        '没有自动派发，执行方必须主动认领。' +
        'kind=suggestion 表示“建议”：保持 draft（挂起）等用户批准，不要再另发通知卡；' +
        '用户批准后再 submit → claim → start。',
      inputSchema: { ...taskCreateSchema.shape, submit: z.boolean().optional() },
    },
    async (args) =>
      runTool('task.create', log, () => {
        const input = z
          .object({ ...taskCreateSchema.shape, submit: z.boolean().optional() })
          .parse(args);
        return ctx.services.tasks.create(input, mcpCtx, { submit: input.submit });
      }),
  );

  server.registerTool(
    'task.update',
    {
      title: '任务状态事件/改字段',
      description:
        '驱动状态机：submit/start/block/unblock/complete/fail/cancel/release/retry。' +
        'complete 之前必须先发关联到该任务的 status 或 artifact 卡，否则 EVIDENCE_REQUIRED。' +
        'retry 只允许 failed→pending，reason 必填，不需要 claim_token：' +
        '用于误标失败或决定重做，把任务重新放回待认领队列；done/cancelled 不能 retry。' +
        'defer/undefer 是“暂缓”覆盖层，不改变 status，也不需要 claim_token：' +
        'defer 只允许 draft/pending，reason 必填，deferred_until 可选（计划恢复时间，ISO 8601）；' +
        'undefer 清空暂缓。认领会自动清空暂缓。' +
        '暂时不继续做、又还没被认领的任务用 defer 并写清原因，不要留在 pending 装成“等人接”。' +
        'flag_risk/unflag_risk 是“隐患”覆盖层：带隐患完成/推进时用 flag_risk 并写清风险（reason 必填），' +
        '可作用于任何状态且不需要 claim_token；unflag_risk 只表示风险已处理，保留原记录供复盘。' +
        'task.list 可用 has_risk（含已解除）/ risk_open（仅未解除）筛选。',
      inputSchema: taskUpdateSchema.shape,
    },
    async (args) =>
      runTool('task.update', log, () => {
        const input = taskUpdateSchema.parse(args);
        return ctx.services.tasks.update(input, mcpCtx);
      }),
  );

  server.registerTool(
    'task.list',
    {
      title: '列任务',
      description:
        '按通道、状态、负责人筛选任务。默认忽略 done/cancelled；' +
        '要查历史时显式传 status=done|cancelled 或 include_closed=true。' +
        '传 has_risk/risk_open 且未显式传 status 时自动包含终态——带隐患完成的任务大多已经 done/cancelled，' +
        '否则复盘筛选会漏掉最主要的一类记录。' +
        '默认不返回 description_md（可能含 base64 截图），需要正文时传 include_description=true。',
      inputSchema: mcpTaskListShape,
    },
    async (args) =>
      runTool('task.list', log, () => {
        const input = z.object(mcpTaskListShape).parse(args);
        // 隐患复盘的主战场是终态任务：只查未结束状态会把“带病完成”全部漏掉。
        // 因此风险筛选在未显式指定 status 时自动放开终态；显式 status 仍然优先。
        const isRiskReview = input.has_risk === true || input.risk_open === true;
        return ctx.services.tasks.list(
          {
            channel_key: input.channel_key,
            // 显式状态优先；没传状态时，默认只取未结束的六种，避免把历史任务灌进上下文。
            status: input.status
              ? [input.status]
              : input.include_closed || isRiskReview
                ? undefined
                : OPEN_TASK_STATUSES,
            assignee: input.assignee,
            has_risk: input.has_risk,
            risk_open: input.risk_open,
            page: input.page,
            page_size: input.page_size,
          },
          input.include_description,
        );
      }),
  );

  server.registerTool(
    'task.tree',
    {
      title: '任务树',
      description:
        '取某通道的任务树；depth 控制展开层数。默认忽略 done/cancelled，' +
        '要查历史时传 include_closed=true。默认不返回 description_md，' +
        '需要正文时传 include_description=true。',
      inputSchema: {
        channel_key: channelKeySchema,
        depth: z.number().int().min(1).max(50).optional(),
        include_closed: z.boolean().optional(),
        include_description: z.boolean().optional(),
      },
    },
    async (args) =>
      runTool('task.tree', log, () => {
        const input = z
          .object({
            channel_key: channelKeySchema,
            depth: z.number().int().min(1).max(50).optional(),
            include_closed: z.boolean().optional(),
            include_description: z.boolean().optional(),
          })
          .parse(args);
        const tree = ctx.services.tasks.tree(
          input.channel_key,
          input.depth,
          input.include_description,
        );
        return input.include_closed ? tree : withoutClosedNodes(tree);
      }),
  );

  server.registerTool(
    'task.claim',
    {
      title: '原子认领',
      description:
        '认领 pending 任务，返回 claim_token（后续状态事件都要带）。' +
        '默认租约 900 秒；ALREADY_CLAIMED 是正常竞争，换下一个任务而不是重试。',
      inputSchema: taskClaimSchema.shape,
    },
    async (args) =>
      runTool('task.claim', log, () => {
        const input = taskClaimSchema.parse(args);
        return ctx.services.tasks.claim(input, mcpCtx);
      }),
  );

  server.registerTool(
    'task.release',
    {
      title: '释放任务',
      description: '用 claim_token 释放认领，任务回到 pending。',
      inputSchema: taskReleaseSchema.shape,
    },
    async (args) =>
      runTool('task.release', log, () => {
        const input = taskReleaseSchema.parse(args);
        return ctx.services.tasks.release(input, mcpCtx);
      }),
  );

  server.registerTool(
    'task.move',
    {
      title: '移动任务节点',
      description: '把任务（含子树）移到新父节点；new_parent_id=null 表示移到根。',
      inputSchema: moveShape,
    },
    async (args) =>
      runTool('task.move', log, () => {
        const input = z.object(moveShape).parse(args);
        return ctx.services.tasks.move(input.task_id, input.new_parent_id, mcpCtx);
      }),
  );

  server.registerTool(
    'task.copy',
    {
      title: '复制子树',
      description: '复制任务及其子树；新节点一律 draft、无租约、无证据。',
      inputSchema: copyShape,
    },
    async (args) =>
      runTool('task.copy', log, () => {
        const input = z.object(copyShape).parse(args);
        return ctx.services.tasks.copy(input.task_id, input.new_parent_id ?? null, mcpCtx);
      }),
  );
}
