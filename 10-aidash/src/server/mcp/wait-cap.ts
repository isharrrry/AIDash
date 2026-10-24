/**
 * MCP 决策卡等待时长收敛。
 *
 * 为什么需要这一层：REST 允许最多等 300 秒，但 MCP 客户端（Claude Code、
 * Cursor 等）通常在 30~60 秒就判定一次工具调用超时。服务端在超时后仍会把
 * 等待继续下去并把卡片落库，于是出现“客户端报失败、网页上却多了一张卡”的
 * 假故障。把 MCP 的等待压到 25 秒，让服务端在客户端放弃之前主动返回
 * `pending + card_id`，调用方可以记下 id 继续做别的，稍后再用 card.wait 取。
 *
 * 纯函数：不读环境、不碰数据库，方便单测覆盖边界值。
 */
export function capMcpWaitSeconds(
  requested: number | undefined,
  fallback: number,
  maxWaitSeconds: number,
  capSeconds: number,
): number {
  const wanted = requested ?? fallback;
  if (!Number.isFinite(wanted)) return Math.max(0, Math.min(fallback, capSeconds));
  // 先夹到 0，再同时受服务端总上限与 MCP 专用上限约束。
  // Math.trunc 而不是 Math.round：宁可少等，也不要越过客户端超时线。
  return Math.max(0, Math.min(Math.trunc(wanted), maxWaitSeconds, capSeconds));
}
