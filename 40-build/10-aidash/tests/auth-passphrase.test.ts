import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLoopbackHost, loadConfig } from '../src/server/config.js';
import { api, createHarness, startApp, TEST_TOKEN, type RunningApp, type TestHarness } from './helpers.js';

let harness: TestHarness | null = null;
let app: RunningApp | null = null;

afterEach(async () => {
  if (app) await app.close();
  harness?.close();
  app = null;
  harness = null;
});

const NO_CONFIG_FILE = path.join(os.tmpdir(), `aidash-auth-no-config-${process.pid}.json`);

/**
 * 单一凭据模型：AIDASH_TOKEN 可以是一句短口令。
 *
 * 锁住三件事：短口令能登录、错误凭据 401、凭据不回显。
 * AIDASH_PASSPHRASE 只测“弃用别名仍能把旧配置带起来”，不再作为推荐路径。
 */
describe('访问令牌认证（支持短口令）', () => {
  it('短口令令牌可以登录；错误凭据 401；凭据不回显', async () => {
    harness = createHarness({ token: 'short-pass-123' });
    app = await startApp(harness);

    const ok = await api(app, 'GET', '/api/digest', undefined, { token: 'short-pass-123' });
    expect(ok.status).toBe(200);

    const wrong = await api(app, 'GET', '/api/digest', undefined, { token: 'wrong-pass' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.message).toBe('AUTH_INVALID_TOKEN');

    const settings = await api(app, 'GET', '/api/settings', undefined, {
      token: 'short-pass-123',
    });
    expect(settings.status).toBe(200);
    expect(settings.text).not.toContain('short-pass-123');
  });

  it('未配置的凭据不能当作令牌使用', async () => {
    harness = createHarness();
    app = await startApp(harness);
    const response = await api(app, 'GET', '/api/digest', undefined, {
      token: 'short-pass-123',
    });
    expect(response.status).toBe(401);
  });
});

describe('网络与凭据配置', () => {
  function configWith(env: Record<string, string | undefined>, includeToken = true) {
    return loadConfig(
      { ...(includeToken ? { AIDASH_TOKEN: TEST_TOKEN } : {}), ...env },
      { configFile: NO_CONFIG_FILE },
    );
  }

  it('AIDASH_HOST 可取非回环地址；回环判定只认明确写法', () => {
    expect(configWith({ AIDASH_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.20')).toBe(false);
  });

  it('AIDASH_TOKEN 可以直接填短口令；AIDASH_PASSPHRASE 仅作弃用别名', () => {
    expect(configWith({ AIDASH_TOKEN: 'short-pass' }).token).toBe('short-pass');
    expect(configWith({ AIDASH_PASSPHRASE: 'legacy-pass-123' }, false).token).toBe(
      'legacy-pass-123',
    );
    expect(() => configWith({ AIDASH_PASSPHRASE: 'short' }, false)).toThrow(/CONFIG_INVALID/);
  });

  it('没有任何凭据时拒绝启动', () => {
    expect(() => configWith({}, false)).toThrow(/CONFIG_MISSING/);
  });
});
