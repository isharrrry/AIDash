import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { SecretStore } from '../src/server/services/secret-store.js';

/**
 * 页面密钥存储的状态机。
 *
 * 设计原则：只断言「用户能观察到的差别」，不测 AES 细节。
 * 重点是三类状态必须互相区分：
 *   - not_configured：从没配过，静默回退到环境变量是正常的；
 *   - unreadable：配过但解不开，必须能说出原因，且**不能**顺手造新主密钥；
 *   - ok：能解出明文。前两者混成一个 null 正是这次要修掉的静默降级。
 */

const tempDirs: string[] = [];

function makeStore(): { store: SecretStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-secret-store-'));
  tempDirs.push(dir);
  return { store: new SecretStore(dir), dir };
}

interface ChmodCall {
  target: string;
  mode: number;
}

/**
 * 注入 chmod 并记录调用，而不是 spy node:fs。
 * 好处：不碰全局模块状态，且 Windows 上 chmod 语义有限也能稳定断言——
 * 这里验证的是“store 要求目录/文件各用什么 mode”，不是操作系统是否照做。
 */
function makeStoreWithChmodRecorder(): {
  store: SecretStore;
  dir: string;
  calls: ChmodCall[];
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-secret-store-'));
  tempDirs.push(dir);
  const calls: ChmodCall[] = [];
  const store = new SecretStore(dir, (target, mode) => {
    calls.push({ target, mode });
  });
  return { store, dir, calls };
}

/** 模拟 Windows / 受限环境下 chmod 直接报 EPERM 的情况。 */
function makeStoreThatRefusesChmod(): { store: SecretStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-secret-store-'));
  tempDirs.push(dir);
  const store = new SecretStore(dir, () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  });
  return { store, dir };
}

function captureError(fn: () => void): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('预期抛出 AppError，但函数正常返回了');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SecretStore：页面密钥状态', () => {
  it('空目录是 not_configured，而不是故障', () => {
    const { store } = makeStore();
    expect(store.readLlmKeyState()).toEqual({ status: 'not_configured' });
    expect(store.readLlmKey()).toBeNull();
  });

  it('写入后可读回，磁盘上只有密文；清除后回到 not_configured', () => {
    const { store, dir } = makeStore();
    store.writeLlmKey('sk-page-secret-123');

    expect(store.readLlmKeyState()).toEqual({ status: 'ok', value: 'sk-page-secret-123' });
    const ciphertext = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    expect(ciphertext).not.toContain('sk-page-secret-123');
    // 主密钥必须真的落盘：换进程重启后还要能解开。
    expect(fs.statSync(path.join(dir, 'master.key')).size).toBe(32);

    store.writeLlmKey(null);
    expect(store.readLlmKeyState()).toEqual({ status: 'not_configured' });
    // 清除只删密文，不删主密钥：保留它，重新配 key 时旧密文才有机会被找回。
    expect(fs.existsSync(path.join(dir, 'master.key'))).toBe(true);
  });

  it('主密钥丢失：已配过的密钥报 master_key_missing，且写入被拒绝而不是换一把新钥匙', () => {
    const { store, dir } = makeStore();
    store.writeLlmKey('sk-page-secret-123');
    const masterPath = path.join(dir, 'master.key');
    const before = fs.readFileSync(masterPath);
    fs.rmSync(masterPath);

    expect(store.readLlmKeyState()).toEqual({
      status: 'unreadable',
      reason: 'master_key_missing',
    });
    expect(store.readLlmKey()).toBeNull();

    const error = captureError(() => store.writeLlmKey('sk-new-secret-456'));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe('SECRET_MASTER_KEY_MISSING');
    // 关键断言：拒绝之后不能偷偷生成新的 master.key —— 那会让旧密文永远解不开，
    // 而页面照样显示“保存成功”。
    expect(fs.existsSync(masterPath)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).toContain('llm_api_key');
    expect(before).toHaveLength(32);
  });

  it('主密钥损坏（长度不对）：报 master_key_invalid，同样拒绝覆盖', () => {
    const { store, dir } = makeStore();
    store.writeLlmKey('sk-page-secret-123');
    fs.writeFileSync(path.join(dir, 'master.key'), Buffer.alloc(16, 7));

    expect(store.readLlmKeyState()).toEqual({
      status: 'unreadable',
      reason: 'master_key_invalid',
    });
    const error = captureError(() => store.writeLlmKey('sk-new-secret-456'));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe('SECRET_MASTER_KEY_MISSING');
    expect(error.details).toMatchObject({ state: 'invalid' });
  });

  it('密文被改坏：报 decrypt_failed，而不是「没配」', () => {
    const { store, dir } = makeStore();
    store.writeLlmKey('sk-page-secret-123');
    const secretsPath = path.join(dir, 'secrets.json');
    const parsed = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as {
      llm_api_key: { data: string };
    };
    parsed.llm_api_key.data = Buffer.from('tampered').toString('base64');
    fs.writeFileSync(secretsPath, JSON.stringify(parsed));

    expect(store.readLlmKeyState()).toEqual({ status: 'unreadable', reason: 'decrypt_failed' });
    expect(store.readLlmKey()).toBeNull();
  });

  it('secrets.json 不是合法 JSON：报 secrets_file_invalid；重新保存可自救', () => {
    const { store, dir } = makeStore();
    const secretsPath = path.join(dir, 'secrets.json');
    fs.writeFileSync(secretsPath, '{ broken json');

    expect(store.readLlmKeyState()).toEqual({
      status: 'unreadable',
      reason: 'secrets_file_invalid',
    });

    // 文件里没有可用旧密文，覆盖不会丢东西；页面应当能从故障里恢复。
    store.writeLlmKey('sk-recovered-789');
    expect(store.readLlmKeyState()).toEqual({ status: 'ok', value: 'sk-recovered-789' });
  });

  it('主密钥损坏但没有旧密文：允许重建，因为没有任何东西可失去', () => {
    const { store, dir } = makeStore();
    fs.writeFileSync(path.join(dir, 'master.key'), Buffer.alloc(3, 1));

    store.writeLlmKey('sk-fresh-key-000');
    expect(store.readLlmKeyState()).toEqual({ status: 'ok', value: 'sk-fresh-key-000' });
    expect(fs.statSync(path.join(dir, 'master.key')).size).toBe(32);
  });

  it('空白密钥视为 not_configured，不当作已配置', () => {
    const { store } = makeStore();
    store.writeLlmKey('   ');
    expect(store.readLlmKeyState()).toEqual({ status: 'not_configured' });
  });
});

describe('SecretStore：权限收紧', () => {
  it('目录用 0700、文件用 0600，二者不混用', () => {
    const { store, dir, calls } = makeStoreWithChmodRecorder();
    store.writeLlmKey('sk-mode-check');

    const dirCalls = calls.filter((call) => call.target === dir);
    const masterCalls = calls.filter((call) => call.target === path.join(dir, 'master.key'));
    const secretsCalls = calls.filter((call) => call.target === path.join(dir, 'secrets.json'));

    // 先确保三类目标都真的被收紧过，避免“零调用也通过”的空断言。
    expect(dirCalls.length).toBeGreaterThan(0);
    expect(masterCalls.length).toBeGreaterThan(0);
    expect(secretsCalls.length).toBeGreaterThan(0);

    // 关键回归：目录必须带 x 位（0700）。曾经的缺陷是目录也被设成 0600，
    // 导致 owner 无法进入目录、打开里面的 master.key / secrets.json，
    // 最终 readLlmKey() 静默返回 null。
    for (const call of calls) {
      expect(call.mode).toBe(call.target === dir ? 0o700 : 0o600);
    }
  });

  it('chmod 失败是 best-effort：保存和读回都不受影响', () => {
    const { store } = makeStoreThatRefusesChmod();
    expect(() => store.writeLlmKey('sk-chmod-fails')).not.toThrow();
    expect(store.readLlmKeyState()).toEqual({ status: 'ok', value: 'sk-chmod-fails' });
  });

  it('写入本身失败仍然抛出，不会被权限处理吞掉', () => {
    const { store, dir } = makeStore();
    // 在临时文件的位置放一个目录：writeFileSync 会抛 EISDIR。
    // 这个错误属于“写入失败”，必须向上抛，而不是被 chmod 的 try/catch 顺手吞掉。
    fs.mkdirSync(`${path.join(dir, 'secrets.json')}.tmp`);

    let caught: NodeJS.ErrnoException | undefined;
    try {
      store.writeLlmKey('sk-write-fails');
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }
    expect(caught?.code).toBe('EISDIR');
  });

  it.skipIf(process.platform === 'win32')(
    'POSIX 磁盘上的真实权限：目录 0700、文件 0600',
    () => {
      const { store, dir } = makeStore();
      store.writeLlmKey('sk-real-mode');

      const modeOf = (target: string): number => fs.statSync(target).mode & 0o777;
      expect(modeOf(dir)).toBe(0o700);
      expect(modeOf(path.join(dir, 'master.key'))).toBe(0o600);
      expect(modeOf(path.join(dir, 'secrets.json'))).toBe(0o600);
    },
  );
});
