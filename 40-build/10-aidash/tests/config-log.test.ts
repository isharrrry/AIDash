import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { ManualClock } from '../src/shared/time.js';
import { loadConfig } from '../src/server/config.js';
import { createLogger } from '../src/server/log.js';

const tempFiles: string[] = [];

function writeConfig(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-config-'));
  const file = path.join(dir, 'aidash.config.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  tempFiles.push(file);
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.message;
    throw error;
  }
  throw new Error('expected throw');
}

describe('配置加载', () => {
  it('缺令牌立刻失败，非法 JSON 与非法数值也有明确错误', () => {
    expect(codeOf(() => loadConfig({}, { configFile: writeConfig({}) }))).toBe('CONFIG_MISSING');
    expect(codeOf(() => loadConfig({}, { configFile: writeConfig('{oops') }))).toBe(
      'CONFIG_FILE_INVALID',
    );
    expect(codeOf(() => loadConfig({}, { configFile: writeConfig([1, 2]) }))).toBe(
      'CONFIG_FILE_INVALID',
    );
    expect(
      codeOf(() =>
        loadConfig(
          { AIDASH_TOKEN: 't', AIDASH_PORT: '70000' },
          { configFile: writeConfig({}) },
        ),
      ),
    ).toBe('CONFIG_INVALID');
  });

  it('环境变量优先于文件，文件里的 llm 嵌套对象可兜底（凭据除外）', () => {
    const file = writeConfig({
      host: '0.0.0.0',
      port: 9000,
      enrichment_enabled: true,
      // 刻意不写 token / api_key：凭据只认环境变量，写进文件会直接让启动失败。
      // 「文件里的凭据被拒绝」由 config-schema.test.ts 的 CONFIG_SECRET_IN_FILE 用例守着；
      // 这里只验证非凭据键的优先级与兜底没有被误伤。
      llm: { endpoint: 'https://file.example/v1', model: 'file-model' },
      max_wait_seconds: 30,
    });
    const config = loadConfig(
      {
        AIDASH_TOKEN: 'env-token',
        AIDASH_HOST: '127.0.0.2',
        AIDASH_ENRICHMENT_ENABLED: '1',
        AIDASH_LLM_API_KEY: 'env-key',
      },
      { configFile: file },
    );
    expect(config.token).toBe('env-token');
    expect(config.host).toBe('127.0.0.2');
    expect(config.port).toBe(9000);
    expect(config.enrichmentEnabled).toBe(true);
    expect(config.llm.endpoint).toBe('https://file.example/v1');
    expect(config.llm.model).toBe('file-model');
    expect(config.llm.apiKey).toBe('env-key');
    expect(config.maxWaitSeconds).toBe(30);
    expect(config.configSource).toBe(file);
  });

  it('无配置文件时回落到默认值并记录来源', () => {
    const missing = path.join(os.tmpdir(), `aidash-missing-${Date.now()}.json`);
    const config = loadConfig({ AIDASH_TOKEN: 't' }, { configFile: missing });
    expect(config.configSource).toBe('env+defaults');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.enrichmentEnabled).toBe(true);
    expect(config.kbIndexIntervalMs).toBe(300_000);
  });
});

describe('日志', () => {
  it('按级别过滤，密钥键名被替换，Error 只留 name/message', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = createLogger('warn');

    log.debug('debug-line');
    log.info('info-line');
    expect(stdout).not.toHaveBeenCalled();

    log.warn('warn-line', {
      authorization: 'Bearer secret-token',
      llm_api_key: 'sk-123',
      error: new Error('boom'),
      count: 3,
    });
    expect(stderr).toHaveBeenCalledTimes(1);
    const line = String(stderr.mock.calls[0]![0]);
    expect(line).toContain('"authorization":"[redacted]"');
    expect(line).toContain('"llm_api_key":"[redacted]"');
    expect(line).toContain('"name":"Error"');
    expect(line).toContain('"count":3');
    expect(line).not.toContain('secret-token');

    log.error('error-line');
    expect(stderr).toHaveBeenCalledTimes(2);
  });
});

describe('时间工具', () => {
  it('ManualClock 可设置与推进', () => {
    const clock = new ManualClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});
