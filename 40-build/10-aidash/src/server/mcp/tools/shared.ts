import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodError } from 'zod';
import { AppError, toAppError } from '../../../shared/errors.js';
import type { Ctx } from '../../../shared/types.js';
import type { AppContext } from '../../context.js';
import type { Logger } from '../../log.js';

/**
 * 工具注册所需的共享依赖。
 *
 * 为什么不把 server/ctx 等直接挂到模块级变量：MCP 请求是无状态的，
 * 每个请求都新建 server/transport；用参数传递才能保证并发请求之间不串上下文。
 */
export interface ToolDeps {
  server: McpServer;
  ctx: AppContext;
  mcpCtx: Ctx;
  signal: AbortSignal;
  log: Logger;
}

/** 只读/查询类工具的公共分页参数。 */
export const pageShape = {
  page: z.number().int().min(1).max(100_000).optional(),
  page_size: z.number().int().min(1).max(200).optional(),
};

/**
 * 工具结果统一信封：成功 `{ok:true,data}`，失败 `{ok:false,error}`。
 * 为什么不用 JSON-RPC 协议错误：工具级失败（比如参数不合法）属于业务结果，
 * 协议层错误会让客户端以为整个连接坏了，反而看不到可操作的错误码。
 */
export async function runTool(
  name: string,
  log: Logger,
  fn: () => unknown | Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return payloadResult(await fn());
  } catch (error) {
    let appError: AppError;
    if (error instanceof ZodError) {
      appError = new AppError('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    } else {
      appError = toAppError(error);
    }
    if (appError.code === 'INTERNAL') {
      log.error('mcp_tool_failed', {
        tool: name,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: false, error: appError.toBody() }, null, 2),
        },
      ],
    };
  }
}

function payloadResult(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, data }, null, 2),
      },
    ],
  };
}
