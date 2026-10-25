import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, createHarness, startApp, TEST_TOKEN, type RunningApp, type TestHarness } from './helpers.js';
import {
  DEFAULT_MCP_ENDPOINT,
  defaultStatusConfig,
  normalizeEndpoint,
  readToken,
  type CommandRule,
  type WatchConfig,
} from '../src/cli/config.js';
import { loadWatchConfig } from '../src/cli/config-load.js';
import {
  AuthError,
  BusinessError,
  ConfigError,
  TransportError,
  errorMessage,
  isAuthError,
  isBusinessError,
  isCliError,
  isTransportError,
} from '../src/cli/errors.js';
import { Logger, createLogger, readLogLevel, redact, truncate } from '../src/cli/log.js';
import {
  isTaskAssignableTo,
  matchesChannelFilter,
  matchesChannelPattern,
  matchesCommandRule,
  selectCommandRule,
} from '../src/cli/match.js';
import {
  parseCardId,
  parseClaimResult,
  parseDigest,
  parseTaskItem,
  parseTaskPage,
} from '../src/cli/mcp-parse.js';
import { AidashMcpClient } from '../src/cli/mcp-client.js';
import { buildChildEnv, executeCommand, isSensitiveEnvKey } from '../src/cli/exec.js';
import { HeartbeatLoop, sendHeartbeat } from '../src/cli/heartbeat.js';
import { buildFailReason, postStatusCard, releaseQuietly } from '../src/cli/report.js';
import { listTasks, runWatch, type RunContext } from '../src/cli/runner.js';
import { main, parseArgs } from '../src/cli/index.js';

/**
 * 值守壳 CLI 的单元与集成测试。
 *
 * 测试重点不是“每个函数都覆盖一行”，而是三条安全边界：
 * 1. 令牌只从环境读、日志与卡片里不出现令牌；
 * 2. 没有匹配规则/没有配置时绝不认领任务；
 * 3. 认领之后必须按状态机顺序回报（claim → start → 证据卡 → complete/fail）。
 */

const tempDirs: string[] = [];
let harness: TestHarness | null = null;
let app: RunningApp | null = null;

function tempConfig(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-cli-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'aidash-watch.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return file;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (app) await app.close();
  harness?.close();
  app = null;
  harness = null;
});

async function boot(): Promise<{ h: TestHarness; a: RunningApp }> {
  harness = createHarness();
  app = await startApp(harness);
  return { h: harness, a: app };
}

function fakeClient(handler: (name: string, args: Record<string, unknown>) => unknown) {
  return { call: vi.fn(handler) } as unknown as AidashMcpClient;
}

const baseRule: CommandRule = { command: 'echo ok', tags: [], match_all: true };

describe('CLI 配置与令牌', () => {
  it('端点归一化补 /mcp、去查询串，拒绝危险形式', () => {
    expect(normalizeEndpoint('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/mcp');
    expect(normalizeEndpoint('https://host/a/mcp/')).toBe('https://host/a/mcp');
    expect(normalizeEndpoint('http://host:8787/x?y=1#z')).toBe('http://host:8787/x/mcp');
    expect(() => normalizeEndpoint('ftp://host')).toThrow(ConfigError);
    expect(() => normalizeEndpoint('http://user:pass@host')).toThrow(ConfigError);
    expect(() => normalizeEndpoint('not a url')).toThrow(ConfigError);
    expect(defaultStatusConfig().endpoint).toBe(DEFAULT_MCP_ENDPOINT);
    expect(defaultStatusConfig().commands).toEqual([]);
  });

  it('令牌只从环境变量读，缺失/含空白都被拒', () => {
    vi.stubEnv('AIDASH_TOKEN', '');
    expect(() => readToken()).toThrow(ConfigError);
    vi.stubEnv('AIDASH_TOKEN', 'has space');
    expect(() => readToken()).toThrow(ConfigError);
    vi.stubEnv('AIDASH_TOKEN', `  ${TEST_TOKEN}  `);
    expect(readToken()).toBe(TEST_TOKEN);
  });
});

describe('CLI 错误分层', () => {
  it('四类错误各有 exitCode 与 code，守卫可区分', () => {
    const config = new ConfigError('bad');
    const auth = new AuthError('401');
    const transport = new TransportError('down', { retryable: true });
    const business = new BusinessError('CONFLICT', 'busy', { details: { x: 1 } });
    expect([config.kind, config.exitCode, config.code]).toEqual(['config', 2, 'CONFIG']);
    expect([auth.kind, auth.exitCode]).toEqual(['auth', 2]);
    expect([transport.kind, transport.exitCode, transport.retryable]).toEqual(['transport', 2, true]);
    expect([business.kind, business.exitCode, business.code, business.details]).toEqual([
      'business',
      1,
      'CONFLICT',
      { x: 1 },
    ]);
    expect(isCliError(config)).toBe(true);
    expect(isAuthError(auth)).toBe(true);
    expect(isTransportError(transport)).toBe(true);
    expect(isBusinessError(business)).toBe(true);
    expect(errorMessage(business)).toBe('[CONFLICT] busy');
    expect(errorMessage(new Error('plain'))).toBe('plain');
    expect(errorMessage('text')).toBe('text');
  });
});

describe('CLI 日志脱敏', () => {
  it('替换环境令牌、Bearer 与 KEY=VALUE，并按级别过滤', () => {
    vi.stubEnv('AIDASH_TOKEN', 'secret-token-123');
    expect(redact('token=secret-token-123')).toBe('token=***');
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer ***');
    expect(redact('AIDASH_TOKEN=abc')).toBe('AIDASH_TOKEN=***');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('ab', 0)).toBe('');
    expect(truncate('ab', 10)).toBe('ab');

    vi.stubEnv('AIDASH_WATCH_LOG_LEVEL', 'debug');
    expect(readLogLevel()).toBe('debug');
    vi.stubEnv('AIDASH_WATCH_LOG_LEVEL', 'nope');
    expect(readLogLevel()).toBe('info');

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = new Logger('warn');
    log.debug('hidden');
    log.info('hidden');
    log.warn('shown', { harness: 'h1', note: undefined });
    log.failure('回报失败', new BusinessError('CONFLICT', 'nope'));
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(String(stderr.mock.calls[0]![0])).toContain('harness=h1');
    expect(String(stderr.mock.calls[1]![0])).toContain('[CONFLICT] nope');
    expect(createLogger('error')).toBeInstanceOf(Logger);
  });
});

describe('CLI 任务匹配', () => {
  const task = {
    channel_key: 'devhost/myproj/auth',
    title: '[自动] 修复登录',
    tags: ['test', 'dev'],
    assignee: null,
  };

  it('通道精确/通配/全部，assignee 为空视为公共任务', () => {
    expect(matchesChannelPattern(task.channel_key, '*')).toBe(true);
    expect(matchesChannelPattern(task.channel_key, 'devhost/myproj/*')).toBe(true);
    expect(matchesChannelPattern(task.channel_key, 'devhost/other/*')).toBe(false);
    expect(matchesChannelPattern(task.channel_key, task.channel_key)).toBe(true);
    expect(matchesChannelFilter(task.channel_key, [])).toBe(true);
    expect(matchesChannelFilter(task.channel_key, ['x/*', 'devhost/*'])).toBe(true);
    expect(isTaskAssignableTo({ ...task, assignee: null }, 'h1')).toBe(true);
    expect(isTaskAssignableTo({ ...task, assignee: 'h1' }, 'h1')).toBe(true);
    expect(isTaskAssignableTo({ ...task, assignee: 'h2' }, 'h1')).toBe(false);
  });

  it('规则标签 AND、标题前缀忽略大小写、无条件必须 match_all', () => {
    expect(matchesCommandRule(task, { command: 'x', tags: ['test', 'dev'] })).toBe(true);
    expect(matchesCommandRule(task, { command: 'x', tags: ['test', 'prod'] })).toBe(false);
    expect(matchesCommandRule(task, { command: 'x', tags: [], title_prefix: '[自动]' })).toBe(true);
    expect(matchesCommandRule(task, { command: 'x', tags: [], title_prefix: '[手动]' })).toBe(false);
    expect(matchesCommandRule(task, { command: 'x', tags: [] })).toBe(false);
    expect(matchesCommandRule(task, { command: 'x', tags: [], match_all: true })).toBe(true);
    expect(
      matchesCommandRule(task, {
        command: 'x',
        tags: [],
        channel_key: 'devhost/myproj/*',
      }),
    ).toBe(true);
    expect(
      selectCommandRule(task, [
        { command: 'a', tags: ['prod'] },
        { command: 'b', tags: ['dev'] },
      ])?.command,
    ).toBe('b');
    expect(selectCommandRule(task, [{ command: 'a', tags: ['prod'] }])).toBeNull();
  });
});

describe('CLI MCP 响应解析', () => {
  it('任务对象兼容 tags_json 与缺省字段，缺 id 立即报传输错误', () => {
    const item = parseTaskItem({
      id: 'tk_1',
      channel_key: 'a/b/c',
      title: 't',
      tags_json: '["x","y"]',
      assignee: 'h1',
    });
    expect(item).toMatchObject({
      id: 'tk_1',
      status: 'pending',
      priority: 'P2',
      tags: ['x', 'y'],
      assignee: 'h1',
    });
    expect(parseTaskItem({ id: 'tk_2', tags: ['z'] }).tags).toEqual(['z']);
    expect(() => parseTaskItem({}, 'task.list')).toThrow(TransportError);
    expect(() => parseTaskItem(null, 'task.list')).toThrow(TransportError);
  });

  it('任务页兼容数组、items、tasks、data 信封与 hasMore/total', () => {
    expect(parseTaskPage([{ id: 'tk_1' }])).toMatchObject({ hasMore: false, total: 1 });
    expect(parseTaskPage({ items: [{ id: 'tk_1' }], has_more: true, total: 9 })).toMatchObject({
      hasMore: true,
      total: 9,
    });
    expect(parseTaskPage({ tasks: [{ id: 'tk_1' }], hasMore: true })).toMatchObject({
      hasMore: true,
    });
    expect(
      parseTaskPage({ data: { items: [{ id: 'tk_1' }], has_more: true, total: '3' } }),
    ).toMatchObject({ hasMore: true, total: 3 });
    expect(parseTaskPage({ data: { tasks: [{ id: 'tk_1' }] } }).items).toHaveLength(1);
    expect(parseTaskPage({}).items).toEqual([]);
  });

  it('认领结果与卡片 id 兼容多种信封，缺关键字段报业务错误', () => {
    const claim = parseClaimResult({ task: { id: 'tk_1' }, claim_token: 'cl_1' });
    expect(claim.token).toBe('cl_1');
    expect(claim.task.id).toBe('tk_1');
    expect(parseClaimResult({ data: { task: { id: 'tk_2' }, claim_token: 'cl_2' } }).token).toBe(
      'cl_2',
    );
    expect(() => parseClaimResult({ task: { id: 'tk_1' } })).toThrow(BusinessError);

    expect(parseCardId({ card_id: 'cd_1' })).toBe('cd_1');
    expect(parseCardId({ id: 'cd_2' })).toBe('cd_2');
    expect(parseCardId({ card: { id: 'cd_3' } })).toBe('cd_3');
    expect(parseCardId({ data: { card: { id: 'cd_4' } } })).toBe('cd_4');
    expect(() => parseCardId({})).toThrow(BusinessError);
    expect(() => parseCardId('text')).toThrow(BusinessError);
  });

  it('摘要兼容计数与数组两种形态，缺字段按 0', () => {
    expect(
      parseDigest({
        pending_decisions: 2,
        p0_cards: [{}, {}],
        p1_cards: 3,
        channels_active: 1,
        generated_at: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({
      pending_decisions: 2,
      p0_cards: 2,
      p1_cards: 3,
      channels_active: 1,
      generated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(parseDigest({ digest: { pending_decisions: '4' } }).pending_decisions).toBe(4);
    expect(parseDigest({ data: { channels_active: 5 } }).channels_active).toBe(5);
    expect(parseDigest(null)).toMatchObject({ pending_decisions: 0, channels_active: 0 });
  });
});

describe('CLI 配置加载', () => {
  it('完整配置生效：规则、相对 cwd、环境变量转换与告警', () => {
    const file = tempConfig({
      aidash_url: 'http://127.0.0.1:8787',
      harness_id: 'watch-a',
      name: '值守 A',
      host: 'devhost',
      channels: ['devhost/*'],
      capabilities: ['dev'],
      poll_interval_seconds: 5,
      lease_seconds: 120,
      heartbeat_interval_seconds: 10,
      gap_seconds: 1,
      command_timeout_seconds: 60,
      concurrency: 1,
      unknown_key: true,
      token_env: 'OTHER',
      commands: [
        {
          command: 'pnpm test',
          tags: ['test'],
          title_prefix: '[自动]',
          channel_key: 'devhost/myproj/*',
          timeout_seconds: 30,
          cwd: '.',
          env: { CI: 1, DEBUG: true },
          extra: 'ignored',
        },
        { command: 'noop', match_all: true },
      ],
    });
    const { config, warnings } = loadWatchConfig(file);
    expect(config).not.toBeNull();
    expect(config!.endpoint).toBe('http://127.0.0.1:8787/mcp');
    expect(config!.commands).toHaveLength(2);
    expect(config!.commands[0]!.env).toEqual({ CI: '1', DEBUG: 'true' });
    expect(config!.commands[0]!.cwd).toBe(path.dirname(file));
    expect(warnings.join('\n')).toContain('未知配置项 unknown_key');
    expect(warnings.join('\n')).toContain('token_env 已忽略');
    expect(warnings.join('\n')).toContain('未知字段 extra');
  });

  it('一次性收集多项配置错误；显式文件不存在直接失败', () => {
    const invalid = tempConfig({
      harness_id: 'bad id!',
      poll_interval_seconds: 0,
      concurrency: 2,
      commands: [
        { command: 'x' },
        { command: '', tags: ['a'] },
        { command: 'y', tags: ['a'], env: { 'bad-key': 'v', AIDASH_TOKEN: 'x' } },
      ],
    });
    let message = '';
    try {
      loadWatchConfig(invalid);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('name 必填');
    expect(message).toContain('harness_id 只能包含');
    expect(message).toContain('poll_interval_seconds 必须是');
    expect(message).toContain('concurrency 目前只支持 1');
    expect(message).toContain('commands[0] 至少需要');
    expect(message).toContain('commands[1].command 必填');
    expect(message).toContain('commands[2].env.bad-key 不是合法环境变量名');
    expect(message).toContain('commands[2].env.AIDASH_TOKEN 不允许设置敏感环境变量');

    expect(() => loadWatchConfig(path.join(os.tmpdir(), 'no-such-aidash.json'))).toThrow(ConfigError);
    expect(() => loadWatchConfig(tempConfig('{oops'))).toThrow(ConfigError);
    expect(() => loadWatchConfig(tempConfig([1]))).toThrow(ConfigError);
  });

  it('默认文件不存在返回 null；环境变量覆盖 URL 时给出告警', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-cli-empty-'));
    tempDirs.push(emptyDir);
    const cwd = process.cwd();
    process.chdir(emptyDir);
    try {
      expect(loadWatchConfig()).toEqual({ config: null, warnings: [] });
    } finally {
      process.chdir(cwd);
    }

    const file = tempConfig({
      aidash_url: 'http://file-host:8787',
      harness_id: 'h1',
      name: 'n',
    });
    vi.stubEnv('AIDASH_URL', 'http://env-host:8787');
    const loaded = loadWatchConfig(file);
    expect(loaded.config!.endpoint).toBe('http://env-host:8787/mcp');
    expect(loaded.warnings.join('\n')).toContain('AIDASH_URL 环境变量覆盖');
  });
});

describe('CLI 子进程执行', () => {
  it('子进程环境剔除令牌，敏感键大小写不敏感', () => {
    vi.stubEnv('AIDASH_TOKEN', 'secret-token');
    vi.stubEnv('AIDASH_LLM_API_KEY', 'llm-key');
    const env = buildChildEnv({ FOO: 'bar', aidash_token: 'x' });
    expect(env.FOO).toBe('bar');
    expect(env.AIDASH_TOKEN).toBeUndefined();
    expect(env.AIDASH_LLM_API_KEY).toBeUndefined();
    expect(isSensitiveEnvKey('aidash_llm_api_key')).toBe(true);
    expect(isSensitiveEnvKey('PATH')).toBe(false);
  });

  it('成功、非零退出、stderr、启动失败与预中断', async () => {
    const ok = await executeCommand({
      command: 'node -e "console.log(\'hello\')"',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe('hello');
    expect(ok.timedOut).toBe(false);

    const failed = await executeCommand({
      command: 'node -e "process.exit(3)"',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(failed.exitCode).toBe(3);

    const stderr = await executeCommand({
      command: 'node -e "console.error(\'bad\')"',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(stderr.stderr.trim()).toBe('bad');

    const missingCwd = await executeCommand({
      command: 'node -e "1"',
      cwd: path.join(os.tmpdir(), 'aidash-no-such-dir-xyz'),
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(missingCwd.error).not.toBeNull();

    const aborted = await executeCommand({
      command: 'node -e "1"',
      timeoutMs: 10_000,
      signal: AbortSignal.abort(),
    });
    expect(aborted.aborted).toBe(true);
  }, 20_000);

  it('超时会杀进程并标记 timedOut', async () => {
    const result = await executeCommand({
      command: 'node -e "setTimeout(()=>{},10000)"',
      timeoutMs: 100,
      signal: new AbortController().signal,
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(9_000);
  }, 20_000);
});

describe('CLI 心跳与回报', () => {
  const config: WatchConfig = {
    ...defaultStatusConfig(),
    harness_id: 'h1',
    name: 'n',
    heartbeat_interval_seconds: 3600,
  };

  it('心跳按 busy 传状态；401 停表并通知主循环', async () => {
    const okClient = fakeClient((name, args) => {
      expect(name).toBe('harness.heartbeat');
      return args;
    });
    await sendHeartbeat({ client: okClient, config, logger: new Logger('error') }, true);
    expect(okClient.call).toHaveBeenCalledWith(
      'harness.heartbeat',
      { harness_id: 'h1', status_hint: 'busy' },
      { timeoutMs: 10_000 },
    );

    const fatal = vi.fn();
    const authClient = fakeClient(() => {
      throw new AuthError('401');
    });
    const loop = new HeartbeatLoop(
      { client: authClient, config, logger: new Logger('error') },
      fatal,
    );
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loop.hasAuthFailed).toBe(true);
    expect(fatal).toHaveBeenCalledTimes(1);
    await loop.stop(false);
  });

  it('状态卡 summary 非空，释放失败只告警不抛错', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = fakeClient((name, args) => {
      calls.push({ name, args });
      if (name === 'task.release') throw new Error('network');
      return { card_id: 'cd_1' };
    });
    const cardId = await postStatusCard(
      {
        client,
        config,
        logger: new Logger('error'),
        signal: new AbortController().signal,
      },
      {
        id: 'tk_1',
        channel_key: 'a/b/c',
        title: 't',
        status: 'in_progress',
        priority: 'P1',
        tags: [],
        assignee: null,
        claim_expires_at: null,
      },
      baseRule,
      {
        exitCode: 0,
        signal: null,
        stdout: 'ok',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        aborted: false,
        durationMs: 1200,
        error: null,
      },
      true,
    );
    expect(cardId).toBe('cd_1');
    const post = calls.find((call) => call.name === 'card.post')!;
    expect(post.args.summary).toContain('命令执行成功');
    expect(post.args.result).toBe('success');
    expect(String(post.args.detail_md)).toContain('stdout');

    const failReason = buildFailReason('echo x', {
      exitCode: 2,
      signal: null,
      stdout: '',
      stderr: 'boom',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      durationMs: 500,
      error: null,
    });
    expect(failReason).toContain('退出码 2');

    await expect(
      releaseQuietly(
        { client, config, logger: new Logger('error'), signal: new AbortController().signal },
        'tk_1',
        'cl_1',
        '中断',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('CLI MCP 客户端与 runner', () => {
  it('连接真实服务：调用工具、业务错误与 401 分类', async () => {
    const { a } = await boot();
    const client = new AidashMcpClient({ endpoint: `${a.base}/mcp`, token: TEST_TOKEN });
    await client.connect();
    try {
      const harnessRow = await client.call<{ harness_id: string }>('harness.register', {
        harness_id: 'h-cli',
        name: 'CLI',
      });
      expect(harnessRow.harness_id).toBe('h-cli');
      await expect(client.call('card.get', { card_id: 'cd_missing' })).rejects.toBeInstanceOf(
        BusinessError,
      );
    } finally {
      await client.close();
    }

    const unauthorized = new AidashMcpClient({ endpoint: `${a.base}/mcp`, token: 'wrong-token' });
    await expect(unauthorized.connect()).rejects.toBeInstanceOf(AuthError);
  }, 20_000);

  it('listTasks 逐页拉取，直到没有下一页', async () => {
    const pages = [
      { items: [{ id: 'tk_1' }, { id: 'tk_2' }], has_more: true, total: 3 },
      { items: [{ id: 'tk_3' }], has_more: false, total: 3 },
    ];
    let callIndex = 0;
    const client = fakeClient(() => pages[callIndex++]);
    const items = await listTasks(client, { status: 'pending' });
    expect(items.map((item) => item.id)).toEqual(['tk_1', 'tk_2', 'tk_3']);
    expect(client.call).toHaveBeenCalledTimes(2);
  });

  it('once 模式认领、执行、发证据卡并完成任务；失败命令回报 failed', async () => {
    const { a } = await boot();
    vi.stubEnv('AIDASH_TOKEN', TEST_TOKEN);
    const config: WatchConfig = {
      ...defaultStatusConfig(),
      endpoint: `${a.base}/mcp`,
      harness_id: 'h-runner',
      name: 'runner',
      heartbeat_interval_seconds: 3600,
      poll_interval_seconds: 1,
      gap_seconds: 0,
      command_timeout_seconds: 10,
      commands: [{ command: 'node -e "console.log(\'from-runner\')"', tags: ['auto'] }],
    };
    const doneTask = await api<{ task: { id: string } }>(a, 'POST', '/api/tasks', {
      channel_key: 'devhost/myproj/cli',
      title: '自动任务',
      tags: ['auto'],
      submit: true,
    });

    const client = new AidashMcpClient({ endpoint: config.endpoint, token: TEST_TOKEN });
    await client.connect();
    const logger = new Logger('error');
    const ctx: RunContext = {
      client,
      config,
      logger,
      signal: new AbortController().signal,
    };
    try {
      await runWatch(ctx, 'once');
    } finally {
      await client.close();
    }

    const task = await api<{ status: string }>(
      a,
      'GET',
      `/api/tasks/${doneTask.body.data!.task.id}`,
    );
    expect(task.body.data?.status).toBe('done');
    const cards = await api<{ items: Array<{ summary: string; detail_md: string }> }>(
      a,
      'GET',
      '/api/cards?type=status',
    );
    expect(cards.body.data?.items[0]?.summary).toContain('命令执行成功');
    expect(cards.body.data?.items[0]?.detail_md).toContain('from-runner');

    // 第二条任务使用必然失败的命令，验证 failed 回报路径。
    const failConfig: WatchConfig = {
      ...config,
      harness_id: 'h-runner-fail',
      commands: [{ command: 'node -e "process.exit(5)"', tags: ['fail'] }],
    };
    const failTask = await api<{ task: { id: string } }>(a, 'POST', '/api/tasks', {
      channel_key: 'devhost/myproj/cli',
      title: '失败任务',
      tags: ['fail'],
      submit: true,
    });
    const failClient = new AidashMcpClient({ endpoint: config.endpoint, token: TEST_TOKEN });
    await failClient.connect();
    try {
      await runWatch(
        { client: failClient, config: failConfig, logger, signal: new AbortController().signal },
        'once',
      );
    } finally {
      await failClient.close();
    }
    const failed = await api<{ status: string }>(
      a,
      'GET',
      `/api/tasks/${failTask.body.data!.task.id}`,
    );
    expect(failed.body.data?.status).toBe('failed');
  }, 30_000);
});

describe('CLI 入口', () => {
  it('参数解析与帮助/版本不联网', async () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['run', '--config', 'x.json'])).toMatchObject({
      command: 'run',
      configPath: 'x.json',
    });
    expect(parseArgs(['--config=x.json', 'once'])).toMatchObject({ command: 'once' });
    expect(() => parseArgs(['--config'])).toThrow(ConfigError);
    expect(() => parseArgs(['--nope'])).toThrow(ConfigError);
    expect(() => parseArgs(['run', 'once'])).toThrow(ConfigError);
    expect(() => parseArgs(['bad'])).toThrow(ConfigError);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['--version'])).toBe(0);
    expect(String(stdout.mock.calls[0]![0])).toContain('aidash-watch 2.0.0');
    expect(await main(['--help'])).toBe(0);
    expect(String(stdout.mock.calls[1]![0])).toContain('用法');
  });

  it('status 只读打印摘要与任务；dry-run 标出将认领/跳过', async () => {
    const { a } = await boot();
    vi.stubEnv('AIDASH_TOKEN', TEST_TOKEN);
    vi.stubEnv('AIDASH_URL', `${a.base}/mcp`);
    const configFile = tempConfig({
      harness_id: 'h-index',
      name: '入口测试',
      commands: [{ command: 'echo ok', tags: ['auto'] }],
    });
    await api(a, 'POST', '/api/tasks', {
      channel_key: 'devhost/myproj/ui',
      title: '可跑任务',
      tags: ['auto'],
      submit: true,
    });
    await api(a, 'POST', '/api/tasks', {
      channel_key: 'devhost/myproj/ui',
      title: '别的任务',
      tags: ['other'],
      submit: true,
    });

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['status', '--config', configFile])).toBe(0);
    let output = stdout.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('AIDash 值守状态');
    expect(output).toContain('待认领任务  2');

    stdout.mockClear();
    expect(await main(['dry-run', '--config', configFile])).toBe(0);
    output = stdout.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('[将认领]');
    expect(output).toContain('[跳过]');
    expect(output).toContain('命中 1 个任务');
  }, 20_000);

  it('无配置时只允许 status；没有命令规则时给出告警', async () => {
    vi.stubEnv('AIDASH_TOKEN', TEST_TOKEN);
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-cli-entry-'));
    tempDirs.push(emptyDir);
    const cwd = process.cwd();
    process.chdir(emptyDir);
    try {
      await expect(main(['once'])).rejects.toBeInstanceOf(ConfigError);
    } finally {
      process.chdir(cwd);
    }

    const { a } = await boot();
    vi.stubEnv('AIDASH_URL', `${a.base}/mcp`);
    const noCommands = tempConfig({ harness_id: 'h-empty', name: '空规则' });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['once', '--config', noCommands])).toBe(0);
    const warnings = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(warnings).toContain('配置中没有 commands 规则');
  }, 20_000);
});
