import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  createHarness,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

/**
 * 事项页的人工属性（channel.meta_json）。
 *
 * 关键契约：
 *  - 只传出现的字段才覆盖，其余保持不变；
 *  - 空串/null 表示清空，展示层回退到推导值；
 *  - 非法枚举值由 REST schema 拒绝，服务层也做同样的白名单清洗（防止直写）。
 */
const CHANNEL = 'devhost/items-proj/item-topic';

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

describe('事项属性：服务层', () => {
  it('首次写入返回完整形状，未设置字段为空值而不是 undefined', () => {
    const h = createHarness();
    try {
      h.ctx.services.channels.ensure({ channel_key: CHANNEL }, testCtx());
      const view = h.ctx.services.channels.setMeta(
        CHANNEL,
        {
          owner: '  张三  ',
          priority: 'P1',
          stage: 'in_progress',
          group: ' 小组 A ',
          participants: ['张三', ' 李四 ', '张三'],
          tags: ['登录', '登录', ' '],
          iteration: '2026-11',
          product: 'AIDash',
          category: '稳定性',
          remark: '第一版备注',
        },
        testCtx(),
      );

      expect(view.meta).toEqual({
        owner: '张三',
        priority: 'P1',
        stage: 'in_progress',
        group: '小组 A',
        participants: ['张三', '李四'],
        tags: ['登录'],
        iteration: '2026-11',
        product: 'AIDash',
        category: '稳定性',
        remark: '第一版备注',
        ai_suggestion: null,
        ai_suggestion_at: null,
      });

      // 列表视图与单条视图同一口径：都是解析后的对象，不是 JSON 字符串。
      const listed = h.ctx.services.channels.list({ q: CHANNEL }).items[0];
      expect(listed?.meta.owner).toBe('张三');
      expect(listed?.meta.tags).toEqual(['登录']);

      const rows = h.db
        .prepare("SELECT action FROM audit_log WHERE action = 'channel.meta'")
        .all() as Array<{ action: string }>;
      expect(rows.length).toBe(1);
    } finally {
      h.close();
    }
  });

  it('局部 patch 不覆盖其他字段；空值可清空，相同值不刷 updated_at', () => {
    const h = createHarness();
    try {
      h.ctx.services.channels.ensure({ channel_key: CHANNEL }, testCtx());
      h.ctx.services.channels.setMeta(
        CHANNEL,
        { owner: '张三', tags: ['登录'], remark: '保留' },
        testCtx(),
      );
      const before = h.ctx.services.channels.getByKey(CHANNEL)!.updated_at;
      h.clock.advance(1_000);

      const patched = h.ctx.services.channels.setMeta(
        CHANNEL,
        { priority: 'P0' },
        testCtx(),
      );
      expect(patched.meta.owner).toBe('张三');
      expect(patched.meta.tags).toEqual(['登录']);
      expect(patched.meta.priority).toBe('P0');
      expect(h.ctx.services.channels.getByKey(CHANNEL)!.updated_at).toBeGreaterThan(before);

      const afterPatch = h.ctx.services.channels.getByKey(CHANNEL)!.updated_at;
      h.clock.advance(1_000);
      h.ctx.services.channels.setMeta(CHANNEL, { priority: 'P0' }, testCtx());
      expect(h.ctx.services.channels.getByKey(CHANNEL)!.updated_at).toBe(afterPatch);

      const cleared = h.ctx.services.channels.setMeta(
        CHANNEL,
        { owner: '   ', tags: [], remark: null },
        testCtx(),
      );
      expect(cleared.meta.owner).toBeNull();
      expect(cleared.meta.tags).toEqual([]);
      expect(cleared.meta.remark).toBeNull();
      expect(cleared.meta.priority).toBe('P0');
    } finally {
      h.close();
    }
  });

  it('坏 JSON / 非法枚举不炸列表，按空值/白名单清洗', () => {
    const h = createHarness();
    try {
      const { channel } = h.ctx.services.channels.ensure(
        { channel_key: CHANNEL },
        testCtx(),
      );
      h.db
        .prepare('UPDATE channel SET meta_json = ? WHERE id = ?')
        .run('{not-json', channel.id);
      expect(h.ctx.services.channels.list({ q: CHANNEL }).items[0]?.meta.owner).toBeNull();

      h.db
        .prepare('UPDATE channel SET meta_json = ? WHERE id = ?')
        .run(
          JSON.stringify({
            owner: '张三',
            priority: 'P9',
            stage: 'blocked',
            participants: 'not-array',
            unknown: 'drop-me',
          }),
          channel.id,
        );
      const view = h.ctx.services.channels.list({ q: CHANNEL }).items[0]!;
      expect(view.meta.owner).toBe('张三');
      expect(view.meta.priority).toBeNull();
      expect(view.meta.stage).toBeNull();
      expect(view.meta.participants).toEqual([]);
      expect('unknown' in view.meta).toBe(false);
    } finally {
      h.close();
    }
  });
});

describe('事项属性：REST', () => {
  it('PATCH meta 保存/清空都返回最新视图', async () => {
    const { a } = await boot();
    await api(a, 'POST', '/api/channels', { channel_key: CHANNEL, title: '事项通道' });

    const saved = await api<{
      channel_key: string;
      meta: { owner: string | null; priority: string | null; tags: string[] };
    }>(a, 'PATCH', `/api/channels/${encodeURIComponent(CHANNEL)}`, {
      meta: { owner: '李四', priority: 'P2', tags: ['前端'] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({
      channel_key: CHANNEL,
      meta: { owner: '李四', priority: 'P2', tags: ['前端'] },
    });

    const cleared = await api<{ meta: { owner: string | null; tags: string[] } }>(
      a,
      'PATCH',
      `/api/channels/${encodeURIComponent(CHANNEL)}`,
      { meta: { owner: null, tags: [] } },
    );
    expect(cleared.body.data?.meta.owner).toBeNull();
    expect(cleared.body.data?.meta.tags).toEqual([]);

    // “关闭”是合法阶段：默认筛选靠它隐藏已收尾事项，不能被白名单当成非法值清掉。
    const closed = await api<{ meta: { stage: string | null } }>(
      a,
      'PATCH',
      `/api/channels/${encodeURIComponent(CHANNEL)}`,
      { meta: { stage: 'closed' } },
    );
    expect(closed.status).toBe(200);
    expect(closed.body.data?.meta.stage).toBe('closed');
  });

  it('非法优先级/空 patch 被 400 拒绝', async () => {
    const { a } = await boot();
    await api(a, 'POST', '/api/channels', { channel_key: CHANNEL });

    const bad = await api(a, 'PATCH', `/api/channels/${encodeURIComponent(CHANNEL)}`, {
      meta: { priority: 'P9' },
    });
    expect(bad.status).toBe(400);

    const badStage = await api(a, 'PATCH', `/api/channels/${encodeURIComponent(CHANNEL)}`, {
      meta: { stage: 'blocked' },
    });
    expect(badStage.status).toBe(400);

    const empty = await api(a, 'PATCH', `/api/channels/${encodeURIComponent(CHANNEL)}`, {});
    expect(empty.status).toBe(400);
  });
});
