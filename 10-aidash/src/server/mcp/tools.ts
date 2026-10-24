import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodError } from 'zod';
import { AppError, toAppError } from '../../shared/errors.js';
import {
  // tools/list 只公开基础形状；cardAskSchema 已包 superRefine，取不到 .shape，
  // 所以这里单独导入 cardAskBase 给 MCP 客户端看参数。
  cardAskBase,
  cardAskSchema,
  cardPostBase,
  cardPostSchema,
  cardStatusSchema,
  cardTypeSchema,
  channelKeySchema,
  harnessHeartbeatSchema,
  harnessRegisterSchema,
  idSchema,
  memoryAppendSchema,
  memoryGetSchema,
  memorySearchSchema,
  memoryUpdateSchema,
  prioritySchema,
  projectNameSchema,
  taskClaimSchema,
  taskCreateSchema,
  taskReleaseSchema,
  taskStatusSchema,
  taskUpdateSchema,
} from '../../shared/schemas.js';
import type { Ctx, Harness, TaskStatus, TreeNode } from '../../shared/types.js';
import type { AppContext } from '../context.js';
import type { Logger } from '../log.js';
import { capMcpWaitSeconds } from './wait-cap.js';

/** 只读/查询类工具的公共分页参数。 */
const pageShape = {
  page: z.number().int().min(1).max(100_000).optional(),
  page_size: z.number().int().min(1).max(200).optional(),
};

const moveShape = {
  task_id: idSchema,
  new_parent_id: z.string().max(64).nullable(),
};

const copyShape = {
  task_id: idSchema,
  new_parent_id: z.string().max(64).nullable().optional(),
};

const digestShape = {
  channel_key: channelKeySchema.optional(),
  since: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(50).optional(),
};

const mcpCardListShape = {
  channel_key: channelKeySchema.optional(),
  // 按通道所属项目过滤：一个项目下可能有多个话题通道，查重时要能跨通道看。
  project: z.string().min(1).max(200).optional(),
  type: cardTypeSchema.optional(),
  status: cardStatusSchema.optional(),
  priority: prioritySchema.optional(),
  q: z.string().max(200).optional(),
  task_id: z.string().max(64).optional(),
  include_archived: z.boolean().optional(),
  ...pageShape,
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

/**
 * 注册 MCP-001~023。
 *
 * 为什么每个请求都新建 server/transport：SDK 的 stateless 模式不保存会话，
 * 共享实例会让并发请求互相污染 initialization 状态；新建成本只是内存对象，可以忽略。
 */
export function registerTools(
  server: McpServer,
  ctx: AppContext,
  mcpCtx: Ctx,
  signal: AbortSignal,
  log: Logger,
): void {
  /* ---------------------------- harness ---------------------------- */

  server.registerTool(
    'harness.register',
    {
      title: '注册 harness',
      description: '注册或更新当前 harness（幂等）。令牌只从环境变量读取，不要在此传密钥。',
      inputSchema: harnessRegisterSchema.shape,
    },
    async (args) =>
      runTool('harness.register', log, () => {
        const input = harnessRegisterSchema.parse(args);
        const now = ctx.clock.now();
        const row = ctx.repos.harnesses.upsert({
          harness_id: input.harness_id,
          name: input.name,
          host: input.host ?? null,
          capabilities_json: input.capabilities?.length
            ? JSON.stringify(input.capabilities)
            : null,
          now,
        });
        ctx.services.audit.record(mcpCtx, 'harness.register', 'ok', 'harness', input.harness_id);
        return toHarnessView(row);
      }),
  );

  server.registerTool(
    'harness.heartbeat',
    {
      title: '心跳',
      description: '上报 harness 存活。未注册的 harness 会返回 NOT_FOUND，请先 register。',
      inputSchema: harnessHeartbeatSchema.shape,
    },
    async (args) =>
      runTool('harness.heartbeat', log, () => {
        const input = harnessHeartbeatSchema.parse(args);
        const now = ctx.clock.now();
        if (!ctx.repos.harnesses.heartbeat(input.harness_id, now)) {
          throw new AppError('NOT_FOUND', 'HARNESS_NOT_FOUND', {
            harness_id: input.harness_id,
          });
        }
        return { harness_id: input.harness_id, at: new Date(now).toISOString() };
      }),
  );

  /* ----------------------------- channel --------------------------- */

  server.registerTool(
    'channel.upsert',
    {
      title: '建/更新通道',
      description:
        '通道 key 用 host/project/topic 三段式；已归档通道会因发卡自动恢复。' +
        'alias 是给人看的一句话概述（例如“任务树界面改造”），可随时传新值修改；' +
        '不传不会清空已有别名。',
      inputSchema: {
        channel_key: channelKeySchema,
        title: z.string().max(200).optional(),
        // 别名是展示层标签：agent 中途改它不影响 channel_key 与历史链接。
        alias: z.string().max(200).optional().nullable(),
        // 可空：旧通道没有工作路径；传非空值时 service 会登记或更正。
        workdir: z.string().max(500).optional().nullable(),
      },
    },
    async (args) =>
      runTool('channel.upsert', log, () => {
        const input = z
          .object({
            channel_key: channelKeySchema,
            title: z.string().max(200).optional(),
            alias: z.string().max(200).optional().nullable(),
            workdir: z.string().max(500).optional().nullable(),
          })
          .parse(args);
        const result = ctx.services.channels.ensure(input, mcpCtx);
        return {
          channel_key: result.channel.channel_key,
          alias: result.channel.alias,
          id: result.channel.id,
          created: result.created,
          restored: result.restored,
        };
      }),
  );

  /* ------------------------------ cards ---------------------------- */

  server.registerTool(
    'card.post',
    {
      title: '发卡',
      description:
        '发一张六类型卡片（info/handoff/question/suggestion/status/artifact）。' +
        '一张卡只说一件事；正文命中令牌/密码模式会整单拒绝。' +
        '非 question 卡必须带 task_id：信息必须挂在任务下，用户才能按任务逐条查看并消除未读；' +
        '只有 question 允许不挂任务。',
      // MCP 的 tools/list 需要基础 shape；完整类型守卫在 handler 里用 cardPostSchema 再校验一次。
      inputSchema: cardPostBase.shape,
    },
    async (args) =>
      runTool('card.post', log, () => {
        const input = cardPostSchema.parse(args);
        const result = ctx.services.cards.post(input, mcpCtx);
        return { card: result.card, created: result.created };
      }),
  );

  server.registerTool(
    'card.ask',
    {
      title: '发决策卡并等待',
      description:
        '发一张 question 卡，MCP 侧最多阻塞 25 秒（AIDASH_MCP_WAIT_CAP_SECONDS 可调）。' +
        '返回 pending 不是失败：卡片已经创建，记下 card_id，先做别的，' +
        '稍后用 card.wait 或 card.get 取答案。不要一次挂 300 秒，客户端会先判超时。',
      // 只能取 base 的 shape；完整校验（四段 + 选项规则）在 handler 里跑 cardAskSchema。
      inputSchema: cardAskBase.shape,
    },
    async (args) =>
      runTool('card.ask', log, async () => {
        const input = cardAskSchema.parse(args);
        // 只改等待时长，不改卡片内容与返回结构：超时仍然返回 pending + card_id。
        return ctx.services.decisions.ask(
          {
            ...input,
            wait_seconds: capMcpWaitSeconds(
              input.wait_seconds,
              90,
              ctx.config.maxWaitSeconds,
              ctx.config.mcpWaitCapSeconds,
            ),
          },
          mcpCtx,
          signal,
        );
      }),
  );

  server.registerTool(
    'card.get',
    {
      title: '读单张卡',
      description: '按 card_id 读取卡片详情（含答案与增强信息）。',
      inputSchema: { card_id: idSchema },
    },
    async (args) =>
      runTool('card.get', log, () => {
        const input = z.object({ card_id: idSchema }).parse(args);
        return ctx.services.cards.get(input.card_id);
      }),
  );

  server.registerTool(
    'card.wait',
    {
      title: '继续等答案',
      description:
        '继续等待已有决策卡的答案；MCP 侧最多等 25 秒，超时仍返回 pending（卡片不会消失），' +
        '不替调用方做决定。可以多次调用，每次等一小段。',
      inputSchema: {
        card_id: idSchema,
        wait_seconds: z.number().int().min(0).max(300).optional(),
      },
    },
    async (args) =>
      runTool('card.wait', log, async () => {
        const input = z
          .object({
            card_id: idSchema,
            wait_seconds: z.number().int().min(0).max(300).optional(),
          })
          .parse(args);
        return ctx.services.decisions.wait(
          input.card_id,
          capMcpWaitSeconds(
            input.wait_seconds,
            90,
            ctx.config.maxWaitSeconds,
            ctx.config.mcpWaitCapSeconds,
          ),
          signal,
        );
      }),
  );

  server.registerTool(
    'card.list',
    {
      title: '列卡/查重',
      description: '按通道、类型、状态、优先级、关键词筛选卡片；发卡前先用它查重。',
      inputSchema: mcpCardListShape,
    },
    async (args) =>
      runTool('card.list', log, () => {
        const input = z.object(mcpCardListShape).parse(args);
        return ctx.services.cards.list({
          channelKey: input.channel_key,
          project: input.project,
          types: input.type ? [input.type] : undefined,
          statuses: input.status ? [input.status] : undefined,
          priorities: input.priority ? [input.priority] : undefined,
          includeArchived: input.include_archived,
          q: input.q,
          taskId: input.task_id,
          page: input.page,
          page_size: input.page_size,
        });
      }),
  );

  /* ------------------------------ tasks ---------------------------- */

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
        '驱动状态机：submit/start/block/unblock/complete/fail/cancel/release。' +
        'complete 之前必须先发关联到该任务的 status 或 artifact 卡，否则 EVIDENCE_REQUIRED。' +
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

  /* ------------------------------- kb ------------------------------ */

  server.registerTool(
    'kb.search',
    {
      title: '搜知识库',
      description: '全文检索只读知识库；中文按字粒度建索引，支持任意子串起点。',
      inputSchema: {
        query: z.string().min(1).max(500),
        type: z.string().max(64).optional(),
        tags: z.array(z.string().max(64)).max(10).optional(),
        top_k: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) =>
      runTool('kb.search', log, () => {
        const input = z
          .object({
            query: z.string().min(1).max(500),
            type: z.string().max(64).optional(),
            tags: z.array(z.string().max(64)).max(10).optional(),
            top_k: z.number().int().min(1).max(50).optional(),
          })
          .parse(args);
        return ctx.services.kb.search(input.query, {
          type: input.type,
          tags: input.tags,
          top_k: input.top_k,
        });
      }),
  );

  server.registerTool(
    'kb.get',
    {
      title: '读知识库文章',
      description: '按相对路径读取文章；路径越界（../）会被拒绝。',
      inputSchema: { path: z.string().min(1).max(500) },
    },
    async (args) =>
      runTool('kb.get', log, () => {
        const input = z.object({ path: z.string().min(1).max(500) }).parse(args);
        return ctx.services.kb.get(input.path);
      }),
  );

  /* ------------------------------ digest --------------------------- */

  server.registerTool(
    'digest.get',
    {
      title: '取当前摘要',
      description: '拿到用户当前最关心的 P0/P1 决策、最近状态与建议；开场先调它。',
      inputSchema: digestShape,
    },
    async (args) =>
      runTool('digest.get', log, () => {
        const input = z.object(digestShape).parse(args);
        const digest = ctx.services.cards.digest(input.channel_key);
        const sinceMs = input.since ? Date.parse(input.since) : null;
        const limit = input.limit ?? digest.p0_cards.length;
        const trim = <T extends { updated_at: string }>(items: T[]): T[] =>
          items
            .filter((item) => sinceMs === null || Date.parse(item.updated_at) >= sinceMs)
            .slice(0, limit);
        return {
          ...digest,
          p0_cards: trim(digest.p0_cards),
          p1_cards: trim(digest.p1_cards),
          recent_status: trim(digest.recent_status),
          recent_suggestions: trim(digest.recent_suggestions),
        };
      }),
  );

  /* ----------------------------- memory ---------------------------- */

  server.registerTool(
    'memory.get',
    {
      title: '读主通道记忆',
      description:
        '读取某个主通道（project，即 channel_key 第二段）的完整记忆 Markdown。' +
        '记忆是跨话题通道复用的长期约束/踩坑/偏好；开场或接手项目时先读。' +
        '内容很长时优先用 memory.search 按 key 找行，避免把整篇灌进上下文。',
      inputSchema: { project: projectNameSchema },
    },
    async (args) =>
      runTool('memory.get', log, () => {
        const input = memoryGetSchema.parse(args);
        return ctx.services.memory.get(input.project);
      }),
  );

  server.registerTool(
    'memory.append',
    {
      title: '追加记忆行',
      description:
        '向主通道记忆追加若干行（一条约束一行，建议以日期/key 开头）。' +
        '默认按行去重：已经记过的行不会重复追加。' +
        '不要写进度流水、临时状态、令牌/密码；记忆只放长期有效的内容。',
      inputSchema: memoryAppendSchema.shape,
    },
    async (args) =>
      runTool('memory.append', log, () => {
        const input = memoryAppendSchema.parse(args);
        return ctx.services.memory.append(input, mcpCtx);
      }),
  );

  server.registerTool(
    'memory.search',
    {
      title: '按 key 搜记忆行',
      description:
        '在主通道记忆里按 key（大小写不敏感的子串）搜索，返回 1 基行号与命中行。' +
        '上下文有限时先搜再决定是否 memory.get；limit 控制最多返回几行。',
      inputSchema: memorySearchSchema.shape,
    },
    async (args) =>
      runTool('memory.search', log, () => {
        const input = memorySearchSchema.parse(args);
        return ctx.services.memory.search(input);
      }),
  );

  server.registerTool(
    'memory.update',
    {
      title: '整体编辑记忆',
      description:
        '用新内容整体替换主通道记忆；必须带 expected_version（先 memory.get 获取）。' +
        '版本不匹配返回 MEMORY_VERSION_CONFLICT，说明别人刚改过，需要重新读取并合并；' +
        '只是想补一条约束时用 memory.append，不要整体覆盖。',
      inputSchema: memoryUpdateSchema.shape,
    },
    async (args) =>
      runTool('memory.update', log, () => {
        const input = memoryUpdateSchema.parse(args);
        const result = ctx.services.memory.replace(input, mcpCtx);
        // 不回传整篇正文：调用方刚提交过 content_md，再回一份只会重复占用上下文。
        return {
          project: input.project,
          version: result.memory.version,
          changed: result.changed,
          line_count: result.memory.line_count,
          updated_at: result.memory.updated_at,
        };
      }),
  );
}

function toHarnessView(row: Harness): Harness & {
  capabilities: string[];
  last_seen_at: string;
  registered_at_iso: string;
} {
  let capabilities: string[] = [];
  if (row.capabilities_json) {
    try {
      const parsed = JSON.parse(row.capabilities_json);
      if (Array.isArray(parsed)) capabilities = parsed.map(String);
    } catch {
      capabilities = [];
    }
  }
  return {
    ...row,
    capabilities,
    last_seen_at: new Date(row.last_seen).toISOString(),
    registered_at_iso: new Date(row.registered_at).toISOString(),
  };
}

/**
 * 工具结果统一信封：成功 `{ok:true,data}`，失败 `{ok:false,error}`。
 * 为什么不用 JSON-RPC 协议错误：工具级失败（比如参数不合法）属于业务结果，
 * 协议层错误会让客户端以为整个连接坏了，反而看不到可操作的错误码。
 */
async function runTool(
  name: string,
  log: Logger,
  fn: () => unknown | Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return payloadResult(await fn());
  } catch (error) {
    let appError: AppError;
    if (error instanceof ZodError) {
      appError = new AppError('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    } else {
      appError = toAppError(error);
    }
    if (appError.code === 'INTERNAL') {
      log.error('mcp_tool_failed', {
        tool: name,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: false, error: appError.toBody() }, null, 2),
        },
      ],
    };
  }
}

function payloadResult(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, data }, null, 2),
      },
    ],
  };
}
