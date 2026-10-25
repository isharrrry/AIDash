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

/**
 * 权限位必须按目标类型分开，不能共用同一个数字：
 * - 目录要 0700（rwx------）：x 位是“可进入/可遍历”，缺了它即使 owner
 *   也没法打开目录里的 master.key / secrets.json，表现为密钥“保存了却没生效”；
 * - 文件要 0600（rw-------）：普通文件不需要 x 位，owner 可读写即可。
 * 早先目录和文件都用 0600，正是这个缺陷的根因。
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * 收紧权限的动作。抽成依赖只为测试可注入（断言目录/文件各自收到的 mode），
 * 生产默认仍是 fs.chmodSync，不改变实际行为。
 */
type ChmodFn = (target: string, mode: number) => void;

interface SealedSecret {
  iv: string;
  tag: string;
  data: string;
}

interface SecretsFile {
  version: number;
  llm_api_key?: SealedSecret;
}

/**
 * 主密钥的读取结果。
 * 区分「文件不存在」与「文件存在但内容坏了」：前者是换机/误删，
 * 后者是磁盘或人为损坏，排查方向完全不同。
 */
type MasterKeyState = { kind: 'ok'; key: Buffer } | { kind: 'missing' } | { kind: 'invalid' };

/** secrets.json 的读取结果。absent 是正常起点，invalid 才是异常。 */
type SecretsFileState =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'ok'; file: SecretsFile };

/**
 * 对外的页面密钥状态。
 *
 * 为什么需要它：readLlmKey() 只能返回 `string | null`，把「从没配过」
 * 和「配了但解不开」压成同一个 null。前者是正常状态，后者是故障 ——
 * 用户会以为密钥还在，实际增强分析已经悄悄回退到环境变量或直接停用。
 */
export type StoredLlmKeyState =
  | { status: 'ok'; value: string }
  | { status: 'not_configured' }
  | {
      status: 'unreadable';
      reason:
        | 'master_key_missing'
        | 'master_key_invalid'
        | 'decrypt_failed'
        | 'secrets_file_invalid';
    };

export class SecretStore {
  constructor(
    private readonly dir: string,
    private readonly chmod: ChmodFn = fs.chmodSync,
  ) {}

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
   * 读取失败不抛异常：一把坏掉的密钥不应该让整个服务起不来，调用方应当
   * 回退到环境变量。但「没配」和「解不开」必须能区分 —— 后者是故障，
   * 需要告警，否则用户会以为密钥还在，实际增强已经悄悄停了。
   * 需要判断原因时用 readLlmKeyState()。
   */
  readLlmKey(): string | null {
    const state = this.readLlmKeyState();
    return state.status === 'ok' ? state.value : null;
  }

  /** 页面密钥的完整状态：ok / 没配 / 解不开（带原因）。 */
  readLlmKeyState(): StoredLlmKeyState {
    const fileState = this.readFileState();
    if (fileState.kind === 'absent') return { status: 'not_configured' };
    if (fileState.kind === 'invalid') {
      return { status: 'unreadable', reason: 'secrets_file_invalid' };
    }

    const sealed = fileState.file.llm_api_key;
    if (!sealed) return { status: 'not_configured' };

    const masterState = this.readMasterKeyState();
    if (masterState.kind === 'missing') {
      return { status: 'unreadable', reason: 'master_key_missing' };
    }
    if (masterState.kind === 'invalid') {
      return { status: 'unreadable', reason: 'master_key_invalid' };
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        masterState.key,
        Buffer.from(sealed.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(sealed.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return plain.trim()
        ? { status: 'ok', value: plain }
        : { status: 'not_configured' };
    } catch {
      // 主密钥对不上（换过钥匙）或密文被改坏。GCM 的认证标签会拦下后者，
      // 所以这里不需要再区分——处置相同：要么找回旧主密钥，要么重设密钥。
      return { status: 'unreadable', reason: 'decrypt_failed' };
    }
  }

  /**
   * 写入或清除页面密钥。
   *
   * 传 null / 空串表示只清除“页面密钥”，环境变量仍由 SettingsService 兜底；
   * 这里不负责判断回退值，否则 SecretStore 会知道太多配置语义。
   */
  writeLlmKey(value: string | null): void {
    const fileState = this.readFileState();
    // 文件坏了但用户正要写入：以新文件覆盖。文件里只有这一条密钥，
    // 覆盖不会丢掉别的数据；继续报错反而让用户没法从页面自救。
    const current = fileState.kind === 'ok' ? fileState.file : { version: FILE_VERSION };
    if (value === null || value === '') {
      delete current.llm_api_key;
      this.writeFile(current);
      return;
    }

    this.ensureDirectory();
    // 必须有主密钥才能加密。**不允许**「缺了就悄悄造一把」：
    // 旧密文还在时，新钥匙会让它永久解不开，而页面照样显示保存成功。
    const master = this.requireMasterKey(current);
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

  private readFileState(): SecretsFileState {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      // 文件不存在是正常起点；权限不足、磁盘错误等都要算「坏」，
      // 否则会把故障伪装成「没配」。
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'absent' }
        : { kind: 'invalid' };
    }
    try {
      const parsed = JSON.parse(raw) as SecretsFile;
      if (!parsed || parsed.version !== FILE_VERSION) return { kind: 'invalid' };
      return { kind: 'ok', file: parsed };
    } catch {
      return { kind: 'invalid' };
    }
  }

  private writeFile(value: SecretsFile): void {
    this.ensureDirectory();
    // 先写临时文件再 rename：进程在写一半时崩掉，也不会留下半截 JSON
    // 让下一次读取误判为“没有密钥”。
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
    fs.renameSync(temp, this.filePath);
    this.chmodBestEffort(this.filePath, FILE_MODE);
  }

  private readMasterKeyState(): MasterKeyState {
    let key: Buffer;
    try {
      key = fs.readFileSync(path.join(this.dir, MASTER_KEY_FILE));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'invalid' };
    }
    return key.length === MASTER_KEY_BYTES ? { kind: 'ok', key } : { kind: 'invalid' };
  }

  /**
   * 取主密钥；只在「没有任何旧密文」时允许新建。
   *
   * 为什么这么严：主密钥丢了还能自动造一把，表面上服务照常启动，
   * 实际旧 secrets.json 永远解不开。用户只会发现「密钥好像没生效」，
   * 却没有任何提示——这正是要消除的静默降级。
   */
  private requireMasterKey(file: SecretsFile): Buffer {
    const state = this.readMasterKeyState();
    if (state.kind === 'ok') return state.key;

    if (file.llm_api_key) {
      throw new AppError('CONFLICT', 'SECRET_MASTER_KEY_MISSING', {
        file: MASTER_KEY_FILE,
        state: state.kind,
        action: '恢复 master.key；若旧密钥确实不再需要，先清空 secrets.json 再重新保存',
      });
    }

    // 主密钥文件坏了、且没有任何旧密文：没有东西可失去，直接重建。
    return this.createMasterKey(state.kind === 'invalid');
  }

  private createMasterKey(overwrite = false): Buffer {
    const key = randomBytes(MASTER_KEY_BYTES);
    const file = path.join(this.dir, MASTER_KEY_FILE);

    if (overwrite) {
      // 只在「文件存在但长度不对、且没有旧密文」时走到这里（见 requireMasterKey）。
      fs.writeFileSync(file, key, { mode: FILE_MODE });
      this.chmodBestEffort(file, FILE_MODE);
      return key;
    }

    // wx：并发首次创建时只有一个进程能成功，另一个会拿到 EEXIST，
    // 此时重新读取已存在的主密钥，避免两边各用一把钥匙、互相解不开。
    try {
      fs.writeFileSync(file, key, { mode: FILE_MODE, flag: 'wx' });
      this.chmodBestEffort(file, FILE_MODE);
      return key;
    } catch (error) {
      const existing = this.readMasterKeyState();
      if (existing.kind === 'ok') return existing.key;
      throw new AppError('INTERNAL', 'SECRET_STORE_WRITE_FAILED', {
        file: MASTER_KEY_FILE,
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    // mkdir 的 mode 会被 umask 削减，且目录可能早已存在，所以再显式收一次。
    // 这里必须是 0700：目录的 x 位缺失会让 owner 也进不去。
    this.chmodBestEffort(this.dir, DIR_MODE);
  }

  /**
   * Windows 上 chmod 语义有限；失败不影响功能，最多是权限比预期宽。
   * 注意只吞“收权限”失败，写入本身的异常仍由调用链向上抛。
   */
  private chmodBestEffort(target: string, mode: number): void {
    try {
      this.chmod(target, mode);
    } catch {
      // 故意忽略：不要把“权限没设成”升级成保存失败。
    }
  }
}
