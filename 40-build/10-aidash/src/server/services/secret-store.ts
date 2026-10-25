import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../shared/errors.js';

/**
 * 本地密钥存储（只用于“页面改 key 立即生效”这一条产品需求）。
 *
 * 威胁模型与本机单用户工具一致：
 * - 要防的是“密钥被顺手带出去”：数据库备份、导出、审计、卡片正文、API 响应、日志；
 * - 不承诺防住“同一 Windows 账户下的恶意进程”——它有权限读用户目录，任何本地
 *   方案都挡不住；真要防这一层，只能把密钥放到外部 secret manager。
 *
 * 因此采用两层文件：
 * - `master.key`：32 字节随机主密钥，权限尽量收到 0600；
 * - `secrets.json`：AES-256-GCM 密封后的密文。
 * 两个文件都不在仓库、不在数据库目录、不在备份目录里。
 */

const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const FILE_VERSION = 1;
const SECRETS_FILE = 'secrets.json';
const MASTER_KEY_FILE = 'master.key';

interface SealedSecret {
  iv: string;
  tag: string;
  data: string;
}

interface SecretsFile {
  version: number;
  llm_api_key?: SealedSecret;
}

export class SecretStore {
  constructor(private readonly dir: string) {}

  /** 页面只展示路径，帮助用户知道要去哪里备份；绝不展示密钥内容。 */
  get filePath(): string {
    return path.join(this.dir, SECRETS_FILE);
  }

  get directory(): string {
    return this.dir;
  }

  /**
   * 读取页面写入的 LLM key。
   *
   * 任何异常都收敛成 null：主密钥被替换、文件被手工改坏时，
   * 调用方应当回退到环境变量，而不是让整个服务起不来。
   * 真正的错误会由“保存”路径显式报出来。
   */
  readLlmKey(): string | null {
    const sealed = this.readFile()?.llm_api_key;
    if (!sealed) return null;
    const master = this.readMasterKey();
    if (!master) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', master, Buffer.from(sealed.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(sealed.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return plain.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * 写入或清除页面密钥。
   *
   * 传 null / 空串表示只清除“页面密钥”，环境变量仍由 SettingsService 兜底；
   * 这里不负责判断回退值，否则 SecretStore 会知道太多配置语义。
   */
  writeLlmKey(value: string | null): void {
    const current = this.readFile() ?? { version: FILE_VERSION };
    if (value === null || value === '') {
      delete current.llm_api_key;
      this.writeFile(current);
      return;
    }

    this.ensureDirectory();
    const master = this.readMasterKey() ?? this.createMasterKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', master, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    current.version = FILE_VERSION;
    current.llm_api_key = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: ciphertext.toString('base64'),
    };
    this.writeFile(current);
  }

  private readFile(): SecretsFile | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as SecretsFile;
      if (!parsed || parsed.version !== FILE_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeFile(value: SecretsFile): void {
    this.ensureDirectory();
    // 先写临时文件再 rename：进程在写一半时崩掉，也不会留下半截 JSON
    // 让下一次读取误判为“没有密钥”。
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    this.chmodBestEffort(this.filePath);
  }

  private readMasterKey(): Buffer | null {
    try {
      const key = fs.readFileSync(path.join(this.dir, MASTER_KEY_FILE));
      return key.length === MASTER_KEY_BYTES ? key : null;
    } catch {
      return null;
    }
  }

  private createMasterKey(): Buffer {
    const key = randomBytes(MASTER_KEY_BYTES);
    const file = path.join(this.dir, MASTER_KEY_FILE);
    // wx：并发首次创建时只有一个进程能成功，另一个会拿到 EEXIST，
    // 此时重新读取已存在的主密钥，避免两边各用一把钥匙、互相解不开。
    try {
      fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
      this.chmodBestEffort(file);
      return key;
    } catch (error) {
      const existing = this.readMasterKey();
      if (existing) return existing;
      throw new AppError('INTERNAL', 'SECRET_STORE_WRITE_FAILED', {
        file: MASTER_KEY_FILE,
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.chmodBestEffort(this.dir);
  }

  /** Windows 上 chmod 语义有限；失败不影响功能，最多是权限比预期宽。 */
  private chmodBestEffort(target: string): void {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // 故意忽略：不要把“权限没设成”升级成保存失败。
    }
  }
}
