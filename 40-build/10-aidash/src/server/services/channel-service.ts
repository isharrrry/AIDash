import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { assertNoSecrets } from '../../shared/secrets.js';
import type { Clock } from '../../shared/time.js';
import type {
  Channel,
  ChannelMeta,
  ChannelStatus,
  ChannelView,
  Ctx,
  ItemStage,
  Page,
  Priority,
} from '../../shared/types.js';
import type { ChannelRepo } from '../repos/channel-repo.js';
import type { AuditService } from './audit-service.js';

export interface EnsureChannelInput {
  channel_key: string;
  title?: string | null;
  /**
   * 给人看的一句话别名。
   *
   * 与 workdir 同一套“非空才写”规则：发卡/建任务也会走 ensure，调用方通常不带 alias，
   * 不能因为一次自动建通道就清掉 agent 之前写好的别名。
   */
  alias?: string | null;
  harness_id?: string | null;
  /**
   * 该通道对应的工作路径。
   * 只在新通道创建或已有通道传入非空且不同的值时写入：
   * 发卡/建任务也会走 ensure，不能因为调用方没带 workdir 就把已登记路径清空。
   */
  workdir?: string | null;
}

/**
 * 通道服务。
 *
 * 通道是“话题容器”，不是权限边界；同一 key 的卡必须落在同一通道，
 * 用户在网页上才不用来回切。归档通道再发卡会自动恢复（AGENTS §3.4）。
 */
export class ChannelService {
  constructor(
    private readonly channels: ChannelRepo,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    /**
     * 多久没有 MCP 活动就算“通道已停止”。
     *
     * 与 harness 心跳共用 `AIDASH_OFFLINE_THRESHOLD_SECONDS`（默认 180 秒）：
     * 两个“在线”如果各用一套阈值，用户会在设置页和通道树看到互相矛盾的结论。
     */
    private readonly offlineThresholdMs: number = 180_000,
  ) {}

  ensure(
    input: EnsureChannelInput,
    ctx: Ctx,
  ): { channel: Channel; created: boolean; restored: boolean } {
    const key = input.channel_key.trim();
    if (!key) throw new AppError('INVALID_ARGUMENT', 'CHANNEL_KEY_REQUIRED');
    const now = this.clock.now();
    const existing = this.channels.findByKey(key);
    // 空字符串按“未提供”处理，避免把用户误删成空白的输入写进库。
    const workdir = input.workdir?.trim() || null;
    const alias = input.alias?.trim() || null;
    // 别名会直接显示在通道树里；若把令牌误写进来，等于把它贴到网页上。
    if (alias) assertNoSecrets({ alias });

    if (existing) {
      let restored = false;
      if (existing.status === 'archived') {
        this.channels.setStatus(existing.id, 'active', now);
        restored = true;
        this.audit.record(ctx, 'channel.restore', 'ok', 'channel', existing.id, {
          channel_key: key,
        });
      }
      const patch: Partial<Channel> = {};
      if (input.title && input.title !== existing.title) patch.title = input.title;
      if (alias && alias !== existing.alias) patch.alias = alias;
      if (input.harness_id && input.harness_id !== existing.harness_id) {
        patch.harness_id = input.harness_id;
      }
      // 只做“登记/更正”，不做“清空”：要清空必须显式传空字符串之外的删除接口（当前不提供）。
      if (workdir && workdir !== existing.workdir) patch.workdir = workdir;
      if (restored || Object.keys(patch).length > 0) patch.updated_at = now;
      if (Object.keys(patch).length > 0) this.channels.updateMeta(existing.id, patch);
      return { channel: this.channels.get(existing.id)!, created: false, restored };
    }

    const segments = parseChannelKey(key);
    const channel: Channel = {
      id: newId('ch'),
      channel_key: key,
      title: input.title ?? null,
      alias,
      harness_id: input.harness_id ?? null,
      project: segments.project,
      topic: segments.topic,
      workdir,
      status: 'active',
      // 未观测到 MCP 活动前保持 null；入口在本次 tools/call 完成后会刷新。
      last_mcp_at: null,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    this.channels.insert(channel);
    this.audit.record(ctx, 'channel.create', 'ok', 'channel', channel.id, { channel_key: key });
    return { channel, created: true, restored: false };
  }

  getOrThrow(id: string): Channel {
    const channel = this.channels.get(id);
    if (!channel) throw new AppError('NOT_FOUND', 'CHANNEL_NOT_FOUND', { channel_id: id });
    return channel;
  }

  getByKey(key: string): Channel | undefined {
    return this.channels.findByKey(key);
  }

  getByKeyOrThrow(key: string): Channel {
    const channel = this.channels.findByKey(key);
    if (!channel) throw new AppError('NOT_FOUND', 'CHANNEL_NOT_FOUND', { channel_key: key });
    return channel;
  }

  /**
   * 批量取通道 key，供列表/摘要填视图。
   *
   * 缺失的 id 直接抛错而不是返回空串：channel_id 有外键约束，
   * 查不到说明数据已损坏；静默返回空串会让界面显示一条“无归属”记录。
   */
  keysById(ids: string[]): Map<string, string> {
    const unique = [...new Set(ids)];
    const keys = this.channels.findKeysByIds(unique);
    for (const id of unique) {
      if (!keys.has(id)) {
        throw new AppError('NOT_FOUND', 'CHANNEL_NOT_FOUND', { channel_id: id });
      }
    }
    return keys;
  }

  /** 发卡/建任务后刷新活跃时间；列表按 updated_at 排序靠它保持准。 */
  touch(id: string, now: number): void {
    this.channels.updateMeta(id, { updated_at: now });
  }

  /**
   * 记录一次 MCP 调用。
   *
   * 放在入口层统一调用，而不是散落在每个工具里：23 个工具如果各自决定
   * “算不算活动”，迟早会漏掉一两个；入口按 channel_key/task_id/card_id
   * 反查通道，读操作也能覆盖。
   */
  touchMcp(channelId: string, now: number = this.clock.now()): void {
    this.channels.touchMcp(channelId, now);
  }

  /** 按 key 补记活动；用于本请求刚创建通道、执行前还拿不到 id 的场景。 */
  touchMcpByKey(channelKey: string, now: number = this.clock.now()): void {
    this.channels.touchMcpByKey(channelKey, now);
  }

  list(
    options: { includeArchived?: boolean; page?: number; page_size?: number; q?: string } = {},
  ): Page<ChannelView> {
    const now = this.clock.now();
    const page = this.channels.list(options);
    return {
      ...page,
      items: page.items.map((row) => toChannelView(row, now, this.offlineThresholdMs)),
    };
  }

  /**
   * 单条通道视图。
   *
   * list() 的聚合查询已经带回 active_task_count；这里补一次计数，让
   * setStatus/setAlias 返回的 agent_online/agent_busy 与列表口径一致。
   */
  private viewOf(channel: Channel, now: number): ChannelView {
    return toChannelView(
      { ...channel, active_task_count: this.channels.countActiveTasks(channel.id) },
      now,
      this.offlineThresholdMs,
    );
  }

  setStatus(key: string, status: ChannelStatus, ctx: Ctx): ChannelView {
    const channel = this.getByKeyOrThrow(key);
    const now = this.clock.now();
    this.channels.setStatus(channel.id, status, now);
    this.audit.record(
      ctx,
      status === 'archived' ? 'channel.archive' : 'channel.restore',
      'ok',
      'channel',
      channel.id,
      { channel_key: channel.channel_key },
    );
    return this.viewOf(this.channels.get(channel.id)!, now);
  }

  /**
   * 单独修改别名。
   *
   * 与 ensure 的区别：这里允许传空字符串/null 来“清空别名”，因为调用方是明确的
   * 用户编辑动作，不是自动建通道的副作用。传同样的值不写库、不刷 updated_at。
   */
  setAlias(key: string, alias: string | null, ctx: Ctx): ChannelView {
    const channel = this.getByKeyOrThrow(key);
    const next = alias?.trim() || null;
    if (next) assertNoSecrets({ alias: next });
    const now = this.clock.now();
    if (next !== channel.alias) {
      this.channels.updateMeta(channel.id, { alias: next, updated_at: now });
      this.audit.record(ctx, 'channel.alias', 'ok', 'channel', channel.id, {
        channel_key: channel.channel_key,
      });
    }
    return this.viewOf(this.channels.get(channel.id)!, now);
  }

  /**
   * 修改事项人工属性。
   *
   * 与 setAlias 一样是明确的用户编辑动作：patch 中出现的字段才覆盖，
   * 空字符串归一成 null（用户清空输入框 = 清掉这个属性）。
   * 数组整体替换而不是追加——参与者/标签在页面上是一个逗号分隔输入框，
   * 追加语义会让用户删掉一个标签后再保存变成“删不掉”。
   */
  setMeta(key: string, patch: Partial<ChannelMeta>, ctx: Ctx): ChannelView {
    const channel = this.getByKeyOrThrow(key);
    const current = parseChannelMeta(channel.meta_json);
    const next: ChannelMeta = { ...current };
    if (patch.owner !== undefined) next.owner = cleanMetaText(patch.owner);
    if (patch.priority !== undefined) next.priority = cleanPriority(patch.priority);
    if (patch.stage !== undefined) next.stage = cleanStage(patch.stage);
    if (patch.group !== undefined) next.group = cleanMetaText(patch.group);
    if (patch.participants !== undefined) {
      next.participants = cleanMetaList(patch.participants);
    }
    if (patch.tags !== undefined) next.tags = cleanMetaList(patch.tags);
    if (patch.iteration !== undefined) next.iteration = cleanMetaText(patch.iteration);
    if (patch.product !== undefined) next.product = cleanMetaText(patch.product);
    if (patch.category !== undefined) next.category = cleanMetaText(patch.category);
    if (patch.remark !== undefined) next.remark = cleanMetaText(patch.remark);
    if (patch.ai_suggestion !== undefined) {
      next.ai_suggestion = cleanSuggestion(patch.ai_suggestion);
    }
    if (patch.ai_suggestion_at !== undefined) {
      next.ai_suggestion_at = cleanIsoStamp(patch.ai_suggestion_at);
    }

    const now = this.clock.now();
    const currentJson = JSON.stringify(current);
    const nextJson = JSON.stringify(next);
    if (nextJson !== currentJson) {
      this.channels.updateMeta(channel.id, { meta_json: nextJson, updated_at: now });
      this.audit.record(ctx, 'channel.meta', 'ok', 'channel', channel.id, {
        channel_key: channel.channel_key,
        fields: Object.keys(patch),
      });
    }
    return this.viewOf(this.channels.get(channel.id)!, now);
  }
}

export function parseChannelKey(key: string): {
  host: string | null;
  project: string | null;
  topic: string | null;
} {
  const parts = key.split('/').filter(Boolean);
  return {
    host: parts[0] ?? null,
    project: parts[1] ?? null,
    topic: parts.slice(2).join('/') || null,
  };
}

const EMPTY_CHANNEL_META: ChannelMeta = {
  owner: null,
  priority: null,
  stage: null,
  group: null,
  participants: [],
  tags: [],
  iteration: null,
  product: null,
  category: null,
  remark: null,
  ai_suggestion: null,
  ai_suggestion_at: null,
};

const ITEM_STAGE_VALUES: readonly ItemStage[] = [
  'planned',
  'in_progress',
  'waiting',
  'done',
  'closed',
];
const PRIORITY_VALUES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3'];

function cleanMetaText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** 建议允许比普通属性长，但仍要截断：模型偶尔会整段复述证据，列宽放不下。 */
const MAX_SUGGESTION_CHARS = 2000;

function cleanSuggestion(value: string | null | undefined): string | null {
  const text = cleanMetaText(value);
  return text ? text.slice(0, MAX_SUGGESTION_CHARS) : null;
}

/** 生成时间只接受可解析的 ISO/日期字符串，坏值按 null 处理。 */
function cleanIsoStamp(value: string | null | undefined): string | null {
  const text = cleanMetaText(value);
  if (!text || Number.isNaN(Date.parse(text))) return null;
  return text;
}

function cleanMetaList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= 30) break;
  }
  return result;
}

function cleanPriority(value: unknown): Priority | null {
  return PRIORITY_VALUES.includes(value as Priority) ? (value as Priority) : null;
}

function cleanStage(value: unknown): ItemStage | null {
  return ITEM_STAGE_VALUES.includes(value as ItemStage) ? (value as ItemStage) : null;
}

/**
 * 把 meta_json 解析成稳定形状。
 *
 * 解析失败/字段类型不对时按空值处理而不是抛错：事项属性是纯展示层数据，
 * 一条坏 JSON 不应该让整页通道列表 500。未知字段直接丢弃，避免旧版本
 * 或手改数据库留下的杂项被原样回传给前端。
 */
export function parseChannelMeta(raw: string | null | undefined): ChannelMeta {
  // 每次都新建数组：空值对象会被调用方当默认值合并，共享同一个数组引用
  // 会在后续就地修改时污染其他通道的默认值。
  if (!raw) return { ...EMPTY_CHANNEL_META, participants: [], tags: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_CHANNEL_META, participants: [], tags: [] };
  }
  const row =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    owner: cleanMetaText(row.owner as string | null | undefined),
    priority: cleanPriority(row.priority),
    stage: cleanStage(row.stage),
    group: cleanMetaText(row.group as string | null | undefined),
    participants: cleanMetaList(row.participants),
    tags: cleanMetaList(row.tags),
    iteration: cleanMetaText(row.iteration as string | null | undefined),
    product: cleanMetaText(row.product as string | null | undefined),
    category: cleanMetaText(row.category as string | null | undefined),
    remark: cleanMetaText(row.remark as string | null | undefined),
    ai_suggestion: cleanSuggestion(row.ai_suggestion as string | null | undefined),
    ai_suggestion_at: cleanIsoStamp(row.ai_suggestion_at as string | null | undefined),
  };
}

export function toChannelView(
  row: Channel & {
    card_count?: number;
    task_count?: number;
    open_task_count?: number;
    active_task_count?: number;
    last_active_at?: number | null;
  },
  now: number = Date.now(),
  offlineThresholdMs: number = 180_000,
): ChannelView {
  // 未来时间按“离线”处理：系统时钟回拨时，若只判断差值，通道会永久显示在线。
  const mcpAt = row.last_mcp_at ?? null;
  const isMcpFresh = mcpAt !== null && mcpAt <= now && now - mcpAt <= offlineThresholdMs;
  // 有 in_progress 任务 = runner 正在这条通道里干活。长任务期间 MCP 调用可能
  // 只有开始/续租/结束三拍，间隔超过离线阈值；不把任务状态算进来，正在执行
  // 的通道会显示成“已停止”。pending/claimed 不算：活儿还没真正开始。
  const isAgentBusy = (row.active_task_count ?? 0) > 0;
  const isAgentOnline = isAgentBusy || isMcpFresh;
  return {
    id: row.id,
    channel_key: row.channel_key,
    title: row.title,
    alias: row.alias,
    name: row.title,
    project: row.project,
    topic: row.topic,
    workdir: row.workdir,
    status: row.status,
    card_count: row.card_count ?? 0,
    // 单条通道（setStatus/ensure）没有走 list 的聚合查询，缺失时按 0 展示；
    // 列表接口会带真实计数，页面不需要再补查。
    task_count: row.task_count ?? 0,
    open_task_count: row.open_task_count ?? 0,
    last_mcp_at: mcpAt === null ? null : new Date(mcpAt).toISOString(),
    agent_online: isAgentOnline,
    agent_busy: isAgentBusy,
    last_active_at:
      row.last_active_at === null || row.last_active_at === undefined
        ? null
        : new Date(row.last_active_at).toISOString(),
    meta: parseChannelMeta(row.meta_json),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
