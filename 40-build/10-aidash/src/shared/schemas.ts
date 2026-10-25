import { z } from 'zod';
import {
  MAX_MEMORY_APPEND_LINES,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_LINE_CHARS,
  MAX_TASK_DESCRIPTION_CHARS,
} from './constants.js';
import type { CardType, Priority } from './types.js';

/**
 * 一份 schema 同时服务 MCP tools/list、REST 校验与 TS 类型（03 §1.3）。
 * 这里只定义“形状”；跨字段的业务规则（如 question 的选项数）放在 superRefine 里，
 * 以便 MCP 与 REST 得到同一套 INVALID_ARGUMENT。
 */

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const satisfies readonly Priority[];
export const CARD_TYPES = [
  'info',
  'handoff',
  'question',
  'suggestion',
  'status',
  'artifact',
] as const satisfies readonly CardType[];
export const CARD_STATUSES = ['open', 'answered', 'dismissed', 'expired', 'archived'] as const;
export const TASK_STATUSES = [
  'draft',
  'pending',
  'claimed',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const;
export const TASK_EVENTS = [
  'submit',
  'start',
  'block',
  'unblock',
  'complete',
  'fail',
  'cancel',
  'release',
  // retry 是 failed 的专用出口：只允许 failed → pending，意义是“重新排队”。
  // 与 submit 的区别：submit 从 draft 进入队列，retry 把已结束的失败任务放回队列；
  // 服务层要求 reason 必填，并清空失败原因与租约字段（见 task-service.ts）。
  'retry',
  // defer/undefer 不改变状态，只写“暂缓原因/计划恢复时间”覆盖层；
  // 放同一枚举是为了让 MCP 与 REST 共用一条 task.update 校验路径。
  'defer',
  'undefer',
  // flag_risk/unflag_risk 也是覆盖层：标记“带隐患完成”，不改变状态。
  // 放在这里同样是为了让 MCP 与 REST 共用校验；语义在 state-machine.ts。
  'flag_risk',
  'unflag_risk',
] as const;
export const STATUS_RESULTS = ['success', 'failed', 'blocked', 'partial'] as const;

export const prioritySchema = z.enum(PRIORITIES);
export const cardTypeSchema = z.enum(CARD_TYPES);
export const cardStatusSchema = z.enum(CARD_STATUSES);
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const taskEventSchema = z.enum(TASK_EVENTS);

/** 通道 key 同时用作 URL 片段，必须是 ASCII 且不含空白。 */
export const channelKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._~:/-]+$/, 'channel_key must be ASCII without whitespace');

export const idSchema = z.string().min(1).max(64);
export const idempotencyKeySchema = z.string().min(1).max(128);

const isoString = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be ISO 8601 datetime');

export const isoDateTimeSchema = isoString;
export const nullableIsoDateTimeSchema = isoString.nullable();

export const recommendationRoleSchema = z.enum(['primary', 'backup']);

export const optionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  // 优缺点用 Markdown：允许列清单、贴证据链接，前端按 Markdown 渲染。
  // 新卡由下方 refineQuestionOptions 强制必填；旧卡没有这两列时 UI 显示“未提供”。
  pros_md: z.string().max(4000).optional().nullable(),
  cons_md: z.string().max(4000).optional().nullable(),
  recommendation_role: recommendationRoleSchema.optional().nullable(),
  // 旧字段保留：历史上 recommendation 既存布尔也存理由字符串，不能直接删。
  recommendation: z.union([z.string().max(500), z.boolean()]).optional().nullable(),
});

/**
 * 决策项的结构校验（card.post / card.ask 共用）。
 *
 * 规则来自用户对“选项区”的明确要求：
 * - 每个选项都必须写优点和缺点（没有缺点也要显式写“无明显缺点”，避免只看好处做决定）；
 * - 恰好一个主推荐、一个备选推荐，不能出现“全是推荐”或“没有推荐”。
 *
 * 为什么用 superRefine 而不是 required 字段：优点/缺点是“新卡必填、旧卡可空”的兼容规则，
 * 放在类型层面无法表达，只能在提交时校验。
 */
export function refineQuestionOptions(
  value: {
    title?: string | null;
    background_md?: string | null;
    goal_md?: string | null;
    research_md?: string | null;
    decision_md?: string | null;
    options?: Array<{
      id: string;
      pros_md?: string | null;
      cons_md?: string | null;
      recommendation_role?: 'primary' | 'backup' | null;
    }>;
  },
  ctx: z.RefinementCtx,
): void {
  const need = (field: string, ok: boolean, message: string) => {
    if (!ok) ctx.addIssue({ code: 'custom', path: [field], message });
  };
  need('title', Boolean(value.title?.trim()), 'question requires title');
  need(
    'background_md',
    Boolean(value.background_md?.trim()),
    'question requires background_md（议题背景）',
  );
  need('goal_md', Boolean(value.goal_md?.trim()), 'question requires goal_md（达到目的或结果）');
  need(
    'research_md',
    Boolean(value.research_md?.trim()),
    'question requires research_md（调查参考；涉及资源/止损/风险必须先调查）',
  );
  need(
    'decision_md',
    Boolean(value.decision_md?.trim()),
    'question requires decision_md（决策项描述）',
  );

  const options = value.options ?? [];
  need('options', options.length >= 2 && options.length <= 10, 'question requires 2~10 options');
  const ids = new Set(options.map((option) => option.id));
  need('options', ids.size === options.length, 'option ids must be unique');

  options.forEach((option, index) => {
    need(
      `options.${index}.pros_md`,
      Boolean(option.pros_md?.trim()),
      `option ${option.id} requires pros_md（优点）`,
    );
    need(
      `options.${index}.cons_md`,
      Boolean(option.cons_md?.trim()),
      `option ${option.id} requires cons_md（缺点；没有明显缺点写“无明显缺点”）`,
    );
  });

  const primary = options.filter((option) => option.recommendation_role === 'primary').length;
  const backup = options.filter((option) => option.recommendation_role === 'backup').length;
  need('options', primary === 1, 'question requires exactly one primary recommendation');
  need('options', backup === 1, 'question requires exactly one backup recommendation');
}

export const cardAnswerSchema = z
  .object({
    option_id: z.string().max(64).optional().nullable(),
    free_text: z.string().max(4096).optional().nullable(),
    note: z.string().max(500).optional().nullable(),
  })
  .refine(
    (v) => Boolean(v.option_id) || Boolean(v.free_text && v.free_text.trim()),
    'option_id or free_text is required',
  );

export const suggestionItemSchema = z.object({
  text: z.string().min(1).max(2000),
  rationale: z.string().max(4000).optional().nullable(),
  confidence: z.number().min(0).max(1).optional().nullable(),
});

export const kbRefSchema = z.object({
  path: z.string().min(1).max(500),
  title: z.string().max(200).optional().nullable(),
  excerpt: z.string().max(4000).optional().nullable(),
});

export const linkSchema = z.object({
  label: z.string().min(1).max(100),
  url: z.string().min(1).max(2000),
});

export const pageSchema = z.object({
  page: z.number().int().min(1).optional().default(1),
  page_size: z.number().int().min(1).max(200).optional().default(50),
  sort: z.string().max(32).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

/**
 * card.post 的输入。
 * type 分支的必填项在 superRefine 中统一校验，避免 MCP/REST 各写一份 if。
 */
export const cardPostBase = z.object({
  channel_key: channelKeySchema,
    type: cardTypeSchema,
    title: z.string().max(200).optional().nullable(),
    priority: prioritySchema.optional().default('P2'),
    body_md: z.string().max(64_000).optional().nullable(),
    background_md: z.string().max(64_000).optional().nullable(),
    goal_md: z.string().max(64_000).optional().nullable(),
    research_md: z.string().max(64_000).optional().nullable(),
    decision_md: z.string().max(64_000).optional().nullable(),
    message_md: z.string().max(16_000).optional().nullable(),
    summary: z.string().max(2000).optional().nullable(),
    detail_md: z.string().max(64_000).optional().nullable(),
    severity: z.enum(['info', 'warn', 'critical']).optional().nullable(),
    recipient: z.string().max(100).optional().nullable(),
    channel_kind: z.enum(['email', 'wechat', 'other']).optional().nullable(),
    reason: z.string().max(4000).optional().nullable(),
    handoff_state: z.enum(['draft', 'copied', 'sent', 'ack']).optional().nullable(),
    options: z.array(optionSchema).min(2).max(10).optional(),
    allow_free_text: z.boolean().optional().default(false),
    default_action: z.string().max(64).optional().nullable(),
    due_at: nullableIsoDateTimeSchema.optional(),
    analysis_md: z.string().max(64_000).optional().nullable(),
    suggestions: z.array(suggestionItemSchema).min(1).max(10).optional(),
    kb_refs: z.array(kbRefSchema).max(5).optional(),
    confidence: z.number().min(0).max(1).optional().nullable(),
    result: z.string().max(16).optional().nullable(),
    url: z.string().min(1).max(2000).optional().nullable(),
    kind: z
      .enum(['commit', 'file', 'log', 'report', 'url', 'other'])
      .optional()
      .nullable(),
    size_bytes: z.number().int().min(0).optional().nullable(),
    links: z.array(linkSchema).max(20).optional(),
    blocking: z.boolean().optional().default(false),
    // 非 question 卡必填：信息必须挂在任务下，用户才能在任务详情里逐条看到并消未读。
    // question 例外——临时拍板可以先问、后建任务，强行要求会多出三次操作。
    task_id: z
      .string()
      .max(64)
      .optional()
      .nullable()
      .describe('非 question 卡必填：信息必须挂到任务下；question 可空'),
    idempotency_key: idempotencyKeySchema.optional(),
});

/**
 * card.post 的完整校验：基础形状 + 类型必填项。
 * 拆开导出是为了 MCP 的 tools/list 能拿到基础 shape，
 * handler 仍用带 superRefine 的完整 schema 做一次权威校验。
 */
export const cardPostSchema = cardPostBase.superRefine((value, ctx) => {
    const need = (field: string, ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [field], message });
    };
    // 先于类型必填项校验：这是“信息有没有归属”的硬规则，不因类型不同而放松。
    // 只有 question 允许不挂任务：它属于“先问一句再决定要不要立项”的入口，
    // 其余五种卡都是过程信息或产物，没有任务就无法判断该不该看、看没看过。
    if (value.type !== 'question') {
      need(
        'task_id',
        Boolean(value.task_id),
        `${value.type} requires task_id（信息必须挂在任务下）`,
      );
    }
    // status/handoff 的正文使用专属字段（detail_md / message_md）。
    // 过去 body_md 在这两类卡上既不报错也不落库，属于静默丢弃：
    // 调用方以为正文已写，实际查回来是空。现在入口直接拒绝，并指出该改用哪个字段。
    if (value.type === 'status' && value.body_md != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['body_md'],
        message: 'status 卡不支持 body_md，正文请用 detail_md',
      });
    }
    if (value.type === 'handoff' && value.body_md != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['body_md'],
        message: 'handoff 卡不支持 body_md，正文请用 message_md',
      });
    }
    switch (value.type) {
      case 'info':
        need('title', Boolean(value.title?.trim()), 'info requires title');
        need('body_md', Boolean(value.body_md?.trim()), 'info requires body_md');
        need('severity', Boolean(value.severity), 'info requires severity');
        break;
      case 'handoff':
        need('recipient', Boolean(value.recipient?.trim()), 'handoff requires recipient');
        need('channel_kind', Boolean(value.channel_kind), 'handoff requires channel_kind');
        need('reason', Boolean(value.reason?.trim()), 'handoff requires reason');
        need('message_md', Boolean(value.message_md?.trim()), 'handoff requires message_md');
        break;
      case 'question':
        refineQuestionOptions(value, ctx);
        break;
      case 'suggestion':
        need('analysis_md', Boolean(value.analysis_md?.trim()), 'suggestion requires analysis_md');
        need(
          'suggestions',
          Boolean(value.suggestions && value.suggestions.length > 0),
          'suggestion requires suggestions',
        );
        break;
      case 'status':
        need('summary', Boolean(value.summary?.trim()), 'status requires summary');
        need(
          'result',
          normalizeCardResult(value.result) !== null,
          'status requires result in success/failed/blocked/partial',
        );
        break;
      case 'artifact':
        need('url', Boolean(value.url?.trim()), 'artifact requires url');
        need('kind', Boolean(value.kind), 'artifact requires kind');
        need('summary', Boolean(value.summary?.trim()), 'artifact requires summary');
        break;
    }
  });

/**
 * card.ask 的基础形状。
 * MCP 的 tools/list 只能拿到基础 shape；运行时仍用下面的完整 schema 做一次权威校验。
 */
export const cardAskBase = z.object({
  channel_key: channelKeySchema,
  title: z.string().min(1).max(200),
  background_md: z.string().min(1).max(64_000),
  goal_md: z.string().min(1).max(64_000),
  research_md: z.string().min(1).max(64_000),
  decision_md: z.string().min(1).max(64_000),
  options: z.array(optionSchema).min(2).max(10),
  allow_free_text: z.boolean().optional().default(false),
  default_action: z.string().max(64).optional().nullable(),
  due_at: nullableIsoDateTimeSchema.optional(),
  priority: prioritySchema.optional().default('P1'),
  // 决策卡允许不挂任务；挂上时会在任务详情的信息流里同时出现。
  task_id: z
    .string()
    .max(64)
    .optional()
    .nullable()
    .describe('可选：挂到某个任务下，任务详情信息流会显示这张决策卡'),
  wait_seconds: z.number().int().min(0).max(300).optional().default(90),
  idempotency_key: idempotencyKeySchema.optional(),
});

export const cardAskSchema = cardAskBase.superRefine((value, ctx) => {
  refineQuestionOptions(value, ctx);
});

export const cardUpdateSchema = z.object({
  title: z.string().max(200).optional(),
  priority: prioritySchema.optional(),
});

export const taskCreateSchema = z.object({
  channel_key: channelKeySchema,
  title: z.string().min(1).max(200),
  // 任务描述允许内嵌 base64 截图，上限单独定义并与 Web 编辑器共用。
  description_md: z.string().max(MAX_TASK_DESCRIPTION_CHARS).optional().nullable(),
  parent_id: z.string().max(64).optional().nullable(),
  // 类型在入口处收窄：存储层只有 'task' 与 'suggestion' 两种；
  // 默认值放在 schema 而不是 service，保证 REST 与 MCP 两条入口行为一致。
  kind: z.enum(['task', 'suggestion']).optional().default('task'),
  // 单值分类：任务树按列展示，不能像 tags 一样并排多个。
  category: z.string().max(40).optional().nullable(),
  priority: prioritySchema.optional().default('P2'),
  assignee: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  due_at: nullableIsoDateTimeSchema.optional(),
  idempotency_key: idempotencyKeySchema.optional(),
});

export const taskPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description_md: z.string().max(MAX_TASK_DESCRIPTION_CHARS).optional().nullable(),
  /** 传 null 或空串表示清空分类。 */
  category: z.string().max(40).optional().nullable(),
  priority: prioritySchema.optional(),
  assignee: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  due_at: nullableIsoDateTimeSchema.optional(),
});

export const taskUpdateSchema = z.object({
  task_id: idSchema,
  event: taskEventSchema.optional(),
  claim_token: z.string().max(128).optional(),
  patch: taskPatchSchema.optional(),
  reason: z.string().max(4000).optional(),
  /**
   * defer 事件专用：计划什么时候恢复。
   *
   * 与 patch.due_at 分开：due_at 是截止承诺，deferred_until 是“先放一放，到点再看”。
   * 允许 null/省略，表示暂缓但未定期限。
   */
  deferred_until: nullableIsoDateTimeSchema.optional(),
  evidence_card_ids: z.array(z.string().max(64)).max(200).optional(),
});

export const taskClaimSchema = z.object({
  task_id: idSchema,
  harness_id: z.string().min(1).max(64),
  lease_seconds: z.number().int().min(1).max(86_400).optional(),
  claim_token: z.string().max(128).optional(),
});

export const taskReleaseSchema = z.object({
  task_id: idSchema,
  claim_token: z.string().min(1).max(128),
  reason: z.string().max(4000).optional().default('released'),
});

export const harnessRegisterSchema = z.object({
  harness_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/, 'harness_id must be stable ASCII'),
  name: z.string().min(1).max(128),
  host: z.string().max(128).optional().nullable(),
  capabilities: z.array(z.string().max(64)).max(32).optional(),
});

export const harnessHeartbeatSchema = z.object({
  harness_id: z.string().min(1).max(64),
  status_hint: z.enum(['idle', 'busy']).optional(),
});

/* ---------------------------- 主通道记忆 ---------------------------- */

/**
 * 主通道标识 = channel_key 的第二段（AGENTS §3.4 的 project）。
 *
 * 允许中文与常见符号，但拒绝换行：记忆键会在 REST 查询、审计和错误详情里出现，
 * 多行键既无法稳定显示，也说明调用方把整段文本误当成了 project。
 */
export const projectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\r\n]/.test(value), 'project must be a single line');

export const memoryGetSchema = z.object({
  project: projectNameSchema,
});

/**
 * 追加行。
 *
 * 为什么用 lines 数组而不是一大段 content：追加的语义单位是“一条约束一行”，
 * 数组能让服务端逐行去重、逐行校验长度；整段文本则无法区分“新行”和“重复行”。
 */
export const memoryAppendSchema = z.object({
  project: projectNameSchema,
  lines: z
    .array(z.string().min(1).max(MAX_MEMORY_LINE_CHARS))
    .min(1)
    .max(MAX_MEMORY_APPEND_LINES),
  // 默认去重：agent 重复把同一条约束写进来，是记忆膨胀最常见的原因。
  dedupe: z.boolean().optional().default(true),
});

export const memorySearchSchema = z.object({
  project: projectNameSchema,
  // key 按不区分大小写的子串匹配；限制长度避免把整段文档当查询词。
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional().default(50),
});

/**
 * 整体编辑。
 *
 * expected_version 必填而不是可选：整篇替换是唯一会覆盖别人编辑的操作，
 * 调用方必须先读一次拿到版本号；版本不匹配就返回冲突，由人/agent 合并后重试。
 */
export const memoryUpdateSchema = z.object({
  project: projectNameSchema,
  content_md: z.string().max(MAX_MEMORY_CHARS),
  expected_version: z.number().int().min(0),
});

/**
 * AIDash 自身记忆的整体编辑。
 *
 * 与主对话记忆共用同一套上限与乐观锁，但没有 project：这份记忆全局只有一份。
 * expected_version 仍然必填——自动学习器可能刚追加过内容，页面直接覆盖会丢经验。
 */
export const assistantMemoryUpdateSchema = z.object({
  content_md: z.string().max(MAX_MEMORY_CHARS),
  expected_version: z.number().int().min(0),
});

/**
 * 历史调用方可能传 ok/fail；DB 只存 04/AGENTS 约定的四个值。
 * 在入口统一归一化，避免把两套枚举写进数据库。
 */
export function normalizeCardResult(
  result: unknown,
): 'success' | 'failed' | 'blocked' | 'partial' | null {
  const raw = String(result ?? '').toLowerCase();
  if (raw === 'ok' || raw === 'success') return 'success';
  if (raw === 'fail' || raw === 'failed') return 'failed';
  if (raw === 'blocked') return 'blocked';
  if (raw === 'partial') return 'partial';
  return null;
}
