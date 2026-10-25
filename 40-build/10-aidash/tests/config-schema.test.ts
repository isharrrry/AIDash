import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../src/server/config.js';

/**
 * 配置 Schema 与代码的同步检查。
 *
 * 为什么需要这个测试：
 * 「配置项改了名，但 Schema/文档没跟上」是一类不会报错、只在部署时才炸的问题——
 * 服务端会用默认值继续跑，人却以为自己改的配置生效了。阶段 5A 的通过条件里
 * 明确要求「配置有机器可校验的 Schema」，光有一份 JSON 文件不算，得有人盯着它别漂。
 *
 * 这里用**源码正则**而不是 import 常量，原因是 config.ts 里 env 名与文件键
 * 是硬编码在 pick(...) 调用里的，没有可枚举的导出。正则提取的代价是写死了调用形状，
 * 好处是：一旦有人换写法，这个测试会红，逼他同时更新 Schema——正是我们想要的。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  HERE,
  '..',
  '..',
  '00-platform',
  'config',
  'schema',
  'aidash-config.schema.json',
);
const CONFIG_SOURCE_PATH = path.resolve(HERE, '..', 'src', 'server', 'config.ts');

interface SchemaProperty {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  deprecated?: boolean;
  description?: string;
  'x-aidash-env'?: string;
}

interface SchemaDoc {
  $schema?: string;
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, SchemaProperty>;
}

const schema: SchemaDoc = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const configSource = fs.readFileSync(CONFIG_SOURCE_PATH, 'utf8');

/**
 * 从 config.ts 里抽出所有 `pick('AIDASH_XXX', 'file_key')`。
 *
 * 只匹配单行写法：现有代码全部是单行，一旦有人拆成多行，本测试会少抓几对，
 * 而「键集合不一致」那条断言会立刻红，不会被静默放过。
 */
function extractPickPairs(source: string): Array<{ env: string; fileKey: string }> {
  const pattern = /pick\('(AIDASH_[A-Z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\)/g;
  const pairs: Array<{ env: string; fileKey: string }> = [];
  for (const match of source.matchAll(pattern)) {
    pairs.push({ env: match[1], fileKey: match[2] });
  }
  return pairs;
}

const pickPairs = extractPickPairs(configSource);
const schemaKeys = Object.keys(schema.properties ?? {}).sort();
const codeKeys = [...new Set(pickPairs.map((pair) => pair.fileKey))].sort();

/** 取一份「全默认」配置：只给必填令牌，其余一律走默认。 */
function defaultConfig(): AppConfig {
  return loadConfig({ AIDASH_TOKEN: 'schema-test-token' }, { configFile: 'no-such-file.json' });
}

/**
 * 临时配置文件目录。
 * 为什么落盘而不是 mock fs：要验证的正是「loadConfig 真的去读了这个文件并按 Schema 拒绝」，
 * mock 掉 fs 后测的就变成了 mock 本身。用完统一删。
 */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-config-test-'));
let seq = 0;

function writeTempConfig(content: unknown): string {
  const file = path.join(TMP_DIR, `config-${seq++}.json`);
  fs.writeFileSync(file, JSON.stringify(content), 'utf8');
  return file;
}

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('配置 Schema 与代码同步', () => {
  it('拼错的键名让启动失败，而不是静默回退到默认值', () => {
    expect(schema.$schema).toContain('2020-12');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);

    // 关键：把 Schema 的承诺真的喂给运行时。
    // 只断言 `additionalProperties === false` 是恒真的——Schema 文件怎么写，
    // 和运行时有没有拿它校验，是两件独立的事。这里必须让 loadConfig 真的抛错。
    const file = writeTempConfig({ prot: 8787 });
    expect(() => loadConfig({ AIDASH_TOKEN: 't' }, { configFile: file })).toThrow(
      /CONFIG_UNKNOWN_KEYS/,
    );
  });

  it('凭据不能写进配置文件：token / llm_api_key / llm.api_key 都让启动失败', () => {
    // 用户明确约束「令牌只从环境变量读」。这条测试守的是：配置文件这条路必须是死的，
    // 而不是「文档上不推荐、实际上还能用」。
    const contents: unknown[] = [
      { token: 'secret' },
      { llm_api_key: 'secret' },
      { llm: { api_key: 'secret' } },
    ];
    for (const content of contents) {
      expect(() =>
        loadConfig({ AIDASH_TOKEN: 't' }, { configFile: writeTempConfig(content) }),
      ).toThrow(/CONFIG_SECRET_IN_FILE/);
    }
  });

  it('合法的配置文件能正常加载（避免把白名单写成「什么都不许写」）', () => {
    const config = loadConfig(
      { AIDASH_TOKEN: 't' },
      { configFile: writeTempConfig({ host: '127.0.0.9', llm: { model: 'm' } }) },
    );
    expect(config.host).toBe('127.0.0.9');
    expect(config.llm.model).toBe('m');
  });

  it('文件键集合与 config.ts 的 pick(env, fileKey) 完全一致（双向）', () => {
    // `llm` 是嵌套对象，不走 pick，单独在下一个用例里校验。
    const schemaOnly = schemaKeys.filter((key) => key !== 'llm');
    expect(schemaOnly).toEqual(codeKeys);
  });

  it('每个键的 env 名与代码里的第一个参数一致', () => {
    for (const pair of pickPairs) {
      const property = schema.properties?.[pair.fileKey];
      expect(property, `Schema 缺少 ${pair.fileKey}`).toBeDefined();
      expect(
        property?.['x-aidash-env'],
        `${pair.fileKey} 的 x-aidash-env 与代码不一致`,
      ).toBe(pair.env);
    }
  });

  it('嵌套 llm 对象存在，且只允许 endpoint/model/mode 三个键', () => {
    const llm = schema.properties?.llm;
    expect(llm?.type).toBe('object');
    const nested = llm as unknown as { additionalProperties?: boolean; properties?: object };
    expect(nested.additionalProperties).toBe(false);
    // 刻意不含 api_key：密钥只认环境变量或页面写入的加密文件。
    expect(Object.keys(nested.properties ?? {}).sort()).toEqual(['endpoint', 'mode', 'model']);
  });

  /**
   * 默认值比对。
   *
   * 只覆盖「代码里默认值是字面量、且 Schema 能一对一映射」的键。
   * 刻意跳过三类：
   * - token：必填项，没有默认值；
   * - secret_dir：代码默认是 path.join(homedir(), '.aidash')，机器相关，Schema 只写描述；
   * - kb_index_interval_seconds：代码存毫秒，Schema 写秒，比对时 /1000。
   */
  const DEFAULT_READERS: Record<string, (config: AppConfig) => unknown> = {
    token_label: (c) => c.tokenLabel,
    host: (c) => c.host,
    port: (c) => c.port,
    db_path: (c) => c.dbPath,
    allow_empty_db: (c) => c.allowEmptyDb,
    kb_root: (c) => c.kbRoot,
    kb_index_interval_seconds: (c) => c.kbIndexIntervalMs / 1000,
    enrichment_enabled: (c) => c.enrichmentEnabled,
    llm_endpoint: (c) => c.llm.endpoint,
    llm_model: (c) => c.llm.model,
    llm_mode: (c) => c.llm.mode,
    llm_timeout_ms: (c) => c.llm.timeoutMs,
    lease_seconds: (c) => c.leaseSeconds,
    max_wait_seconds: (c) => c.maxWaitSeconds,
    mcp_wait_cap_seconds: (c) => c.mcpWaitCapSeconds,
    max_waiting_requests: (c) => c.maxWaitingRequests,
    page_size_max: (c) => c.pageSizeMax,
    rate_limit_per_minute: (c) => c.rateLimitPerMinute,
    rate_limit_burst: (c) => c.rateLimitBurst,
    card_retention_days: (c) => c.cardRetentionDays,
    log_retention_days: (c) => c.logRetentionDays,
    audit_min_retention_days: (c) => c.auditMinRetentionDays,
    backup_dir: (c) => c.backupDir,
    backup_retention_days: (c) => c.backupRetentionDays,
    backup_min_keep: (c) => c.backupMinKeep,
    static_dir: (c) => c.staticDir,
    log_level: (c) => c.logLevel,
    heartbeat_interval_seconds: (c) => c.heartbeatIntervalSeconds,
    offline_threshold_seconds: (c) => c.offlineThresholdSeconds,
  };

  it('Schema 的 default 与 config.ts 的实际默认值一致', () => {
    const config = defaultConfig();
    const mismatched: string[] = [];

    for (const [key, reader] of Object.entries(DEFAULT_READERS)) {
      const declared = schema.properties?.[key]?.default;
      if (declared === undefined) {
        mismatched.push(`${key}：Schema 没写 default（代码实际是 ${String(reader(config))}）`);
        continue;
      }
      const actual = reader(config);
      // 布尔 / 数字 / 字符串都是原始值，直接用全等比较。
      if (declared !== actual) {
        mismatched.push(
          `${key}：Schema=${JSON.stringify(declared)}，代码=${JSON.stringify(actual)}`,
        );
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('每个属性都有 description，避免出现「只有键名没有解释」的裸配置', () => {
    const missing = Object.entries(schema.properties ?? {})
      .filter(([, property]) => !property.description?.trim())
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });
});
