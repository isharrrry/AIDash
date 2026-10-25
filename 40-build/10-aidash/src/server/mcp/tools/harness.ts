import { AppError } from '../../../shared/errors.js';
import { harnessHeartbeatSchema, harnessRegisterSchema } from '../../../shared/schemas.js';
import type { Harness } from '../../../shared/types.js';
import { runTool } from './shared.js';
import type { ToolDeps } from './shared.js';

/** 注册 harness 相关工具（MCP-001~002）。 */
export function registerHarnessTools({ server, ctx, mcpCtx, log }: ToolDeps): void {
  server.registerTool(
    'harness.register',
    {
      title: '注册 harness',
      description: '注册或更新当前 harness（幂等）。令牌只从环境变量读取，不要在此传密钥。',
      inputSchema: harnessRegisterSchema.shape,
    },
    async (args) =>
      runTool('harness.register', log, () => {
        const input = harnessRegisterSchema.parse(args);
        const now = ctx.clock.now();
        const row = ctx.repos.harnesses.upsert({
          harness_id: input.harness_id,
          name: input.name,
          host: input.host ?? null,
          capabilities_json: input.capabilities?.length
            ? JSON.stringify(input.capabilities)
            : null,
          now,
        });
        ctx.services.audit.record(mcpCtx, 'harness.register', 'ok', 'harness', input.harness_id);
        return toHarnessView(row);
      }),
  );

  server.registerTool(
    'harness.heartbeat',
    {
      title: '心跳',
      description: '上报 harness 存活。未注册的 harness 会返回 NOT_FOUND，请先 register。',
      inputSchema: harnessHeartbeatSchema.shape,
    },
    async (args) =>
      runTool('harness.heartbeat', log, () => {
        const input = harnessHeartbeatSchema.parse(args);
        const now = ctx.clock.now();
        if (!ctx.repos.harnesses.heartbeat(input.harness_id, now)) {
          throw new AppError('NOT_FOUND', 'HARNESS_NOT_FOUND', {
            harness_id: input.harness_id,
          });
        }
        return { harness_id: input.harness_id, at: new Date(now).toISOString() };
      }),
  );
}

function toHarnessView(row: Harness): Harness & {
  capabilities: string[];
  last_seen_at: string;
  registered_at_iso: string;
} {
  let capabilities: string[] = [];
  if (row.capabilities_json) {
    try {
      const parsed = JSON.parse(row.capabilities_json);
      if (Array.isArray(parsed)) capabilities = parsed.map(String);
    } catch {
      capabilities = [];
    }
  }
  return {
    ...row,
    capabilities,
    last_seen_at: new Date(row.last_seen).toISOString(),
    registered_at_iso: new Date(row.registered_at).toISOString(),
  };
}
