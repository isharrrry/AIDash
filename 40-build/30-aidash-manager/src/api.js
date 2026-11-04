import fs from 'node:fs';
import path from 'node:path';
import { aidashDataLayout, VERSION } from './constants.js';
import { ManagerError, toManagerError } from './errors.js';
import {
  AIDASH_CORE_FIELDS,
  applyConfigToService,
  mergeServiceIntoConfig,
  readAidashConfigFile,
  writeAidashConfigFile,
} from './aidash-config.js';
import {
  RUNNER_CORE_FIELDS,
  applyRunnerConfigToService,
  buildRunnerConfig,
  readRunnerConfigFile,
  writeRunnerConfigFile,
} from './runner-config.js';
import { templateSummaries, getTemplate } from './templates.js';
import {
  assertRunnerConfigPathUnused,
  assertRunnerDataDirUnused,
  createService,
  detectAidashLayout,
  detectRunnerEntry,
  effectiveAidashSettings,
  effectiveRunnerSettings,
  findAidashProgram,
  publicService,
  updateService,
} from './service.js';
import {
  checkPortAvailable,
  getServiceErrors,
  getServiceLogs,
  getServiceRuntime,
  restartService,
  serviceLogFiles,
  serviceWebUrl,
  startAidash,
  startRunner,
  stopAidash,
  stopRunner,
} from './process.js';
import { exists, isDirectory, resolvePath, safeEqual, truncate } from './util.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function createApiContext({ store, host, port, startedAt }) {
  return { store, host, port, startedAt: startedAt ?? new Date().toISOString() };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function ok(res, data, status = 200) {
  json(res, status, { ok: true, data });
}

export function fail(res, error) {
  const normalized = toManagerError(error);
  json(res, normalized.status, {
    ok: false,
    error: { code: normalized.code, message: normalized.message, details: normalized.details ?? null },
  });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(reject, new ManagerError('BODY_TOO_LARGE', '请求体超过 4MB 上限', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => finish(reject, error));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return finish(resolve, {});
      try {
        const parsed = JSON.parse(text);
        finish(resolve, parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        finish(reject, new ManagerError('BODY_INVALID', '请求体不是合法 JSON'));
      }
    });
  });
}

function hasToken(store, service) {
  const spec = service.type === 'aidash' ? service.aidash : service.runner;
  if (spec.tokenSource === 'env') return Boolean(process.env[spec.tokenEnv]);
  return Boolean(store.getSecret(service.id));
}

async function serviceView(store, service, { includeRuntime = true } = {}) {
  const pub = publicService(service, { hasToken: hasToken(store, service) });
  let runtime = null;
  if (includeRuntime) {
    runtime = await getServiceRuntime(store, service);
  }
  return {
    ...pub,
    runtime,
    web_url: serviceWebUrl(store, service),
    log_files: serviceLogFiles(store, service),
  };
}

export async function handleApi(req, res, url, ctx) {
  const { store } = ctx;
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (parts[0] !== 'api') return false;

  try {
    if (parts.length === 2 && parts[1] === 'state' && method === 'GET') {
      const services = store.listServices();
      const views = await Promise.all(services.map((service) => serviceView(store, service)));
      ok(res, {
        manager: {
          version: VERSION,
          home: store.home,
          host: ctx.host,
          port: ctx.port,
          started_at: ctx.startedAt,
          uptime_ms: Date.now() - Date.parse(ctx.startedAt),
          node: process.version,
          platform: process.platform,
        },
        services: views,
        templates: templateSummaries(),
      });
      return true;
    }

    if (parts.length === 2 && parts[1] === 'templates' && method === 'GET') {
      ok(res, templateSummaries());
      return true;
    }

    if (parts.length === 2 && parts[1] === 'ports' && method === 'GET') {
      // 新建向导的“端口探测”：只监听一下再关闭，不占用端口。
      const host = (url.searchParams.get('host') || '127.0.0.1').trim();
      const port = Number(url.searchParams.get('port'));
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ManagerError('PORT_INVALID', '端口必须是 1..65535 的整数', { status: 400 });
      }
      const result = await checkPortAvailable(host, port);
      ok(res, { host, port, available: result.ok, reason: result.ok ? null : result.reason });
      return true;
    }

    if (parts.length === 2 && parts[1] === 'discover' && method === 'GET') {
      const cwd = resolvePath(url.searchParams.get('cwd') || '.');
      const appDir = resolvePath(url.searchParams.get('appDir') || '');
      const layout = detectAidashLayout(cwd);
      const runner = detectRunnerEntry(cwd);
      // 程序探测独立于工作目录：工作目录只决定数据（库/备份/配置）放哪。
      const program = findAidashProgram({ appDir, cwd, store });
      const data = layout.matched ? layout : aidashDataLayout(cwd);
      const files = [];
      try {
        for (const name of fs.readdirSync(cwd)) {
          if (name === 'aidash.config.json' || /^aidash-runner.*\.json$/.test(name)) {
            files.push(path.join(cwd, name));
          }
        }
      } catch {
        // 目录不存在或不可读时由 exists=false 告知。
      }
      ok(res, {
        cwd,
        exists: isDirectory(cwd),
        aidash_layout: layout,
        aidash_program: program,
        aidash_data: { key: data.key, dbPath: data.dbPath, backupDir: data.backupDir },
        aidash_entry_exists: exists(program.serverEntry),
        runner_entry: runner,
        existing_files: files.sort(),
      });
      return true;
    }

    if (parts.length === 2 && parts[1] === 'services') {
      if (method === 'GET') {
        const services = store.listServices();
        const views = await Promise.all(services.map((service) => serviceView(store, service)));
        ok(res, views);
        return true;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const service = await createServiceWithFiles(store, body);
        ok(res, await serviceView(store, service), 201);
        return true;
      }
    }

    if (parts.length >= 3 && parts[1] === 'services') {
      const id = decodeURIComponent(parts[2]);
      const service = store.requireService(id);
      const action = parts[3];
      if (parts.length === 3) {
        if (method === 'GET') {
          ok(res, await serviceView(store, service));
          return true;
        }
        if (method === 'PUT') {
          const body = await readBody(req);
          const next = updateService(service, body, { store });
          store.replaceService(next);
          if (body.token !== undefined) setServiceToken(store, next, body.token);
          ok(res, await serviceView(store, next));
          return true;
        }
        if (method === 'DELETE') {
          const force = url.searchParams.get('force') === 'true';
          const runtime = await getServiceRuntime(store, service);
          // 外部进程不是管理台拉起的：删除只能移除登记，不能也不该尝试停止它。
          // 这条路径必须允许删除，否则“只读登记”的服务会永远留在列表里。
          if (runtime.state === 'external') {
            store.removeService(service.id);
            ok(res, { removed: service.id, name: service.name, external: true });
            return true;
          }
          if (['running', 'starting', 'unresponsive'].includes(runtime.state)) {
            if (!force) {
              throw new ManagerError(
                'SERVICE_RUNNING',
                `${service.name} 正在运行；先停止，或在删除时勾选强制停止`,
                { status: 409 },
              );
            }
            await stopForDelete(store, service);
          }
          store.removeService(service.id);
          ok(res, { removed: service.id, name: service.name });
          return true;
        }
      }

      if (action === 'start' && method === 'POST') {
        const runtime = service.type === 'aidash' ? await startAidash(store, service) : await startRunner(store, service);
        // 启动时可能修复旧记录的程序/数据路径；响应要反映回写后的服务定义。
        ok(res, { service: await serviceView(store, store.getService(service.id) ?? service), runtime });
        return true;
      }
      if (action === 'stop' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const force = body.force === true;
        const runtime = service.type === 'aidash' ? await stopAidash(store, service, { force }) : await stopRunner(store, service, { force });
        ok(res, { service: await serviceView(store, service), runtime });
        return true;
      }
      if (action === 'restart' && method === 'POST') {
        const runtime = await restartService(store, service);
        ok(res, { service: await serviceView(store, store.getService(service.id) ?? service), runtime });
        return true;
      }
      if (action === 'logs' && method === 'GET') {
        const lines = Number(url.searchParams.get('lines') ?? 200);
        const source = url.searchParams.get('source') ?? 'auto';
        ok(res, getServiceLogs(store, service, { source, lines }));
        return true;
      }
      if (action === 'errors' && method === 'GET') {
        ok(res, getServiceErrors(store, service));
        return true;
      }
      if (action === 'open' && method === 'POST') {
        ok(res, { url: serviceWebUrl(store, service) });
        return true;
      }
      if (action === 'token') {
        if (method === 'POST' || method === 'PUT') {
          const body = await readBody(req);
          setServiceToken(store, service, body.token);
          ok(res, { has_token: true });
          return true;
        }
        if (method === 'DELETE') {
          store.deleteSecret(service.id);
          ok(res, { has_token: false });
          return true;
        }
      }
      if (action === 'config') {
        const sub = parts[4];
        if (method === 'GET' && !sub) {
          ok(res, service.type === 'aidash' ? readAidashConfigView(store, service) : readRunnerConfigView(store, service));
          return true;
        }
        if (method === 'PUT' && !sub) {
          const body = await readBody(req);
          ok(
            res,
            service.type === 'aidash'
              ? await saveAidashConfig(store, service, body)
              : await saveRunnerConfig(store, service, body),
          );
          return true;
        }
        if (method === 'POST' && sub === 'template') {
          const body = await readBody(req);
          ok(res, await applyRunnerTemplate(store, service, body));
          return true;
        }
      }
    }

    throw new ManagerError('NOT_FOUND', `未知 API：${method} ${url.pathname}`, { status: 404 });
  } catch (error) {
    fail(res, error);
    return true;
  }
}

function validateTokenValue(token) {
  if (typeof token !== 'string') throw new ManagerError('TOKEN_INVALID', '令牌必须是字符串');
  const value = token.trim();
  if (!value) throw new ManagerError('TOKEN_INVALID', '令牌不能为空');
  if (/\s/.test(value)) throw new ManagerError('TOKEN_INVALID', '令牌不能包含空白字符');
  if (value.length > 4_096) throw new ManagerError('TOKEN_INVALID', '令牌长度超过 4096');
  return value;
}

function setServiceToken(store, service, token) {
  if (token === undefined) return;
  if (token === null || token === '') {
    store.deleteSecret(service.id);
    return;
  }
  store.setSecret(service.id, validateTokenValue(token));
}

function assertTokenForCreate(service, token) {
  const spec = service.type === 'aidash' ? service.aidash : service.runner;
  if (spec.tokenSource === 'env') return;
  if (typeof token !== 'string' || !token.trim()) {
    throw new ManagerError('TOKEN_REQUIRED', 'AIDASH_TOKEN 必填；请填写服务访问凭据（只保存在本机 0600 文件中）');
  }
  validateTokenValue(token);
}

export async function createServiceWithFiles(store, body) {
  const token = body.token;
  const service = createService(body, { store });
  assertTokenForCreate(service, token);
  // 先确认名字/id 可用，再写任何文件：否则重名失败会留下一个没人引用的配置文件。
  store.assertCanAdd(service);

  let runnerConfigWritten = false;
  let aidashConfigWritten = false;
  try {
    if (service.type === 'runner') {
      const file = service.runner.configPath;
      const fileState = readRunnerConfigFile(file);
      if (fileState.exists) {
        if (body.useExistingConfig) {
          if (fileState.errors.length > 0) {
            throw new ManagerError('CONFIG_INVALID', '现有 runner 配置校验未通过', {
              details: { errors: fileState.errors },
            });
          }
          const existingHarness = String(fileState.raw.harness_id ?? '');
          const conflict = store
            .listServices()
            .find((item) => item.type === 'runner' && item.runner?.harnessId === existingHarness);
          if (conflict) {
            throw new ManagerError(
              'HARNESS_ID_CONFLICT',
              `现有配置的 harness_id 已被服务 ${conflict.name} 使用：${existingHarness}`,
              { status: 409 },
            );
          }
          const adopted = applyRunnerConfigToService(service, fileState.raw);
          Object.assign(service, adopted);
          // 复用的配置可能把 data_dir 指到另一个服务的目录；这里补一次隔离检查。
          assertRunnerConfigPathUnused(store, service.runner.configPath, service.id);
          assertRunnerDataDirUnused(store, service.runner.dataDir, service.id);
        } else {
          throw new ManagerError(
            'CONFIG_EXISTS',
            `runner 配置文件已存在：${file}；请勾选“复用现有配置”，或换一个配置路径`,
            { status: 409 },
          );
        }
      } else {
        // 文件不存在也要防两个服务登记同一路径：第一个服务创建后文件被删除时，
        // 第二个服务不能静默接管同一个配置路径。
        assertRunnerConfigPathUnused(store, file, service.id);
        const config = buildRunnerConfig(service);
        writeRunnerConfigFile(file, config);
        runnerConfigWritten = true;
      }
    } else if (service.aidash.configMode === 'file' && !exists(service.aidash.configPath)) {
      writeAidashConfigFile(service.aidash.configPath, mergeServiceIntoConfig(service, {}));
      aidashConfigWritten = true;
    }
    store.addService(service);
    if (service.type === 'aidash' || service.type === 'runner') {
      if (token) setServiceToken(store, service, token);
    }
    return store.requireService(service.id);
  } catch (error) {
    if (runnerConfigWritten) {
      try {
        fs.rmSync(service.runner.configPath, { force: true });
      } catch {
        // 回滚失败不影响主错误。
      }
    }
    if (aidashConfigWritten) {
      try {
        fs.rmSync(service.aidash.configPath, { force: true });
      } catch {
        // 回滚失败不影响主错误。
      }
    }
    throw error;
  }
}

async function stopForDelete(store, service) {
  try {
    if (service.type === 'aidash') await stopAidash(store, service, { force: true });
    else await stopRunner(store, service, { force: true });
  } catch (error) {
    throw new ManagerError('STOP_BEFORE_DELETE_FAILED', `删除前停止服务失败：${error.message}`, { status: 500 });
  }
}

function readAidashConfigView(store, service) {
  const spec = service.aidash;
  const file = readAidashConfigFile(spec.configPath);
  const effective = effectiveAidashSettings(service);
  return {
    type: 'aidash',
    mode: spec.configMode,
    config_path: spec.configPath,
    file: {
      exists: file.exists,
      raw: file.raw,
      text: file.text,
      errors: file.errors,
    },
    effective,
    fields: AIDASH_CORE_FIELDS,
    env_values: {
      host: spec.host,
      port: spec.port,
      db_path: spec.dbPath,
      backup_dir: spec.backupDir,
      static_dir: spec.staticDir,
      log_level: spec.logLevel,
    },
    notes: [
      '环境变量优先于配置文件：文件模式下管理台不会向子进程注入 AIDASH_HOST/PORT/DB_PATH 等同名变量。',
      'AIDASH_TOKEN 永远只从环境变量读取，不会写进配置文件。',
    ],
  };
}

function parseRawConfig(body) {
  if (body.raw_text !== undefined) {
    if (typeof body.raw_text !== 'string') throw new ManagerError('CONFIG_INVALID', 'raw_text 必须是字符串');
    try {
      return JSON.parse(body.raw_text);
    } catch (error) {
      throw new ManagerError('CONFIG_INVALID', `JSON 解析失败：${error.message}`);
    }
  }
  if (body.config !== undefined) {
    if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
      throw new ManagerError('CONFIG_INVALID', 'config 必须是 JSON 对象');
    }
    return body.config;
  }
  return null;
}

async function saveAidashConfig(store, service, body) {
  const spec = { ...service.aidash };
  if (body.configPath !== undefined) {
    const nextPath = resolvePath(String(body.configPath).trim(), service.cwd);
    if (!nextPath) throw new ManagerError('CONFIG_INVALID', '配置文件路径不能为空');
    spec.configPath = nextPath;
  }
  const mode = body.mode ?? spec.configMode;
  if (mode !== 'env' && mode !== 'file') throw new ManagerError('CONFIG_INVALID', 'mode 只能是 env 或 file');
  spec.configMode = mode;
  const parsed = parseRawConfig(body);

  if (parsed) {
    writeAidashConfigFile(spec.configPath, parsed);
  } else if (mode === 'file' && !exists(spec.configPath)) {
    const merged = mergeServiceIntoConfig({ ...service, aidash: spec }, {});
    writeAidashConfigFile(spec.configPath, merged);
  }

  let next = { ...service, aidash: spec, updatedAt: new Date().toISOString() };
  if (spec.configMode === 'file' && exists(spec.configPath)) {
    const file = readAidashConfigFile(spec.configPath);
    if (file.errors.length > 0) {
      throw new ManagerError('CONFIG_INVALID', '配置文件校验未通过', { details: { errors: file.errors } });
    }
    if (file.raw) next = applyConfigToService(next, file.raw);
  }
  store.replaceService(next);
  return {
    service: await serviceView(store, next),
    config: readAidashConfigView(store, next),
  };
}

function readRunnerConfigView(store, service) {
  const spec = service.runner;
  const file = readRunnerConfigFile(spec.configPath);
  const effective = effectiveRunnerSettings(service);
  return {
    type: 'runner',
    config_path: spec.configPath,
    file: { exists: file.exists, raw: file.raw, text: file.text, errors: file.errors, warnings: file.warnings },
    effective,
    fields: RUNNER_CORE_FIELDS,
    template: spec.template,
    template_detail: getTemplate(spec.template),
    templates: templateSummaries(),
    runner_entry: detectRunnerEntry(service.cwd, spec.runnerEntry),
    env_values: {
      data_dir: spec.dataDir,
      log_file: spec.logFile,
      run_cwd: spec.runCwd,
    },
  };
}

/** 改配置/换模板前的资源隔离检查：不能接管其它 runner 的配置文件或 data_dir。 */
function assertRunnerConfigResources(store, service, configPath, raw) {
  assertRunnerConfigPathUnused(store, configPath, service.id);
  const dataDir = raw?.data_dir;
  if (typeof dataDir === 'string' && dataDir.trim()) {
    assertRunnerDataDirUnused(store, resolvePath(dataDir, path.dirname(configPath)), service.id);
  }
}

async function saveRunnerConfig(store, service, body) {
  const spec = service.runner;
  let configPath = spec.configPath;
  if (body.configPath !== undefined) {
    const nextPath = resolvePath(String(body.configPath).trim(), service.cwd);
    if (!nextPath) throw new ManagerError('CONFIG_INVALID', '配置文件路径不能为空');
    configPath = nextPath;
  }
  const parsed = parseRawConfig(body);
  if (!parsed) throw new ManagerError('CONFIG_INVALID', '缺少 config 或 raw_text');
  if (configPath !== spec.configPath) {
    if (!service.runner.configPath || !exists(spec.configPath)) {
      // 原文件不存在时直接写新路径。
    } else if (exists(configPath) && !body.overwrite) {
      throw new ManagerError('CONFIG_EXISTS', `目标配置文件已存在：${configPath}`, { status: 409 });
    }
  }
  assertRunnerConfigResources(store, service, configPath, parsed);
  const result = writeRunnerConfigFile(configPath, parsed);
  const withPath = {
    ...service,
    runner: { ...spec, configPath },
  };
  const next = applyRunnerConfigToService(withPath, result.raw);
  store.replaceService(next);
  return {
    service: await serviceView(store, next),
    config: readRunnerConfigView(store, next),
    warnings: result.warnings,
  };
}

async function applyRunnerTemplate(store, service, body) {
  const templateKey = String(body.templateKey ?? body.template ?? '').trim();
  if (!getTemplate(templateKey)) throw new ManagerError('TEMPLATE_UNKNOWN', `未知 harness 模板：${templateKey}`);
  const current = readRunnerConfigFile(service.runner.configPath);
  const base = buildRunnerConfig(
    { ...service, runner: { ...service.runner, template: templateKey } },
    { templateKey },
  );
  const nextRaw = {
    ...base,
    ...(current.raw && typeof current.raw === 'object' ? current.raw : {}),
    capabilities: base.capabilities,
    commands: base.commands,
  };
  assertRunnerConfigResources(store, service, service.runner.configPath, nextRaw);
  const result = writeRunnerConfigFile(service.runner.configPath, nextRaw);
  const next = applyRunnerConfigToService(
    { ...service, runner: { ...service.runner, template: templateKey } },
    result.raw,
  );
  store.replaceService(next);
  return {
    service: await serviceView(store, next),
    config: readRunnerConfigView(store, next),
    warnings: result.warnings,
  };
}

/** 供 CLI 复用的辅助：只读摘要（不触发长时间控制面查询）。 */
export async function listServiceSummaries(store) {
  const services = store.listServices();
  return Promise.all(
    services.map(async (service) => {
      const runtime = await getServiceRuntime(store, service);
      return {
        id: service.id,
        name: service.name,
        type: service.type,
        cwd: service.cwd,
        state: runtime.state,
        pid: runtime.pid,
        url: runtime.url ?? serviceWebUrl(store, service),
        detail: truncate(runtime.detail, 200),
        config_path: service.type === 'aidash' ? service.aidash.configPath : service.runner.configPath,
        log_file: runtime.log_file,
        instance_id: runtime.instance_id ?? null,
        config_error: runtime.config_error ?? null,
      };
    }),
  );
}

export function verifyManagerToken(provided, expected) {
  return safeEqual(provided, expected);
}
