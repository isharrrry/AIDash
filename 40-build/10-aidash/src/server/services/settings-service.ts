import fs from 'node:fs';
import { AppError } from '../../shared/errors.js';
import type { Clock } from '../../shared/time.js';
import type { Ctx, LlmMode, PromptKey } from '../../shared/types.js';
import type { Db } from '../db/connection.js';
import type { SettingRepo } from '../repos/support-repos.js';
import type { AppConfig } from '../config.js';
import type { AuditService } from './audit-service.js';
import type { SecretStore, StoredLlmKeyState } from './secret-store.js';

/**
 * 运行时可调参数。
 * 只允许“改错了也不会泄露/丢数据”的项进这里；令牌、数据库路径、监听地址必须走环境变量。
 *
 * llmApiKey 例外：它是第三方模型密钥，用户明确要求“页面改完就能用”。
 * 值从 SecretStore 解密或环境变量来，进程内只驻留内存，绝不写 setting 表。
 */
export interface RuntimeSettings {
  enrichmentEnabled: boolean;
  enrichmentTimeoutMs: number;
  llmEndpoint: string | null;
  llmModel: string | null;
  llmMode: LlmMode;
  llmApiKey: string | null;
  /** 页面只显示来源，帮助用户判断“为什么改了环境变量没生效”。 */
  llmApiKeySource: 'file' | 'env' | null;
  prompts: Record<PromptKey, string>;
  kbRoot: string | null;
  memoryDigestEnabled: boolean;
  memoryDigestIntervalHours: number;
  memoryDigestWindowDays: number;
  cardRetentionDays: number;
  auditMinRetentionDays: number;
  logRetentionDays: number;
}

export interface PromptView {
  key: PromptKey;
  label: string;
  description: string;
  system: string;
  default_system: string;
}

/**
 * 既有页面设置、又有同名环境变量的键。
 *
 * 只列“走 coalesce(persisted, config)”的普通设置；`llm_api_key` 有自己的
 * 来源字段 key_source（file/env），且永不回显任何片段，不并进这里。
 */
export type EnvOverrideKey =
  | 'enrichment_enabled'
  | 'enrichment_timeout_ms'
  | 'llm_endpoint'
  | 'llm_model'
  | 'llm_mode'
  | 'kb_root'
  | 'card_retention_days'
  | 'audit_min_retention_days'
  | 'log_retention_days';

export interface EnvOverrideHint {
  key: EnvOverrideKey;
  /** 被页面值覆盖的环境变量名；只给名字，不给值。 */
  env_var: string;
}

export interface SettingsView {
  enrichment: {
    enabled: boolean;
    timeout_ms: number;
    llm: {
      endpoint: string | null;
      model: string | null;
      mode: LlmMode;
      has_api_key: boolean;
      configured: boolean;
      key_source: 'file' | 'env' | null;
      /** 加密文件的路径；用于用户自行备份/迁移，不含任何密钥内容。 */
      key_path: string;
      /**
       * 页面密钥的读取状态。`unreadable` 表示「配过但解不开」，
       * 前端应明确提示，而不是像没配一样静默回退到环境变量。
       */
      key_state: StoredLlmKeyState['status'];
      /** 仅在 key_state=unreadable 时出现。 */
      key_error?: string;
    };
    /** 知识库与模型都就绪且增强分析开启时，卡片会自动生成知识库建议。 */
    kb_suggestion_ready: boolean;
  };
  prompts: PromptView[];
  memory_digest: {
    enabled: boolean;
    interval_hours: number;
    window_days: number;
  };
  kb: { root: string | null; configured: boolean };
  retention: { card_days: number; audit_days: number; log_days: number };
  limits: {
    max_wait_seconds: number;
    lease_seconds: number;
    page_size_max: number;
    rate_limit_per_minute: number;
    /** 令牌桶容量 = 允许的突发请求数（REQ-FN-028：60）。 */
    rate_limit_burst: number;
  };
  server: {
    host: string;
    port: number;
    db_path: string;
    config_source: string;
    schema_version: number;
  };
  // 只回“是否已配置”，不回任何片段：掩码的尾号也能被用来撞库（06 SAFE-002）。
  token: { label: string; configured: boolean };
  /**
   * 页面值覆盖了同名环境变量的键。只用于设置页提示“改环境变量不会生效”，
   * 不改变任何生效值；为空数组表示没有发生覆盖。
   */
  env_overrides: EnvOverrideHint[];
}

export interface SettingsPatch {
  enrichment_enabled?: boolean;
  enrichment_timeout_ms?: number;
  llm_endpoint?: string | null;
  llm_model?: string | null;
  llm_mode?: LlmMode;
  /**
   * 只在这里出现一次：服务层把它写进 SecretStore，绝不并入持久化 JSON。
   * null / 空串 = 清除页面密钥（环境变量仍作为兜底）。
   */
  llm_api_key?: string | null;
  prompts?: Partial<Record<PromptKey, string>>;
  memory_digest_enabled?: boolean;
  memory_digest_interval_hours?: number;
  memory_digest_window_days?: number;
  kb_root?: string | null;
  card_retention_days?: number;
  audit_min_retention_days?: number;
  log_retention_days?: number;
}

const SETTINGS_KEY = 'runtime';

/**
 * 键 → 可能覆盖它的环境变量名。
 *
 * 环境变量名必须与 config.ts 的 pick() 保持一致：
 * - 超时有两个名字，新名优先；两个都设置时提示实际生效的新名。
 * - 记忆归纳、提示词没有环境变量入口，因此不在表里。
 */
const PAGE_ENV_VARS: ReadonlyArray<{
  key: EnvOverrideKey;
  envVars: readonly string[];
}> = [
  { key: 'enrichment_enabled', envVars: ['AIDASH_ENRICHMENT_ENABLED'] },
  {
    key: 'enrichment_timeout_ms',
    envVars: ['AIDASH_LLM_TIMEOUT_MS', 'AIDASH_ENRICHMENT_TIMEOUT_MS'],
  },
  { key: 'llm_endpoint', envVars: ['AIDASH_LLM_ENDPOINT'] },
  { key: 'llm_model', envVars: ['AIDASH_LLM_MODEL'] },
  { key: 'llm_mode', envVars: ['AIDASH_LLM_MODE'] },
  { key: 'kb_root', envVars: ['AIDASH_KB_ROOT'] },
  { key: 'card_retention_days', envVars: ['AIDASH_CARD_RETENTION_DAYS'] },
  { key: 'audit_min_retention_days', envVars: ['AIDASH_AUDIT_MIN_RETENTION_DAYS'] },
  { key: 'log_retention_days', envVars: ['AIDASH_LOG_RETENTION_DAYS'] },
];

export const PROMPT_KEYS: PromptKey[] = [
  'card_analysis',
  'kb_suggestion',
  'memory_digest',
  'report',
  'assistant_memory',
];

export const PROMPT_META: Array<{
  key: PromptKey;
  label: string;
  description: string;
}> = [
  {
    key: 'card_analysis',
    label: '卡片分析',
    description: '没有知识库命中时使用：分析卡片并给出可执行建议。',
  },
  {
    key: 'kb_suggestion',
    label: '知识库建议',
    description: '有知识库片段时使用：建议必须引用片段，找不到依据就少给。',
  },
  {
    key: 'memory_digest',
    label: '记忆归纳',
    description: '从最近的卡片与任务里提炼长期约束/踩过的坑，输出 JSON lines。',
  },
  {
    key: 'report',
    label: '周期汇报',
    description: '经理视角向老板汇报：日报/周报/月报与专题汇报共用。',
  },
  {
    key: 'assistant_memory',
    label: 'AIDash 记忆学习',
    description: '汇报完成后，从汇报正文里提炼值得长期保留的经验，写入 AIDash 自己的记忆。',
  },
];

/**
 * 默认提示词。
 *
 * 为什么内置而不是让用户从空白开始：
 * - “配置好 LLM 就能用”要求开箱有可工作的提示词；
 * - 每段都写死了输出形状，解析器才敢按 JSON 收敛，避免模型自由发挥导致整条链路失败。
 */
export const DEFAULT_PROMPTS: Record<PromptKey, string> = {
  card_analysis: [
    '你是个人决策助手。基于给定卡片内容，输出严格 JSON：',
    '{"analysis_md":"不超过 400 字的分析","suggestions":[{"text":"具体建议","rationale":"理由","confidence":0.0}],"confidence":0.0}',
    '要求：',
    '1. 只输出 JSON，不要 Markdown 代码块或任何额外解释；',
    '2. suggestions 最多 5 条，每条必须可执行，不要写空话；',
    '3. 没有把握时降低 confidence（0~1），不要编造事实；',
    '4. analysis_md 先给结论，再给依据；',
    '5. 排版用大白话：关键结论用 **加粗**，最需要对方注意的 1~2 处用 ==高亮==；少用缩写和术语，不要整段堆数据。',
  ].join('\n'),
  kb_suggestion: [
    '你是个人决策助手。用户消息里会提供卡片内容和知识库检索片段，输出严格 JSON：',
    '{"analysis_md":"不超过 400 字的分析","suggestions":[{"text":"具体建议","rationale":"理由","confidence":0.0}],"confidence":0.0}',
    '要求：',
    '1. 建议必须能在知识库片段中找到依据，rationale 里用 [序号] 标注引用；',
    '2. 片段不足以支撑建议时，宁可少给或不给，并在 analysis_md 说明“知识库未覆盖”；',
    '3. 不要补充片段之外的事实；只输出 JSON，不要代码块；',
    '4. 排版用大白话：关键结论用 **加粗**，最需要对方注意的 1~2 处用 ==高亮==；少用缩写和术语。',
  ].join('\n'),
  memory_digest: [
    '你是项目记忆整理助手。根据最近一段时间的卡片、任务与已有记忆，提炼“以后还会用到”的长期约束或反复踩的坑。',
    '只输出严格 JSON：{"lines":["- [YYYY-MM-DD] [key] 一句话"]}',
    '要求：',
    '1. 最多 5 行；没有值得长期保留的内容就返回 {"lines":[]}；',
    '2. 只写约束、坑、稳定偏好；不要写进度、一次性细节、已完成事项；',
    '3. key 用小写英文短词（如 deploy/auth），每行不超过 300 字；',
    '4. 已有记忆里出现过的事实不要重复；只输出 JSON，不要代码块；',
    '5. 每行用大白话，说清“以后遇到什么情况该怎么做”；关键约束用 **加粗**，最容易踩的坑用 ==高亮==；不要生造缩写。',
  ].join('\n'),
  report: [
    '你是研发经理，正在向老板汇报。目标不是罗列数据，而是说明“本期效率与能力有没有变好、下一步需不需要支持”。用 Markdown 输出：',
    '1. 一句话结论：本期最大的提效或能力成长是什么；',
    '2. 提效与能力成长：具体变化（流程、工具、自动化、复用、避坑约束）及其证据；数字只用来支撑结论，不要单独堆数据；',
    '3. 带隐患收口与复盘：哪些任务为赶进度留了隐患、当时判断是否成立、后续如何验证；没有就写“本期无记录”；',
    '4. 资源与决策请求（可选）：只有当少量资源能显著提升效率或能力时才提出，每条写清“要什么、为什么现在要、预期收益、不做的代价”；否则明确写“本期无需老板决策”。',
    '不要编造数据；素材没有的记录写“本期无记录”。控制在 800 字以内，先结论后细节。',
    '排版要求：用大白话，少用缩写；关键结论用 **加粗**，最需要老板注意的 1~2 处用 ==高亮==；每段不超过 4 行，让老板能扫读。',
  ].join('\n'),
  // 学习器的输出会被直接写进长期记忆，因此格式约束比“写得好看”更重要：
  // 统一成 `- [日期] [key] 内容`，服务端才能按行去重、用户才能按 key 搜索。
  assistant_memory: [
    '你是 AIDash 的记忆整理助手。你会看到刚生成完成的一批汇报，以及 AIDash 已有的长期记忆。',
    '请提炼“AIDash 以后做汇报/分析时能复用”的经验，而不是复述这次汇报。只输出严格 JSON：',
    '{"lines":["- [YYYY-MM-DD] [key] 一句话"]}',
    '要求：',
    '1. 最多 3 行；没有值得长期保留的内容就返回 {"lines":[]}；',
    '2. 只写：反复出现的问题与坑、被证明有效的分析方法/结构、用户明确表达过的偏好或口径；不要写一次性的业务结论、具体数字、人名或进度；',
    '3. key 用小写英文短词（如 report/risk/memory），每行不超过 300 字；',
    '4. 已有记忆里出现过的事实不要重复；只输出 JSON，不要代码块；',
    '5. 用大白话，说清“以后遇到什么情况该怎么做”；关键约束用 **加粗**，最容易踩的坑用 ==高亮==。',
  ].join('\n'),
};

const DEFAULT_MEMORY_DIGEST = {
  enabled: true,
  intervalHours: 24,
  windowDays: 7,
};

/**
 * 设置服务。
 *
 * 安全裁决（2026-10-24 起）：
 * - `llm_api_key` 允许页面写入，但只进 SecretStore 的加密文件，不进 setting 表、
 *   不进审计 detail、不进 API 响应；
 * - AIDASH_TOKEN 仍然只走环境变量，页面只显示“已配置/未配置”；
 * - 读取优先级：页面密钥 > 环境变量。这样用户换 key 不需要重启，
 *   同时保留环境变量作为“文件丢失/迁移机器”的兜底。
 */
export class SettingsService {
  private runtime: RuntimeSettings;

  constructor(
    private readonly config: AppConfig,
    private readonly settings: SettingRepo,
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly secretStore: SecretStore,
  ) {
    const persisted = this.settings.get<SettingsPatch>(SETTINGS_KEY) ?? {};
    const storedKey = secretStore.readLlmKey();
    this.runtime = {
      enrichmentEnabled: coalesce(persisted.enrichment_enabled, config.enrichmentEnabled),
      enrichmentTimeoutMs: coalesce(persisted.enrichment_timeout_ms, config.llm.timeoutMs),
      llmEndpoint: coalesce(persisted.llm_endpoint, config.llm.endpoint),
      llmModel: coalesce(persisted.llm_model, config.llm.model),
      llmMode: normalizeMode(persisted.llm_mode, config.llm.mode),
      llmApiKey: storedKey ?? config.llm.apiKey,
      llmApiKeySource: storedKey ? 'file' : config.llm.apiKey ? 'env' : null,
      prompts: normalizePrompts(persisted.prompts),
      kbRoot: coalesce(persisted.kb_root, config.kbRoot),
      memoryDigestEnabled: coalesce(
        persisted.memory_digest_enabled,
        DEFAULT_MEMORY_DIGEST.enabled,
      ),
      memoryDigestIntervalHours: coalesce(
        persisted.memory_digest_interval_hours,
        DEFAULT_MEMORY_DIGEST.intervalHours,
      ),
      memoryDigestWindowDays: coalesce(
        persisted.memory_digest_window_days,
        DEFAULT_MEMORY_DIGEST.windowDays,
      ),
      cardRetentionDays: coalesce(persisted.card_retention_days, config.cardRetentionDays),
      auditMinRetentionDays: coalesce(
        persisted.audit_min_retention_days,
        config.auditMinRetentionDays,
      ),
      logRetentionDays: coalesce(persisted.log_retention_days, config.logRetentionDays),
    };
  }

  current(): RuntimeSettings {
    return { ...this.runtime, prompts: { ...this.runtime.prompts } };
  }

  view(): SettingsView {
    const llmConfigured = Boolean(
      this.runtime.llmEndpoint && this.runtime.llmModel && this.runtime.llmApiKey,
    );
    // 重新读 setting 表而不是只看 this.runtime：update() 会先改 setting 再切 runtime，
    // 而“哪些键来自页面”属于持久化事实，直接读库能保证 GET 与 PATCH 的提示一致。
    const persisted = this.settings.get<SettingsPatch>(SETTINGS_KEY) ?? {};
    // 每次读取都重新检查：用户可能在服务运行期间换掉/删掉了主密钥。
    const keyState = this.secretStore.readLlmKeyState();
    return {
      enrichment: {
        enabled: this.runtime.enrichmentEnabled,
        timeout_ms: this.runtime.enrichmentTimeoutMs,
        llm: {
          endpoint: this.runtime.llmEndpoint,
          model: this.runtime.llmModel,
          mode: this.runtime.llmMode,
          has_api_key: Boolean(this.runtime.llmApiKey),
          configured: llmConfigured,
          key_source: this.runtime.llmApiKeySource,
          key_path: this.secretStore.filePath,
          key_state: keyState.status,
          ...(keyState.status === 'unreadable' ? { key_error: keyState.reason } : {}),
        },
        kb_suggestion_ready: Boolean(
          this.runtime.kbRoot && llmConfigured && this.runtime.enrichmentEnabled,
        ),
      },
      prompts: PROMPT_META.map((meta) => ({
        key: meta.key,
        label: meta.label,
        description: meta.description,
        system: this.runtime.prompts[meta.key],
        default_system: DEFAULT_PROMPTS[meta.key],
      })),
      memory_digest: {
        enabled: this.runtime.memoryDigestEnabled,
        interval_hours: this.runtime.memoryDigestIntervalHours,
        window_days: this.runtime.memoryDigestWindowDays,
      },
      kb: {
        root: this.runtime.kbRoot,
        configured: Boolean(this.runtime.kbRoot),
      },
      retention: {
        card_days: this.runtime.cardRetentionDays,
        audit_days: this.runtime.auditMinRetentionDays,
        log_days: this.runtime.logRetentionDays,
      },
      limits: {
        max_wait_seconds: this.config.maxWaitSeconds,
        lease_seconds: this.config.leaseSeconds,
        page_size_max: this.config.pageSizeMax,
        rate_limit_per_minute: this.config.rateLimitPerMinute,
        // 一起暴露：只报速率不报容量，前端会以为限额是「每分钟 300 个」，实际还能一口气突发 60。
        rate_limit_burst: this.config.rateLimitBurst,
      },
      server: {
        host: this.config.host,
        port: this.config.port,
        db_path: this.config.dbPath,
        config_source: this.config.configSource,
        schema_version: schemaVersion(this.db),
      },
      token: {
        label: this.config.tokenLabel,
        configured: Boolean(this.config.token),
      },
      env_overrides: envOverrideHints(persisted, this.config.aidashEnvKeys),
    };
  }

  update(patch: SettingsPatch, ctx: Ctx): SettingsView {
    const next: SettingsPatch = {};

    // 密钥单独处理：不进 next，因此不会被写进 setting.runtime。
    // 即便旧调用方把 llm_api_key 混在普通 patch 里传进来，也不会落库。
    //
    // 这里只做纯校验、不落盘：同一个请求里还有别的字段要校验，
    // 任何一个非法都必须整体失败，不能出现「报错但密钥已经被换掉」。
    const apiKeyTouched = Object.prototype.hasOwnProperty.call(patch, 'llm_api_key');
    let keyAction: 'set' | 'clear' | null = null;
    let nextApiKey: string | null = null;
    if (apiKeyTouched) {
      const raw = patch.llm_api_key;
      if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
        keyAction = 'clear';
      } else if (typeof raw === 'string') {
        nextApiKey = assertApiKey(raw);
        keyAction = 'set';
      } else {
        throw new AppError('INVALID_ARGUMENT', 'INVALID_LLM_API_KEY');
      }
    }

    if (patch.enrichment_enabled !== undefined) {
      next.enrichment_enabled = Boolean(patch.enrichment_enabled);
    }
    if (patch.enrichment_timeout_ms !== undefined) {
      next.enrichment_timeout_ms = assertRange(
        patch.enrichment_timeout_ms,
        5_000,
        300_000,
        'enrichment_timeout_ms',
      );
    }
    if (patch.llm_endpoint !== undefined) {
      next.llm_endpoint = patch.llm_endpoint ? assertHttpUrl(patch.llm_endpoint) : null;
    }
    if (patch.llm_model !== undefined) next.llm_model = patch.llm_model || null;
    if (patch.llm_mode !== undefined) next.llm_mode = assertMode(patch.llm_mode);
    if (patch.prompts !== undefined) {
      const mergedPrompt = { ...this.runtime.prompts };
      for (const key of PROMPT_KEYS) {
        const value = patch.prompts[key];
        if (value === undefined) continue;
        mergedPrompt[key] = assertPrompt(value, key);
      }
      next.prompts = mergedPrompt;
    }
    if (patch.memory_digest_enabled !== undefined) {
      next.memory_digest_enabled = Boolean(patch.memory_digest_enabled);
    }
    if (patch.memory_digest_interval_hours !== undefined) {
      next.memory_digest_interval_hours = assertRange(
        patch.memory_digest_interval_hours,
        1,
        168,
        'memory_digest_interval_hours',
      );
    }
    if (patch.memory_digest_window_days !== undefined) {
      next.memory_digest_window_days = assertRange(
        patch.memory_digest_window_days,
        1,
        90,
        'memory_digest_window_days',
      );
    }
    if (patch.kb_root !== undefined) {
      // 空字符串/null 表示“取消配置”，回退到环境变量里的默认值；
      // 非空时必须在保存前就确认目录存在——否则索引会静默扫描 0 个文件，
      // 用户只会看到“已配置但搜不到”，比直接报错难排查得多。
      const nextRoot = patch.kb_root?.trim() || null;
      if (nextRoot) assertDirectory(nextRoot);
      next.kb_root = nextRoot;
    }
    if (patch.card_retention_days !== undefined) {
      next.card_retention_days = assertRange(patch.card_retention_days, 30, 3650, 'card_retention_days');
    }
    if (patch.audit_min_retention_days !== undefined) {
      const requested = assertRange(
        patch.audit_min_retention_days,
        30,
        3650,
        'audit_min_retention_days',
      );
      // 审计保留期只能调长。范围校验挡不住「从 730 改成 30」：
      // 那等于允许一次设置就把两年的审计证据提前销毁，而清理任务会照做。
      if (requested < this.runtime.auditMinRetentionDays) {
        throw new AppError('INVALID_ARGUMENT', 'AUDIT_RETENTION_CANNOT_SHRINK', {
          current: this.runtime.auditMinRetentionDays,
          requested,
        });
      }
      next.audit_min_retention_days = requested;
    }
    if (patch.log_retention_days !== undefined) {
      next.log_retention_days = assertRange(patch.log_retention_days, 7, 365, 'log_retention_days');
    }

    const merged: SettingsPatch = { ...this.settings.get<SettingsPatch>(SETTINGS_KEY), ...next };
    // 防御历史数据：早期版本没有这个字段，但若有人手工写入，也不能让它留在库里。
    delete merged.llm_api_key;

    // 所有字段都已通过纯校验，从这里开始才允许产生副作用。
    // 顺序：先写密钥并保留旧值 → 再写数据库 → 最后切换运行时。
    // 中途失败必须把密钥恢复原状，否则页面报「保存失败」、凭证却已被换掉（D-5）。
    const previousRuntime = this.runtime;
    const previousKey = apiKeyTouched ? this.secretStore.readLlmKey() : null;
    let keyWritten = false;
    try {
      if (keyAction) {
        this.secretStore.writeLlmKey(nextApiKey);
        keyWritten = true;
        this.runtime = {
          ...this.runtime,
          llmApiKey: keyAction === 'set' ? nextApiKey : this.config.llm.apiKey,
          llmApiKeySource: keyAction === 'set' ? 'file' : this.config.llm.apiKey ? 'env' : null,
        };
      }

      this.settings.set(SETTINGS_KEY, merged, this.clock.now());

      this.runtime = {
        ...this.runtime,
        enrichmentEnabled: coalesce(merged.enrichment_enabled, this.runtime.enrichmentEnabled),
        enrichmentTimeoutMs: coalesce(
          merged.enrichment_timeout_ms,
          this.runtime.enrichmentTimeoutMs,
        ),
        // 页面把值清成 null 时，要立刻回退到配置文件/环境变量的原始值；
        // 只写 null 会变成“本次禁用、重启后又回来”，和文档里的优先级自相矛盾。
        llmEndpoint:
          merged.llm_endpoint !== undefined
            ? coalesce(merged.llm_endpoint, this.config.llm.endpoint)
            : this.runtime.llmEndpoint,
        llmModel:
          merged.llm_model !== undefined
            ? coalesce(merged.llm_model, this.config.llm.model)
            : this.runtime.llmModel,
        llmMode: normalizeMode(merged.llm_mode, this.runtime.llmMode),
        prompts: normalizePrompts(merged.prompts ?? this.runtime.prompts),
        kbRoot:
          merged.kb_root !== undefined
            ? coalesce(merged.kb_root, this.config.kbRoot)
            : this.runtime.kbRoot,
        memoryDigestEnabled: coalesce(
          merged.memory_digest_enabled,
          this.runtime.memoryDigestEnabled,
        ),
        memoryDigestIntervalHours: coalesce(
          merged.memory_digest_interval_hours,
          this.runtime.memoryDigestIntervalHours,
        ),
        memoryDigestWindowDays: coalesce(
          merged.memory_digest_window_days,
          this.runtime.memoryDigestWindowDays,
        ),
        cardRetentionDays: coalesce(merged.card_retention_days, this.runtime.cardRetentionDays),
        auditMinRetentionDays: coalesce(
          merged.audit_min_retention_days,
          this.runtime.auditMinRetentionDays,
        ),
        logRetentionDays: coalesce(merged.log_retention_days, this.runtime.logRetentionDays),
      };
    } catch (error) {
      if (keyWritten) {
        // 回滚本身也可能失败（磁盘满、权限问题）；不要用它覆盖原始错误。
        try {
          this.secretStore.writeLlmKey(previousKey);
        } catch {
          // 保留原始错误，让调用方看到真正的失败原因。
        }
      }
      this.runtime = previousRuntime;
      throw error;
    }

    this.audit.record(ctx, 'settings.update', 'ok', 'setting', SETTINGS_KEY, {
      keys: Object.keys(next),
    });
    if (keyAction) {
      // 只记动作，不记任何密钥片段。
      this.audit.record(ctx, 'settings.llm_key', 'ok', 'setting', 'llm_api_key', {
        action: keyAction,
      });
    }
    return this.view();
  }

}

function coalesce<T>(value: T | undefined | null, fallback: T): T {
  return value === undefined || value === null ? fallback : value;
}

/**
 * 找出“页面值已经盖住同名环境变量”的键。
 *
 * 判定只做三件事：页面值确实存在（非 undefined/null）、对应环境变量确实被提供、
 * 两者相撞。它不参与取值，`coalesce` 仍然是唯一的生效逻辑——这样提示出错时
 * 最坏只是少一条说明，不会改变系统行为。
 */
function envOverrideHints(
  persisted: SettingsPatch,
  aidashEnvKeys: readonly string[],
): EnvOverrideHint[] {
  const providedEnv = new Set(aidashEnvKeys);
  const hints: EnvOverrideHint[] = [];
  for (const item of PAGE_ENV_VARS) {
    const value = persisted[item.key];
    if (value === undefined || value === null) continue;
    // 新环境变量名排在前面：两个别名同时存在时，config.ts 也是新名先生效。
    const envVar = item.envVars.find((name) => providedEnv.has(name));
    if (envVar) hints.push({ key: item.key, env_var: envVar });
  }
  return hints;
}

function normalizePrompts(value: Partial<Record<PromptKey, string>> | undefined): Record<PromptKey, string> {
  const result = { ...DEFAULT_PROMPTS };
  if (!value) return result;
  for (const key of PROMPT_KEYS) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      result[key] = candidate;
    }
  }
  return result;
}

function normalizeMode(value: unknown, fallback: LlmMode): LlmMode {
  return value === 'fast' || value === 'standard' || value === 'max' ? value : fallback;
}

function assertMode(value: unknown): LlmMode {
  if (value === 'fast' || value === 'standard' || value === 'max') return value;
  throw new AppError('INVALID_ARGUMENT', 'INVALID_LLM_MODE');
}

function assertPrompt(value: string, key: PromptKey): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AppError('INVALID_ARGUMENT', 'PROMPT_EMPTY', { key });
  }
  if (trimmed.length > 8_000) {
    throw new AppError('INVALID_ARGUMENT', 'PROMPT_TOO_LARGE', { key, max_chars: 8_000 });
  }
  return trimmed;
}

/**
 * 密钥只做“形状”校验，不猜厂商前缀。
 * 不允许空白字符：粘贴时常见的换行会让 Authorization 头直接非法，
 * 提前报错比等到 401 再排查便宜得多。
 */
function assertApiKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 1_000 || /\s/.test(trimmed)) {
    throw new AppError('INVALID_ARGUMENT', 'INVALID_LLM_API_KEY', {
      expected: '8..1000 个非空白字符',
    });
  }
  return trimmed;
}

function assertRange(value: number, min: number, max: number, key: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new AppError('INVALID_ARGUMENT', 'SETTING_OUT_OF_RANGE', {
      key,
      expected: `${min}..${max}`,
    });
  }
  return n;
}

/**
 * 知识库根目录必须是已存在的目录。
 *
 * 不用 `existsSync` 一条判断：文件也存在，但把文件当根目录会在读取时
 * 以 ENOTDIR 崩在索引循环里，错误信息会离真正原因很远。
 */
function assertDirectory(value: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(value);
  } catch {
    throw new AppError('INVALID_ARGUMENT', 'KB_ROOT_NOT_FOUND', { path: value });
  }
  if (!stat.isDirectory()) {
    throw new AppError('INVALID_ARGUMENT', 'KB_ROOT_NOT_DIRECTORY', { path: value });
  }
  return value;
}

function assertHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('INVALID_ARGUMENT', 'INVALID_URL', { key: 'llm_endpoint' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('INVALID_ARGUMENT', 'UNSAFE_URL_SCHEME', { key: 'llm_endpoint' });
  }
  return url.toString();
}

function schemaVersion(db: Db): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as {
      v: number | null;
    };
    return row.v ?? 0;
  } catch {
    return 0;
  }
}
