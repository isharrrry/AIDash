import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagerError } from './errors.js';
import { atomicWriteFileSync, exists, resolvePath } from './util.js';

const SCHEMA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema', 'aidash-config.schema.json');

let cachedSchema = null;

export function aidashConfigSchema() {
  if (cachedSchema) return cachedSchema;
  cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  return cachedSchema;
}

/**
 * 只实现 AIDash Schema 用到的关键字：type/enum/minLength/minimum/maximum/
 * additionalProperties/format(uri)。引入完整 JSON-Schema 库会让一个本应
 * 零依赖的本地工具多出几十个传递依赖，而这里的 schema 是固定且受控的。
 *
 * 校验目标不是“成为通用校验器”，而是让页面保存前就发现服务端启动时才会
 * 报的错：未知键、类型不对、超出范围。
 */
export function validateAidashConfig(value, schema = aidashConfigSchema(), at = '$') {
  const errors = [];
  validateNode(value, schema, at, errors);
  return errors;
}

function typeMatches(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function validateNode(value, schema, at, errors) {
  if (!schema || typeof schema !== 'object') return;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
    errors.push(`${at} 必须是 ${types.join(' 或 ')}（当前：${describe(value)}）`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at} 只能是 ${schema.enum.join(' / ')}（当前：${JSON.stringify(value)}）`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at} 长度不能小于 ${schema.minLength}`);
    }
    if (schema.format === 'uri') {
      try {
        new URL(value);
      } catch {
        errors.push(`${at} 不是合法 URL：${value}`);
      }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} 不能小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} 不能大于 ${schema.maximum}`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          errors.push(`${at}.${key} 不是受支持的配置项（拼写错误会导致服务端拒绝启动）`);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) {
        validateNode(value[key], childSchema, `${at}.${key}`, errors);
      }
    }
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function readAidashConfigFile(filePath) {
  if (!exists(filePath)) return { exists: false, raw: null, text: '', errors: [] };
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ManagerError('CONFIG_READ_FAILED', `读取配置文件失败：${filePath}（${error.message}）`, {
      status: 400,
    });
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { exists: true, raw: null, text, errors: [`配置文件不是合法 JSON：${error.message}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { exists: true, raw: null, text, errors: ['配置文件顶层必须是 JSON 对象'] };
  }
  const errors = validateAidashConfig(raw);
  if (Object.prototype.hasOwnProperty.call(raw, 'token')) {
    errors.unshift('token 不能写进配置文件：AIDash 只从 AIDASH_TOKEN 环境变量读取');
  }
  if (raw.llm && typeof raw.llm === 'object' && Object.prototype.hasOwnProperty.call(raw.llm, 'api_key')) {
    errors.unshift('llm.api_key 不能写进配置文件：AIDash 只从环境变量或页面加密存储读取');
  }
  return { exists: true, raw, text, errors };
}

export function writeAidashConfigFile(filePath, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManagerError('CONFIG_INVALID', '配置文件顶层必须是 JSON 对象');
  }
  const errors = validateAidashConfig(raw);
  if (errors.length > 0) {
    throw new ManagerError('CONFIG_INVALID', '配置文件校验未通过', { details: { errors } });
  }
  atomicWriteFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 0o600);
  return raw;
}

/**
 * 页面表单的常用字段。不是完整键表——完整键以 Schema 与 JSON 编辑器为准；
 * 这里只挑“创建服务时就要填、改了立刻有感知”的一组，并给出必填/范围提示。
 */
export const AIDASH_CORE_FIELDS = [
  {
    group: '监听与存储',
    key: 'host',
    label: '监听地址',
    type: 'string',
    required: true,
    default: '127.0.0.1',
    hint: '默认只监听本机。改成 0.0.0.0 会暴露到局域网，请自行配 TLS/反向代理。',
  },
  {
    group: '监听与存储',
    key: 'port',
    label: '端口',
    type: 'integer',
    required: true,
    default: 8787,
    min: 1,
    max: 65535,
    hint: '同一台机器上的多个 AIDash 实例必须使用不同端口。',
  },
  {
    group: '监听与存储',
    key: 'db_path',
    label: 'SQLite 库路径',
    type: 'string',
    required: true,
    default: './40-build/10-aidash/data/aidash.db',
    hint: '相对路径按服务的工作目录解析；页面会显示解析后的绝对路径。',
  },
  {
    group: '监听与存储',
    key: 'backup_dir',
    label: '备份目录',
    type: 'string',
    default: './40-build/10-aidash/backups',
    hint: '迁移前备份和手动备份的存放位置。',
  },
  {
    group: '监听与存储',
    key: 'static_dir',
    label: 'Web 静态目录',
    type: 'string',
    default: './40-build/10-aidash/dist/web',
    hint: 'AIDash Web 构建产物目录；未构建时服务端仍能启动，但网页不可用。',
  },
  {
    group: '监听与存储',
    key: 'allow_empty_db',
    label: '允许建空库',
    type: 'boolean',
    default: false,
    hint: '库文件不存在但备份目录有备份时，默认拒绝启动，避免路径漂移后误建空库。',
  },
  {
    group: '日志与保留',
    key: 'log_level',
    label: '日志级别',
    type: 'string',
    enum: ['debug', 'info', 'warn', 'error'],
    default: 'info',
  },
  {
    group: '日志与保留',
    key: 'log_retention_days',
    label: '日志保留天数',
    type: 'integer',
    default: 30,
    min: 7,
    max: 365,
  },
  {
    group: '知识库与 LLM',
    key: 'kb_root',
    label: '知识库根目录',
    type: 'string',
    default: '',
    hint: '留空表示不启用知识库索引。',
  },
  {
    group: '知识库与 LLM',
    key: 'enrichment_enabled',
    label: '启用 LLM 增强',
    type: 'boolean',
    default: true,
    hint: '没有配置密钥时增强会自动 skipped，不会产生请求。',
  },
  {
    group: '知识库与 LLM',
    key: 'llm_endpoint',
    label: 'LLM 端点',
    type: 'string',
    default: 'https://api.deepseek.com/v1/chat/completions',
  },
  {
    group: '知识库与 LLM',
    key: 'llm_model',
    label: 'LLM 模型',
    type: 'string',
    default: 'deepseek-flash',
  },
  {
    group: '知识库与 LLM',
    key: 'llm_mode',
    label: 'LLM 模式',
    type: 'string',
    enum: ['fast', 'standard', 'max'],
    default: 'max',
  },
  {
    group: '任务与限流',
    key: 'lease_seconds',
    label: '任务租约（秒）',
    type: 'integer',
    default: 900,
    min: 60,
    max: 3600,
  },
  {
    group: '任务与限流',
    key: 'max_wait_seconds',
    label: '卡片等待上限（秒）',
    type: 'integer',
    default: 300,
    min: 0,
    max: 300,
  },
  {
    group: '任务与限流',
    key: 'rate_limit_per_minute',
    label: '每分钟请求上限',
    type: 'integer',
    default: 300,
    min: 1,
    max: 100000,
  },
];

/** 把服务定义里的核心值合入现有配置文件；不删除用户已有的其它键。 */
export function mergeServiceIntoConfig(service, existing = {}) {
  const spec = service.aidash;
  const merged = { ...existing };
  merged.host = spec.host;
  merged.port = spec.port;
  merged.db_path = spec.dbPath;
  merged.backup_dir = spec.backupDir;
  merged.static_dir = spec.staticDir;
  merged.log_level = spec.logLevel;
  return merged;
}

/** 配置文件保存后，同步服务定义里用于展示/健康检查的字段。 */
export function applyConfigToService(service, raw) {
  const spec = service.aidash;
  const pickString = (key, fallback) => (raw[key] === undefined || raw[key] === null ? fallback : String(raw[key]));
  return {
    ...service,
    updatedAt: new Date().toISOString(),
    aidash: {
      ...spec,
      host: pickString('host', spec.host),
      port: Number(raw.port ?? spec.port),
      dbPath: resolvePath(pickString('db_path', spec.dbPath), service.cwd),
      backupDir: resolvePath(pickString('backup_dir', spec.backupDir), service.cwd),
      staticDir: resolvePath(pickString('static_dir', spec.staticDir), service.cwd),
      logLevel: pickString('log_level', spec.logLevel),
    },
  };
}
