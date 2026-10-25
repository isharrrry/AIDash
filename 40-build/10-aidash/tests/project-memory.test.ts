import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  createHarness,
  mcp,
  mcpToolData,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';
import { MAX_MEMORY_CHARS, MAX_MEMORY_LINE_CHARS } from '../src/shared/constants.js';
import { memoryAppendSchema, memorySearchSchema } from '../src/shared/schemas.js';

// 只由 vitest 收集：验证主通道记忆的追加/搜索/整体编辑、版本冲突与 REST/MCP 入口。
// 全部用内存库与临时端口，不碰真实 8787。
const PROJECT = 'devhost/memory-fixture';

let harness: TestHarness | null = null;
let app: RunningApp | null = null;

async function boot(): Promise<{ h: TestHarness; a: RunningApp }> {
  harness = createHarness();
  app = await startApp(harness);
  return { h: harness, a: app };
}

afterEach(async () => {
  if (app) await app.close();
  harness?.close();
  app = null;
  harness = null;
});

/** 服务层直接调用时也要走一遍 schema：默认值（dedupe/limit）由 schema 补。 */
function appendInput(lines: string[], overrides: Record<string, unknown> = {}) {
  return memoryAppendSchema.parse({ project: PROJECT, lines, ...overrides });
}

describe('主通道记忆：服务层', () => {
  it('未写入时返回空记忆，而不是 404', () => {
    const h = createHarness();
    try {
      const view = h.ctx.services.memory.get(PROJECT);
      expect(view).toMatchObject({
        project: PROJECT,
        content_md: '',
        version: 0,
        exists: false,
        line_count: 0,
        updated_by: null,
      });
      expect(view.created_at).toBeNull();
      expect(view.updated_at).toBeNull();
    } finally {
      h.close();
    }
  });

  it('追加行：去重、跳过空行、保留顺序并递增版本', () => {
    const h = createHarness();
    try {
      const first = h.ctx.services.memory.append(
        appendInput([
          '- [2026-10-24] [deploy] 发布前先备份 db',
          '   ',
          '- [2026-10-24] [deploy] 发布前先备份 db',
        ]),
        testCtx(),
      );
      expect(first).toMatchObject({
        appended: 1,
        skipped_duplicates: 1,
        skipped_blank: 1,
        version: 1,
        line_count: 1,
        unchanged: false,
      });

      // 同一行（哪怕行首缩进不同）再次追加应整体判为“早就记过”，版本不涨。
      const repeated = h.ctx.services.memory.append(
        appendInput(['  - [2026-10-24] [deploy] 发布前先备份 db']),
        testCtx(),
      );
      expect(repeated).toMatchObject({ appended: 0, skipped_duplicates: 1, unchanged: true });
      expect(repeated.version).toBe(1);

      const second = h.ctx.services.memory.append(
        appendInput(['- [auth] 网关白名单未放行时登录会 500', '- [ui] 决策卡用模态框展示']),
        testCtx(),
      );
      expect(second).toMatchObject({ appended: 2, version: 2, line_count: 3 });

      const view = h.ctx.services.memory.get(PROJECT);
      expect(view.content_md).toBe(
        [
          '- [2026-10-24] [deploy] 发布前先备份 db',
          '- [auth] 网关白名单未放行时登录会 500',
          '- [ui] 决策卡用模态框展示',
        ].join('\n'),
      );
      expect(view.updated_by).toBe('tester');
    } finally {
      h.close();
    }
  });

  it('追加行：全空白、敏感模式与超上限都被拒绝，且不落库', () => {
    const h = createHarness();
    try {
      // schema 允许“只有空格”的行通过（min(1)），归一化后全空才由服务层拒绝。
      expect(() => h.ctx.services.memory.append(appendInput(['   ', '  ']), testCtx())).toThrow(
        /MEMORY_APPEND_EMPTY/,
      );

      // 记忆和卡片一样不能成为令牌的落脚点；错误里只暴露模式名，不回显原文。
      expect(() =>
        h.ctx.services.memory.append(
          appendInput(['token: abcdefghijklmnopqrstuvwxyz']),
          testCtx(),
        ),
      ).toThrow(/SENSITIVE_PATTERN_DETECTED/);

      // 40 行 × 约 2000 字符 = 约 80,000 字符，超过整篇 64,000 上限。
      const huge = Array.from({ length: 40 }, (_, index) => `L${index} ` + 'x'.repeat(1990));
      expect(() => h.ctx.services.memory.append(appendInput(huge), testCtx())).toThrow(
        /MEMORY_TOO_LARGE/,
      );

      expect(h.ctx.services.memory.get(PROJECT).exists).toBe(false);
    } finally {
      h.close();
    }
  });

  it('按 key 搜索：大小写不敏感、1 基行号、limit 截断与超长行截断', () => {
    const h = createHarness();
    try {
      h.ctx.services.memory.append(
        appendInput(['- [AUTH] 白名单', '- [deploy] 先备份', '- [auth] 登录 500']),
        testCtx(),
      );

      const hit = h.ctx.services.memory.search(
        memorySearchSchema.parse({ project: PROJECT, query: 'auth' }),
      );
      expect(hit).toMatchObject({ project: PROJECT, version: 1, total: 2, truncated: false });
      expect(hit.matches.map((match) => match.line_no)).toEqual([1, 3]);
      expect(hit.matches[0]?.line).toContain('[AUTH]');

      const limited = h.ctx.services.memory.search(
        memorySearchSchema.parse({ project: PROJECT, query: '[', limit: 2 }),
      );
      // 3 行都带 "[key]"；只回 2 行，但 total 仍是真实的 3。
      expect(limited.total).toBe(3);
      expect(limited.matches).toHaveLength(2);
      expect(limited.truncated).toBe(true);

      // 追加入口单行上限是 2000 字符，超长行只能来自整体编辑；搜索侧仍要防它撑爆响应。
      h.ctx.services.memory.replace(
        { project: PROJECT, content_md: 'LONG ' + 'y'.repeat(2495), expected_version: 1 },
        testCtx(),
      );
      const longHit = h.ctx.services.memory.search(
        memorySearchSchema.parse({ project: PROJECT, query: 'LONG' }),
      );
      // 单行超过 2000 字符时截断并加省略号，避免一次搜索把上下文撑爆。
      expect(longHit.matches[0]?.line.endsWith('…')).toBe(true);
      expect(longHit.matches[0]?.line.length).toBe(MAX_MEMORY_LINE_CHARS + 1);
    } finally {
      h.close();
    }
  });

  it('整体编辑：版本乐观锁、内容不变不涨版本、CRLF 归一化', () => {
    const h = createHarness();
    try {
      const created = h.ctx.services.memory.replace(
        { project: PROJECT, content_md: '# 记忆\r\n- [a] 第一条', expected_version: 0 },
        testCtx(),
      );
      expect(created.changed).toBe(true);
      expect(created.memory.version).toBe(1);
      expect(created.memory.content_md).toBe('# 记忆\n- [a] 第一条');

      // Web 上连点保存不应把版本推高，否则其他终端的 expected_version 会集体失效。
      const same = h.ctx.services.memory.replace(
        { project: PROJECT, content_md: '# 记忆\n- [a] 第一条', expected_version: 1 },
        testCtx(),
      );
      expect(same.changed).toBe(false);
      expect(same.memory.version).toBe(1);

      const next = h.ctx.services.memory.replace(
        {
          project: PROJECT,
          content_md: '# 记忆\n- [a] 第一条\n- [b] 第二条',
          expected_version: 1,
        },
        testCtx(),
      );
      expect(next.changed).toBe(true);
      expect(next.memory.version).toBe(2);

      // 旧版本覆盖必须显式报冲突，不能静默吞掉别人的写入。
      expect(() =>
        h.ctx.services.memory.replace(
          { project: PROJECT, content_md: '覆盖', expected_version: 1 },
          testCtx(),
        ),
      ).toThrow(/MEMORY_VERSION_CONFLICT/);

      // 不存在的行却声称 version>0，同样是冲突而不是创建。
      expect(() =>
        h.ctx.services.memory.replace(
          { project: 'devhost/other-project', content_md: 'x', expected_version: 3 },
          testCtx(),
        ),
      ).toThrow(/MEMORY_VERSION_CONFLICT/);
    } finally {
      h.close();
    }
  });

  it('写入成功后留下 memory.append / memory.update 审计', () => {
    const h = createHarness();
    try {
      h.ctx.services.memory.append(appendInput(['- [a] 第一条']), testCtx());
      h.ctx.services.memory.replace(
        { project: PROJECT, content_md: '- [a] 第一条\n- [b] 第二条', expected_version: 1 },
        testCtx(),
      );
      const rows = h.db
        .prepare(
          "SELECT action, object_type, object_id FROM audit_log WHERE object_type = 'project_memory' ORDER BY id",
        )
        .all() as Array<{ action: string; object_type: string; object_id: string }>;
      expect(rows.map((row) => row.action)).toEqual(['memory.append', 'memory.update']);
      expect(rows.every((row) => row.object_id === PROJECT)).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe('主通道记忆：REST', () => {
  it('GET 空记忆、PUT 创建、再 GET 读回同一份内容', async () => {
    const { a } = await boot();
    const empty = await api<{ exists: boolean; version: number }>(
      a,
      'GET',
      `/api/memory?project=${encodeURIComponent(PROJECT)}`,
    );
    expect(empty.status).toBe(200);
    expect(empty.body.data).toMatchObject({ exists: false, version: 0 });

    const saved = await api<{ content_md: string; version: number }>(a, 'PUT', '/api/memory', {
      project: PROJECT,
      content_md: '- [deploy] 先备份\n- [ui] 模态框',
      expected_version: 0,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data?.version).toBe(1);

    const read = await api<{ content_md: string; line_count: number }>(
      a,
      'GET',
      `/api/memory?project=${encodeURIComponent(PROJECT)}`,
    );
    expect(read.body.data?.content_md).toBe('- [deploy] 先备份\n- [ui] 模态框');
    expect(read.body.data?.line_count).toBe(2);
  });

  it('PUT 版本冲突返回 409 与最新版本号', async () => {
    const { a } = await boot();
    await api(a, 'PUT', '/api/memory', {
      project: PROJECT,
      content_md: '第一版',
      expected_version: 0,
    });
    const conflict = await api(a, 'PUT', '/api/memory', {
      project: PROJECT,
      content_md: '覆盖',
      expected_version: 0,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe('CONFLICT');
    expect(conflict.body.error?.message).toBe('MEMORY_VERSION_CONFLICT');
    expect(conflict.body.error?.details).toMatchObject({ actual_version: 1 });
  });

  it('缺少 project、超长内容与含敏感模式的内容都被 400 拒绝', async () => {
    const { a } = await boot();
    // 缺少查询参数走统一的入参守卫，错误码比 zod 的 VALIDATION_FAILED 更具体。
    const missing = await api(a, 'GET', '/api/memory');
    expect(missing.status).toBe(400);
    expect(missing.body.error?.message).toBe('PARAM_REQUIRED');

    const tooLarge = await api(a, 'PUT', '/api/memory', {
      project: PROJECT,
      content_md: 'x'.repeat(MAX_MEMORY_CHARS + 1),
      expected_version: 0,
    });
    expect(tooLarge.status).toBe(400);

    const secret = await api(a, 'PUT', '/api/memory', {
      project: PROJECT,
      content_md: 'password: supersecret123',
      expected_version: 0,
    });
    expect(secret.status).toBe(400);
    expect(secret.body.error?.message).toBe('SENSITIVE_PATTERN_DETECTED');
  });
});

describe('主通道记忆：MCP', () => {
  it('memory.append/search/get/update 串成一条链，update 不回传正文', async () => {
    const { a } = await boot();

    const empty = await mcp(a, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'memory.get', arguments: { project: PROJECT } },
    });
    expect(mcpToolData(empty)).toMatchObject({ exists: false, version: 0, content_md: '' });

    const appended = await mcp(a, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'memory.append',
        arguments: { project: PROJECT, lines: ['- [deploy] 先备份', '- [ui] 模态框'] },
      },
    });
    expect(mcpToolData(appended)).toMatchObject({ appended: 2, version: 1, line_count: 2 });

    const searched = await mcp(a, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory.search', arguments: { project: PROJECT, query: 'deploy' } },
    });
    expect(mcpToolData(searched)).toMatchObject({ total: 1, matches: [{ line_no: 1 }] });

    const updated = await mcp(a, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'memory.update',
        arguments: {
          project: PROJECT,
          content_md: '- [deploy] 先备份\n- [ui] 模态框\n- [auth] 白名单',
          expected_version: 1,
        },
      },
    });
    const updatedData = mcpToolData(updated) as Record<string, unknown>;
    expect(updatedData).toMatchObject({ version: 2, changed: true, line_count: 3 });
    // 调用方刚提交过正文，再回一份只会重复占用上下文。
    expect(updatedData).not.toHaveProperty('content_md');

    const full = await mcp(a, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'memory.get', arguments: { project: PROJECT } },
    });
    expect(mcpToolData(full)).toMatchObject({ version: 2, exists: true, line_count: 3 });
  });

  it('MCP 版本冲突同样以 isError 返回业务错误', async () => {
    const { a } = await boot();
    await mcp(a, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'memory.update',
        arguments: { project: PROJECT, content_md: '第一版', expected_version: 0 },
      },
    });
    const conflict = await mcp(a, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'memory.update',
        arguments: { project: PROJECT, content_md: '覆盖', expected_version: 0 },
      },
    });
    expect(conflict.result).toMatchObject({ isError: true });
    const text = (conflict.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('MEMORY_VERSION_CONFLICT');
  });
});
