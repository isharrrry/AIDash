import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MANAGER_HOME, MANAGER_HOME_ENV, STATE_VERSION } from './constants.js';
import { ManagerError } from './errors.js';
import { atomicWriteFileSync, ensureDirSync, exists, randomToken, readJsonFile, writeJsonFile } from './util.js';

/**
 * 管理台本地状态。
 *
 * 目录布局（全部在 ~/.aidash/manager 下，可用 AIDASH_MANAGER_HOME 覆盖）：
 *   manager.json        服务清单（不含任何凭据）
 *   secrets.json        按服务 id 存放的 AIDASH_TOKEN（0600）
 *   web-token           本机网页访问令牌（0600）
 *   logs/<id>.log       管理台拉起进程的 stdout/stderr
 *   run/<id>.json       PID 与最近一次退出信息
 *   services/<id>/      runner 的 data_dir / 日志等默认目录
 *
 * 为什么凭据要拆文件：manager.json 是“可以给人看、可以复制排障”的清单；
 * 一旦令牌混进去，导出配置或贴到 issue 里就会泄密。拆开后权限也能分开。
 */
export class ManagerStore {
  constructor({ home, env = process.env } = {}) {
    const explicit = home || env[MANAGER_HOME_ENV] || DEFAULT_MANAGER_HOME;
    this.home = path.resolve(explicit);
    this.stateFile = path.join(this.home, 'manager.json');
    this.secretsFile = path.join(this.home, 'secrets.json');
    this.webTokenFile = path.join(this.home, 'web-token');
    this.webRuntimeFile = path.join(this.home, 'web-runtime.json');
    this.logsDir = path.join(this.home, 'logs');
    this.runDir = path.join(this.home, 'run');
    this.servicesDir = path.join(this.home, 'services');
    this._state = null;
    this._secrets = null;
  }

  init() {
    ensureDirSync(this.home, 0o700);
    ensureDirSync(this.logsDir, 0o700);
    ensureDirSync(this.runDir, 0o700);
    ensureDirSync(this.servicesDir, 0o700);
    if (!exists(this.webTokenFile)) {
      atomicWriteFileSync(this.webTokenFile, `${randomToken(32)}\n`, 0o600);
    }
    if (!exists(this.stateFile)) {
      this._state = { version: STATE_VERSION, services: [] };
      writeJsonFile(this.stateFile, this._state, 0o600);
    }
    return this;
  }

  get serviceDirRoot() {
    return this.servicesDir;
  }

  serviceDir(serviceId) {
    return path.join(this.servicesDir, serviceId);
  }

  state() {
    if (this._state) return this._state;
    if (!exists(this.stateFile)) {
      this._state = { version: STATE_VERSION, services: [] };
      return this._state;
    }
    let raw;
    try {
      raw = readJsonFile(this.stateFile);
    } catch (error) {
      throw new ManagerError(
        'STATE_INVALID',
        `管理台状态文件不是合法 JSON：${this.stateFile}（${error.message}）；请修复或备份后删除它`,
        { status: 500 },
      );
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.services)) {
      throw new ManagerError('STATE_INVALID', `管理台状态文件结构不正确：${this.stateFile}`, {
        status: 500,
      });
    }
    this._state = {
      version: STATE_VERSION,
      services: raw.services.filter((item) => item && typeof item === 'object' && item.id),
    };
    return this._state;
  }

  saveState() {
    writeJsonFile(this.stateFile, { version: STATE_VERSION, services: this.state().services }, 0o600);
  }

  listServices() {
    return [...this.state().services];
  }

  getService(idOrName) {
    const services = this.state().services;
    return (
      services.find((item) => item.id === idOrName) ??
      services.find((item) => item.name === idOrName) ??
      null
    );
  }

  requireService(idOrName) {
    const service = this.getService(idOrName);
    if (!service) {
      throw new ManagerError('SERVICE_NOT_FOUND', `服务不存在：${idOrName}`, { status: 404 });
    }
    return service;
  }

  /**
   * 创建服务时会在落盘服务记录之前写配置文件；调用方应先做唯一性检查，
   * 避免“创建失败但配置文件已留下”的半成品。addService 仍会再查一次，
   * 防止并发调用绕过预检。
   */
  assertCanAdd(service) {
    const services = this.state().services;
    if (services.some((item) => item.id === service.id)) {
      throw new ManagerError('SERVICE_EXISTS', `服务 id 已存在：${service.id}`, { status: 409 });
    }
    if (services.some((item) => item.name === service.name)) {
      throw new ManagerError('SERVICE_NAME_CONFLICT', `服务名称已存在：${service.name}`, { status: 409 });
    }
  }

  addService(service) {
    this.assertCanAdd(service);
    this.state().services.push(service);
    this.saveState();
    return service;
  }

  replaceService(service) {
    const services = this.state().services;
    const index = services.findIndex((item) => item.id === service.id);
    if (index === -1) throw new ManagerError('SERVICE_NOT_FOUND', `服务不存在：${service.id}`, { status: 404 });
    if (services.some((item) => item.id !== service.id && item.name === service.name)) {
      throw new ManagerError('SERVICE_NAME_CONFLICT', `服务名称已存在：${service.name}`, { status: 409 });
    }
    services[index] = service;
    this.saveState();
    return service;
  }

  removeService(id) {
    const state = this.state();
    const index = state.services.findIndex((item) => item.id === id);
    if (index === -1) throw new ManagerError('SERVICE_NOT_FOUND', `服务不存在：${id}`, { status: 404 });
    state.services.splice(index, 1);
    this.saveState();
    this.deleteSecret(id);
  }

  // ---------- 凭据 ----------

  secrets() {
    if (this._secrets) return this._secrets;
    if (!exists(this.secretsFile)) {
      this._secrets = { version: 1, services: {} };
      return this._secrets;
    }
    try {
      const raw = readJsonFile(this.secretsFile);
      this._secrets =
        raw && typeof raw === 'object' && raw.services && typeof raw.services === 'object'
          ? raw
          : { version: 1, services: {} };
    } catch {
      // 密钥文件损坏时不能静默当成“没有令牌”：那会让 start 报一个误导性的缺令牌错误。
      throw new ManagerError('SECRETS_INVALID', `凭据文件损坏：${this.secretsFile}`, { status: 500 });
    }
    return this._secrets;
  }

  getSecret(serviceId) {
    const entry = this.secrets().services[serviceId];
    return entry && typeof entry.token === 'string' ? entry.token : null;
  }

  setSecret(serviceId, token) {
    const secrets = this.secrets();
    if (token === null || token === undefined || token === '') delete secrets.services[serviceId];
    else secrets.services[serviceId] = { token, updated_at: new Date().toISOString() };
    writeJsonFile(this.secretsFile, secrets, 0o600);
  }

  deleteSecret(serviceId) {
    const secrets = this.secrets();
    if (!secrets.services[serviceId]) return;
    delete secrets.services[serviceId];
    writeJsonFile(this.secretsFile, secrets, 0o600);
  }

  // ---------- 网页访问令牌 ----------

  webToken() {
    try {
      return fs.readFileSync(this.webTokenFile, 'utf8').trim();
    } catch {
      const token = randomToken(32);
      atomicWriteFileSync(this.webTokenFile, `${token}\n`, 0o600);
      return token;
    }
  }

  /** 记录当前管理台 Web 的地址，供 `aidash-manager open` 找到实际端口。 */
  writeWebRuntime(value) {
    writeJsonFile(this.webRuntimeFile, value, 0o600);
  }

  readWebRuntime() {
    try {
      return readJsonFile(this.webRuntimeFile, null);
    } catch {
      return null;
    }
  }

  clearWebRuntime(pid) {
    const current = this.readWebRuntime();
    if (current && Number.isInteger(pid) && current.pid !== pid) return;
    try {
      fs.rmSync(this.webRuntimeFile, { force: true });
    } catch {
      // 清理失败不影响退出。
    }
  }

  // ---------- 运行时文件 ----------

  runFile(serviceId) {
    return path.join(this.runDir, `${serviceId}.json`);
  }

  readRunState(serviceId) {
    try {
      return readJsonFile(this.runFile(serviceId), null);
    } catch {
      return null;
    }
  }

  writeRunState(serviceId, value) {
    writeJsonFile(this.runFile(serviceId), value, 0o600);
  }

  clearRunState(serviceId) {
    try {
      fs.rmSync(this.runFile(serviceId), { force: true });
    } catch {
      // 清理失败不影响停止结果。
    }
  }

  logFile(serviceId) {
    return path.join(this.logsDir, `${serviceId}.log`);
  }

  defaultServiceDir(serviceId) {
    return path.join(this.servicesDir, serviceId);
  }
}

export function managerHomeFromEnv(env = process.env) {
  return path.resolve(env[MANAGER_HOME_ENV] || DEFAULT_MANAGER_HOME);
}

export function defaultManagerHome() {
  return path.join(os.homedir(), '.aidash', 'manager');
}
