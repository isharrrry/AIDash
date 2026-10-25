import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../../../shared/types.js';
import type { AppContext } from '../../context.js';
import type { Logger } from '../../log.js';
import { registerCardTools } from './cards.js';
import { registerChannelTools } from './channels.js';
import { registerDigestTools } from './digest.js';
import { registerHarnessTools } from './harness.js';
import { registerKbTools } from './kb.js';
import { registerMemoryTools } from './memory.js';
import { registerTaskTools } from './tasks.js';
import type { ToolDeps } from './shared.js';

/**
 * 注册 MCP-001~023。
 *
 * 为什么每个请求都新建 server/transport：SDK 的 stateless 模式不保存会话，
 * 共享实例会让并发请求互相污染 initialization 状态；新建成本只是内存对象，可以忽略。
 *
 * 领域函数的调用顺序就是工具在 tools/list 中的顺序；按原文件段落顺序聚合，
 * 避免拆分后客户端看到的工具顺序发生变化。
 */
export function registerTools(
  server: McpServer,
  ctx: AppContext,
  mcpCtx: Ctx,
  signal: AbortSignal,
  log: Logger,
): void {
  const deps: ToolDeps = { server, ctx, mcpCtx, signal, log };
  registerHarnessTools(deps);
  registerChannelTools(deps);
  registerCardTools(deps);
  registerTaskTools(deps);
  registerKbTools(deps);
  registerDigestTools(deps);
  registerMemoryTools(deps);
}
