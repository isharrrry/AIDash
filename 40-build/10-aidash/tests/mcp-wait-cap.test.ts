import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { capMcpWaitSeconds } from '../src/server/mcp/wait-cap.js';

describe('MCP 决策卡等待上限', () => {
  it('把 300 秒压到 MCP 专用上限，避免客户端先判超时', () => {
    expect(capMcpWaitSeconds(300, 90, 300, 25)).toBe(25);
  });

  it('小于上限时保留调用方要求的时长', () => {
    expect(capMcpWaitSeconds(10, 90, 300, 25)).toBe(10);
  });

  it('未传 wait_seconds 时用默认值，但仍受上限约束', () => {
    expect(capMcpWaitSeconds(undefined, 90, 300, 25)).toBe(25);
    expect(capMcpWaitSeconds(undefined, 5, 300, 25)).toBe(5);
  });

  it('负数夹到 0，表示立即返回 pending', () => {
    expect(capMcpWaitSeconds(-5, 90, 300, 25)).toBe(0);
  });

  it('同时受服务端总上限约束，min 取两者更小值', () => {
    expect(capMcpWaitSeconds(300, 90, 10, 25)).toBe(10);
  });

  it('小数向下取整，宁可少等也不越过客户端超时线', () => {
    expect(capMcpWaitSeconds(24.9, 90, 300, 25)).toBe(24);
  });

  it('配置默认值是 25 秒，可用环境变量调整', () => {
    const base = loadConfig({ AIDASH_TOKEN: 'test-token' });
    expect(base.mcpWaitCapSeconds).toBe(25);

    const custom = loadConfig({
      AIDASH_TOKEN: 'test-token',
      AIDASH_MCP_WAIT_CAP_SECONDS: '15',
    });
    expect(custom.mcpWaitCapSeconds).toBe(15);
  });
});
