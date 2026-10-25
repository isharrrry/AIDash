import http from 'node:http';

/**
 * 真实 HTTP 的极简 AIDash MCP 替身。
 *
 * 为什么不 mock McpClient：本包最容易出错的不是“业务分支”，而是协议细节——
 * 401、isError 文本信封、SSE、分页、claim 令牌。只有走真实 HTTP + JSON-RPC，
 * 才能覆盖 fetch/响应解析/错误分类这一整条链路。
 *
 * 行为尽量贴近 10-aidash 当前实现：
 * - tools/call 成功 = content[0].text 里的 {ok:true,data}；
 * - 业务错误 = isError:true + {ok:false,error:{code,message}}；
 * - claim 需要先 harness.register；list 默认不带 description_md。
 */

const DEFAULT_TOKEN = 'fake-aidash-token-1234567890';
const OPEN_STATUSES = new Set(['pending', 'claimed', 'in_progress', 'blocked']);

let autoId = 0;

export function makeTask(overrides = {}) {
  autoId += 1;
  return {
    id: `task-${autoId}`,
    channel_key: 'it-chan',
    title: `Task ${autoId}`,
    status: 'pending',
    priority: 'P2',
    tags: ['it'],
    assignee: null,
    kind: 'task',
    due_at: null,
    defer_reason: '',
    deferred_until: null,
    description_md: `description ${autoId}`,
    claim_token: null,
    claim_expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

export class ToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class FakeAidash {
  constructor({ token = DEFAULT_TOKEN, tasks = [], includeTaskGet = false, sse = false } = {}) {
    this.token = token;
    this.includeTaskGet = includeTaskGet;
    this.sse = sse;
    this.tasks = new Map(tasks.map((task) => [task.id, { ...task }]));
    this.harnesses = new Map();
    this.channels = new Map();
    this.createdTaskSeq = 0;
    this.cards = [];
    this.calls = [];
    this.messages = [];
    this.requests = 0;
    this.unauthorized = false;
    this.failCards = false;
    this.failOnEvents = new Set();
    this.failOnRelease = false;
    this.failOnRegister = false;
    this.leaseLostOnRenew = false;
    this.claimViewOmitsDescription = false;
    this.failTools = new Map();
    this.failOnce = new Map();
    this.delayMs = 0;
    this.httpStatus = null;
    this.httpMessage = '模拟 HTTP 错误';
    // 可消费的 HTTP 失败队列：用于验证“前 N 次 429、之后成功”的重试路径。
    this.httpFailuresRemaining = 0;
    this.httpFailureStatus = 429;
    this.httpFailureMessage = '模拟 HTTP 限流';
    this.claimSeq = 0;
    this.cardSeq = 0;
    this.server = null;
    this.port = null;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        } else {
          res.end();
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this;
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  get url() {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  callsFor(name) {
    return this.calls.filter((call) => call.name === name);
  }

  task(id) {
    return this.tasks.get(id) ?? null;
  }

  addTask(task) {
    const value = { ...task };
    this.tasks.set(value.id, value);
    return value;
  }

  failNextTool(name, code = 'INTERNAL', message = '模拟工具失败', details) {
    this.failOnce.set(name, { code, message, details });
  }

  failTool(name, code = 'INTERNAL', message = '模拟工具失败', details) {
    this.failTools.set(name, { code, message, details });
  }

  clearFailTool(name) {
    this.failTools.delete(name);
    this.failOnce.delete(name);
  }

  /** 让接下来 times 个已授权请求返回指定 HTTP 状态，之后恢复正常。 */
  failHttpTimes(times, status = 429, message = '模拟 HTTP 限流') {
    this.httpFailuresRemaining = Math.max(0, Number(times) || 0);
    this.httpFailureStatus = status;
    this.httpFailureMessage = message;
  }

  async handle(req, res) {
    this.requests += 1;
    if (this.unauthorized) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'invalid token' } }));
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${this.token}`) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'invalid token' } }));
      return;
    }
    if (this.httpFailuresRemaining > 0) {
      this.httpFailuresRemaining -= 1;
      res.statusCode = this.httpFailureStatus;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: this.httpFailureMessage } }));
      return;
    }
    if (this.httpStatus) {
      res.statusCode = this.httpStatus;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: this.httpMessage } }));
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.statusCode = 400;
      res.end('bad json');
      return;
    }
    this.messages.push(body);

    // JSON-RPC 通知没有 id：初始化完成通知与其它通知一样返回 202。
    if (body.id === undefined || body.id === null) {
      res.statusCode = 202;
      res.end();
      return;
    }

    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    try {
      const result = await this.dispatch(body.method, body.params ?? {});
      this.sendRpc(res, body.id, result);
    } catch (error) {
      if (error instanceof ToolError) {
        this.sendToolError(res, body.id, error);
        return;
      }
      this.sendRpcError(res, body.id, -32603, error?.message ?? String(error));
    }
  }

  async dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: String(params.protocolVersion ?? '2025-06-18'),
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-aidash', version: '0.0.0-test' },
        };
      case 'tools/list':
        return {
          tools: [...this.toolNames()].map((name) => ({ name, description: name })),
        };
      case 'tools/call': {
        const name = String(params.name ?? '');
        const args = params.arguments ?? {};
        this.calls.push({ name, args, at: new Date().toISOString() });
        const data = await this.callTool(name, args);
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, data }, null, 2) }],
        };
      }
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  toolNames() {
    const names = [
      'harness.register',
      'harness.heartbeat',
      'channel.upsert',
      'task.create',
      'task.list',
      'task.claim',
      'task.update',
      'task.release',
      'card.post',
    ];
    if (this.includeTaskGet) names.push('task.get');
    return names;
  }

  async callTool(name, args) {
    const forcedOnce = this.failOnce.get(name);
    if (forcedOnce) {
      this.failOnce.delete(name);
      throw new ToolError(forcedOnce.code, forcedOnce.message, forcedOnce.details);
    }
    const forced = this.failTools.get(name);
    if (forced) throw new ToolError(forced.code, forced.message, forced.details);

    switch (name) {
      case 'harness.register':
        return this.harnessRegister(args);
      case 'harness.heartbeat':
        return this.harnessHeartbeat(args);
      case 'channel.upsert':
        return this.channelUpsert(args);
      case 'task.create':
        return this.taskCreate(args);
      case 'task.list':
        return this.taskList(args);
      case 'task.get':
        return this.taskGet(args);
      case 'task.claim':
        return this.taskClaim(args);
      case 'task.update':
        return this.taskUpdate(args);
      case 'task.release':
        return this.taskRelease(args);
      case 'card.post':
        return this.cardPost(args);
      default:
        throw new ToolError('METHOD_NOT_FOUND', `未知工具：${name}`);
    }
  }

  harnessRegister(args) {
    if (this.failOnRegister) throw new ToolError('INTERNAL', '模拟注册失败');
    if (!args.harness_id) throw new ToolError('INVALID_ARGUMENT', '缺少 harness_id');
    this.harnesses.set(args.harness_id, {
      harness_id: args.harness_id,
      name: args.name ?? '',
      host: args.host ?? null,
      capabilities: args.capabilities ?? [],
    });
    return { harness_id: args.harness_id, name: args.name ?? '' };
  }

  harnessHeartbeat(args) {
    if (!this.harnesses.has(args.harness_id)) {
      throw new ToolError('NOT_FOUND', 'HARNESS_NOT_FOUND', { harness_id: args.harness_id });
    }
    return { harness_id: args.harness_id, at: new Date().toISOString() };
  }

  channelUpsert(args) {
    const channelKey = String(args.channel_key ?? '').trim();
    if (!channelKey) throw new ToolError('INVALID_ARGUMENT', 'CHANNEL_KEY_REQUIRED');
    const existing = this.channels.get(channelKey);
    if (existing) {
      if (args.title) existing.title = String(args.title);
      if (args.workdir) existing.workdir = String(args.workdir);
      existing.updated_at = new Date().toISOString();
      return {
        channel_key: channelKey,
        id: existing.id,
        title: existing.title,
        workdir: existing.workdir,
        created: false,
        restored: false,
      };
    }
    const now = new Date().toISOString();
    const channel = {
      id: `ch-${this.channels.size + 1}`,
      channel_key: channelKey,
      title: args.title ? String(args.title) : null,
      workdir: args.workdir ? String(args.workdir) : null,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    this.channels.set(channelKey, channel);
    return {
      channel_key: channelKey,
      id: channel.id,
      title: channel.title,
      workdir: channel.workdir,
      created: true,
      restored: false,
    };
  }

  taskCreate(args) {
    const channelKey = String(args.channel_key ?? '').trim();
    if (!channelKey) throw new ToolError('INVALID_ARGUMENT', 'CHANNEL_KEY_REQUIRED');
    if (!args.title || !String(args.title).trim()) {
      throw new ToolError('INVALID_ARGUMENT', 'task title required');
    }
    if (!this.channels.has(channelKey)) this.channelUpsert({ channel_key: channelKey });
    if (args.idempotency_key) {
      for (const task of this.tasks.values()) {
        if (task.channel_key === channelKey && task.idempotency_key === args.idempotency_key) {
          return { task: this.view(task, true), created: false };
        }
      }
    }
    this.createdTaskSeq += 1;
    const now = new Date().toISOString();
    const task = {
      id: `task-created-${this.createdTaskSeq}`,
      channel_key: channelKey,
      title: String(args.title),
      status: args.submit === true ? 'pending' : 'draft',
      priority: args.priority ?? 'P2',
      tags: Array.isArray(args.tags) ? [...args.tags] : [],
      assignee: args.assignee ?? null,
      kind: args.kind ?? 'task',
      due_at: args.due_at ?? null,
      defer_reason: '',
      deferred_until: null,
      description_md: args.description_md ?? null,
      claim_token: null,
      claim_expires_at: null,
      idempotency_key: args.idempotency_key ?? null,
      created_at: now,
      updated_at: now,
    };
    this.tasks.set(task.id, task);
    return { task: this.view(task, true), created: true };
  }

  taskList(args) {
    const page = Number(args.page ?? 1);
    const pageSize = Math.min(200, Number(args.page_size ?? 50));
    let items = [...this.tasks.values()];
    if (args.status) {
      items = items.filter((task) => task.status === args.status);
    } else {
      items = items.filter((task) => OPEN_STATUSES.has(task.status));
    }
    if (args.channel_key) items = items.filter((task) => task.channel_key === args.channel_key);
    if (args.assignee) items = items.filter((task) => task.assignee === args.assignee);
    const total = items.length;
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);
    return {
      items: pageItems.map((task) => this.view(task, args.include_description === true)),
      total,
      page,
      page_size: pageSize,
      has_more: start + pageSize < total,
    };
  }

  taskGet(args) {
    const task = this.tasks.get(args.task_id);
    if (!task) throw new ToolError('NOT_FOUND', 'TASK_NOT_FOUND');
    return this.view(task, true);
  }

  taskClaim(args) {
    const task = this.tasks.get(args.task_id);
    if (!task) throw new ToolError('NOT_FOUND', 'TASK_NOT_FOUND', { task_id: args.task_id });
    if (!this.harnesses.has(args.harness_id)) {
      throw new ToolError('INVALID_ARGUMENT', 'HARNESS_NOT_REGISTERED', { harness_id: args.harness_id });
    }
    if (task.assignee && task.assignee !== args.harness_id) {
      throw new ToolError('FORBIDDEN', 'TASK_ASSIGNED_TO_OTHER');
    }
    if (task.claim_token) {
      if (task.claim_token !== args.claim_token) {
        throw new ToolError('ALREADY_CLAIMED', 'TASK_ALREADY_CLAIMED');
      }
      if (this.leaseLostOnRenew) {
        throw new ToolError('ALREADY_CLAIMED', 'LEASE_LOST（模拟租约被接管）');
      }
      task.claim_expires_at = new Date(Date.now() + 60_000).toISOString();
      return {
        task: this.view(task, !this.claimViewOmitsDescription),
        claim_token: task.claim_token,
        lease_expires_at: task.claim_expires_at,
        renewed: true,
      };
    }
    if (task.status !== 'pending') {
      throw new ToolError('INVALID_ARGUMENT', `TASK_NOT_PENDING（当前 ${task.status}）`);
    }
    this.claimSeq += 1;
    task.claim_token = args.claim_token || `claim-token-${this.claimSeq}-abcdef`;
    task.claim_expires_at = new Date(Date.now() + 60_000).toISOString();
    task.status = 'claimed';
    return {
      task: this.view(task, !this.claimViewOmitsDescription),
      claim_token: task.claim_token,
      lease_expires_at: task.claim_expires_at,
      renewed: false,
    };
  }

  taskUpdate(args) {
    const task = this.tasks.get(args.task_id);
    if (!task) throw new ToolError('NOT_FOUND', 'TASK_NOT_FOUND');
    if (!task.claim_token || task.claim_token !== args.claim_token) {
      throw new ToolError('CONFLICT', 'CLAIM_TOKEN_MISMATCH');
    }
    const event = String(args.event ?? '');
    if (this.failOnEvents.has(event)) {
      throw new ToolError('INTERNAL', `模拟 ${event} 失败`);
    }
    switch (event) {
      case 'submit':
        if (task.status === 'draft') task.status = 'pending';
        break;
      case 'start':
        task.status = 'in_progress';
        break;
      case 'complete':
        if (!Array.isArray(args.evidence_card_ids) || args.evidence_card_ids.length === 0) {
          throw new ToolError('INVALID_ARGUMENT', 'EVIDENCE_REQUIRED');
        }
        task.status = 'done';
        task.claim_token = null;
        break;
      case 'fail':
        task.status = 'failed';
        task.claim_token = null;
        break;
      case 'block':
        task.status = 'blocked';
        break;
      default:
        throw new ToolError('INVALID_ARGUMENT', `未知事件 ${event}`);
    }
    task.updated_at = new Date().toISOString();
    return this.view(task, true);
  }

  taskRelease(args) {
    const task = this.tasks.get(args.task_id);
    if (!task) throw new ToolError('NOT_FOUND', 'TASK_NOT_FOUND');
    if (this.failOnRelease) throw new ToolError('INTERNAL', '模拟 release 失败');
    if (!task.claim_token || task.claim_token !== args.claim_token) {
      throw new ToolError('CONFLICT', 'CLAIM_TOKEN_MISMATCH');
    }
    if (!['claimed', 'in_progress', 'blocked'].includes(task.status)) {
      throw new ToolError('CONFLICT', `TASK_NOT_RELEASABLE（${task.status}）`);
    }
    task.status = 'pending';
    task.claim_token = null;
    task.claim_expires_at = null;
    task.updated_at = new Date().toISOString();
    return { task_id: task.id, released: true };
  }

  cardPost(args) {
    if (this.failCards) throw new ToolError('INTERNAL', '模拟证据卡发送失败');
    if (args.type === 'status') {
      if (!args.task_id) throw new ToolError('INVALID_ARGUMENT', 'status requires task_id');
      if (!args.summary || !String(args.summary).trim()) {
        throw new ToolError('INVALID_ARGUMENT', 'status requires summary');
      }
      if (!['success', 'failed', 'blocked', 'partial'].includes(args.result)) {
        throw new ToolError('INVALID_ARGUMENT', 'status requires result in success/failed/blocked/partial');
      }
      if (args.body_md != null) {
        throw new ToolError('INVALID_ARGUMENT', 'status 卡不支持 body_md，正文请用 detail_md');
      }
    }
    this.cardSeq += 1;
    const card = { id: `card-${this.cardSeq}`, ...args };
    this.cards.push(card);
    return card;
  }

  view(task, includeDescription) {
    return {
      id: task.id,
      channel_key: task.channel_key,
      title: task.title,
      status: task.status,
      priority: task.priority,
      tags: [...(task.tags ?? [])],
      assignee: task.assignee ?? null,
      kind: task.kind ?? 'task',
      due_at: task.due_at ?? null,
      defer_reason: task.defer_reason ?? '',
      deferred_until: task.deferred_until ?? null,
      description_md: includeDescription ? task.description_md ?? null : null,
      claim_expires_at: task.claim_expires_at ?? null,
      created_at: task.created_at ?? null,
      updated_at: task.updated_at ?? null,
    };
  }

  sendRpc(res, id, result) {
    this.sendJsonRpc(res, { jsonrpc: '2.0', id, result });
  }

  sendRpcError(res, id, code, message) {
    this.sendJsonRpc(res, { jsonrpc: '2.0', id, error: { code, message } });
  }

  sendToolError(res, id, error) {
    const payload = {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            },
          }),
        },
      ],
    };
    this.sendJsonRpc(res, { jsonrpc: '2.0', id, result: payload });
  }

  sendJsonRpc(res, message) {
    if (this.sse) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(message));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
