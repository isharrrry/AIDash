import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Ctx } from '../../shared/types.js';
import type { AppContext } from '../context.js';
import { SERVER_VERSION } from '../http/routes/admin.js';
import { asyncHandler } from '../http/respond.js';
import type { Logger } from '../log.js';
import { registerTools } from './tools.js';

/**
 * 从一次 JSON-RPC 请求里找出它属于哪条通道。
 *
 * 优先 channel_key（绝大多数工具都带），否则用 task_id / card_id 反查：
 * 读操作（task.tree、card.get）往往只有 id，如果只认 channel_key，
 * “agent 正在翻任务树”就会被误判成通道已停止。
 *
 * 返回 null 表示这条请求不属于任何已知通道（initialize、memory.* 等），
 * 调用方不做写入——绝不能因为不知道归属就把所有通道一起刷新。
 */
function resolveChannelRef(
  ctx: AppContext,
  message: unknown,
): { id: string | null; key: string | null } | null {
  if (!message || typeof message !== 'object') return null;
  const rpc = message as { method?: unknown; params?: unknown };
  if (rpc.method !== 'tools/call') return null;
  const params = rpc.params as { arguments?: unknown } | undefined;
  const args = params?.arguments;
  if (!args || typeof args !== 'object') return null;
  const input = args as { channel_key?: unknown; task_id?: unknown; card_id?: unknown };

  if (typeof input.channel_key === 'string' && input.channel_key.trim()) {
    const key = input.channel_key.trim();
    return { id: ctx.repos.channels.findByKey(key)?.id ?? null, key };
  }
  if (typeof input.task_id === 'string' && input.task_id) {
    return { id: ctx.repos.tasks.get(input.task_id)?.channel_id ?? null, key: null };
  }
  if (typeof input.card_id === 'string' && input.card_id) {
    return { id: ctx.repos.cards.get(input.card_id)?.channel_id ?? null, key: null };
  }
  return null;
}

/** JSON-RPC 允许批量数组；逐条找，任意一条能定位到通道就记一次活动。 */
function touchChannelsForRequest(ctx: AppContext, body: unknown, log: Logger): void {
  const messages = Array.isArray(body) ? body : [body];
  const refs = new Map<string, string | null>();
  for (const message of messages) {
    const ref = resolveChannelRef(ctx, message);
    if (ref?.id) refs.set(ref.id, null);
    else if (ref?.key) refs.set(`key:${ref.key}`, ref.key);
  }
  const now = ctx.clock.now();
  for (const [token, key] of refs) {
    try {
      if (key) ctx.services.channels.touchMcpByKey(key, now);
      else ctx.services.channels.touchMcp(token, now);
    } catch (error) {
      // 活动记录失败不能影响工具本身；但必须留下日志，否则“通道一直显示离线”
      // 会变成一个没有线索的幽灵问题。
      log.warn('mcp.touch_failed', {
        channel: key ?? token,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const INSTRUCTIONS =
  '这是 AIDash 决策面板。开场先调用 digest.get 了解用户当前关心什么；' +
  '遇到歧义或破坏性操作，用 card.ask 有界等待（MCP 侧最多 25 秒，超时返回 pending + card_id，不是失败），' +
  '记下 card_id 继续做别的，稍后用 card.wait 取答案；' +
  '任务必须 task.claim 主动认领，complete 之前先发关联到该任务的 status/artifact 卡作为证据。' +
  '令牌只从 AIDASH_TOKEN 环境变量读取，永远不要把它写进卡片或日志。';

/**
 * MCP Streamable HTTP 入口。
 *
 * stateless 模式（sessionIdGenerator: undefined）要求每个请求新建 server + transport；
 * 复用实例会让并发的 initialize 互相覆盖状态。enableJsonResponse 让普通请求返回单个 JSON，
 * 而不是 SSE 流——阻塞型工具（card.ask）对这种客户端更友好。
 */
export function mcpRouter(ctx: AppContext, log: Logger): Router {
  const router = Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const server = new McpServer(
        { name: 'aidash', version: SERVER_VERSION },
        { instructions: INSTRUCTIONS },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      const controller = new AbortController();
      const mcpCtx: Ctx = {
        actorLabel: ctx.config.tokenLabel,
        requestId: String(res.locals.requestId ?? ''),
        isOwner: true,
      };
      registerTools(server, ctx, mcpCtx, controller.signal, log);

      // 客户端断开时，先让阻塞中的 card.ask 释放等待槽位，再关传输层。
      res.on('close', () => {
        controller.abort();
        void Promise.resolve(transport.close()).catch(() => undefined);
        void Promise.resolve(server.close()).catch(() => undefined);
      });

      await server.connect(transport);
      // 先记活动再执行：工具即使参数错误/被拒绝，也证明 agent 确实在这个通道上尝试操作。
      // 只记录、不影响响应，避免因为一个统计字段改变工具的错误语义。
      touchChannelsForRequest(ctx, req.body, log);
      const handling = transport.handleRequest(req, res, req.body);
      // 首次 channel.upsert / card.post 自动建通道时，执行前还查不到 id。
      // 用 0ms 定时器在工具已进入执行、通道已创建后补记一次；不阻塞响应，
      // 也不影响 card.ask 这种会等待用户决策的长请求。
      setTimeout(() => {
        // 测试/关机会在请求返回后立刻 close 数据库；这个 0ms 补记不能再碰库。
        if (!ctx.db.open) return;
        try {
          touchChannelsForRequest(ctx, req.body, log);
        } catch (error) {
          log.warn('mcp_activity_touch_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, 0);
      await handling;
    }),
  );

  // stateless 模式没有可恢复的 SSE 流，也没有会话可删；按协议返回 405。
  router.all('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'METHOD_NOT_ALLOWED' },
      id: null,
    });
  });

  return router;
}
