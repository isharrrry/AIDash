import { afterEach, describe, expect, it } from 'vitest';
import { cardPostSchema } from '../src/shared/schemas.js';
import {
  api,
  createHarness,
  questionPayload,
  seedTask,
  startApp,
  testCtx,
  type RunningApp,
  type TestHarness,
} from './helpers.js';

const CHANNEL = 'devhost/myproj/card-read';

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

function infoPayload(taskId: string, title: string): Record<string, unknown> {
  return {
    channel_key: CHANNEL,
    type: 'info',
    title,
    body_md: '正文',
    severity: 'info',
    task_id: taskId,
  };
}

interface CardPage {
  total: number;
  items: Array<{ id: string; task_id: string | null; read_at: string | null }>;
}

interface TreeNode {
  id: string;
  unread_count: number;
}

describe('信息归属', () => {
  it('非 question 卡缺 task_id：schema 与 REST 都拒绝', async () => {
    // 这是“信息必须挂在任务下”的第一道闸：schema 层直接不给解析通过。
    const parsed = cardPostSchema.safeParse({
      channel_key: CHANNEL,
      type: 'info',
      title: '没有归属的消息',
      body_md: '正文',
      severity: 'info',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('task_id');
    }

    // 第二道闸：REST 入口返回统一的 VALIDATION_FAILED，而不是落库后再报错。
    const { a } = await boot();
    const rejected = await api(a, 'POST', '/api/cards', {
      channel_key: CHANNEL,
      type: 'status',
      summary: '没有任务的状态卡',
      result: 'success',
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.message).toBe('VALIDATION_FAILED');

    const listed = await api<CardPage>(a, 'GET', `/api/cards?channel_key=${CHANNEL}`);
    expect(listed.body.data?.total).toBe(0);
  });

  it('status/handoff 卡带 body_md 时明确报错，不再静默丢弃', async () => {
    const { h, a } = await boot();
    const taskId = seedTask(h, CHANNEL, '正文归属任务');

    // schema 层：错误必须指向 body_md，并告诉调用方该改用哪个字段。
    const status = cardPostSchema.safeParse({
      channel_key: CHANNEL,
      type: 'status',
      summary: '状态卡',
      result: 'success',
      body_md: '这段正文以前会被吞掉',
      task_id: taskId,
    });
    expect(status.success).toBe(false);
    if (!status.success) {
      const issue = status.error.issues.find((item) => item.path.join('.') === 'body_md');
      expect(issue?.message).toContain('detail_md');
    }

    const handoff = cardPostSchema.safeParse({
      channel_key: CHANNEL,
      type: 'handoff',
      recipient: '某人',
      channel_kind: 'other',
      reason: '同步进展',
      message_md: '正文',
      body_md: '同义字段',
      task_id: taskId,
    });
    expect(handoff.success).toBe(false);
    if (!handoff.success) {
      const issue = handoff.error.issues.find((item) => item.path.join('.') === 'body_md');
      expect(issue?.message).toContain('message_md');
    }

    // REST 入口：统一 VALIDATION_FAILED，且不能留下半张卡。
    const rejected = await api(a, 'POST', '/api/cards', {
      channel_key: CHANNEL,
      type: 'status',
      summary: '状态卡',
      result: 'success',
      body_md: '这段正文以前会被吞掉',
      task_id: taskId,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.message).toBe('VALIDATION_FAILED');
    const listed = await api<CardPage>(a, 'GET', `/api/cards?channel_key=${CHANNEL}`);
    expect(listed.body.data?.total).toBe(0);
  });

  it('question 卡允许不挂任务，read_at 初始为 null', async () => {
    const { a } = await boot();
    const created = await api<{
      card: { id: string; task_id: string | null; read_at: string | null };
    }>(
      a,
      'POST',
      '/api/cards',
      questionPayload({
        channel_key: CHANNEL,
        type: 'question',
        title: '临时拍板不必先建任务',
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body.data?.card.task_id).toBeNull();
    expect(created.body.data?.card.read_at).toBeNull();
  });

  it('每个任务的信息流只包含自己的卡', async () => {
    const { h, a } = await boot();
    const taskA = seedTask(h, CHANNEL, '任务 A');
    const taskB = seedTask(h, CHANNEL, '任务 B');
    await api(a, 'POST', '/api/cards', infoPayload(taskA, 'A 的第一条'));
    await api(a, 'POST', '/api/cards', infoPayload(taskA, 'A 的第二条'));
    await api(a, 'POST', '/api/cards', infoPayload(taskB, 'B 的唯一一条'));

    const page = await api<CardPage>(a, 'GET', `/api/cards?task_id=${taskA}`);
    expect(page.body.data?.total).toBe(2);
    expect(page.body.data?.items.every((card) => card.task_id === taskA)).toBe(true);
  });
});

describe('已读与未读', () => {
  it('标记已读幂等：重复调用保留第一次的 read_at，列表能读到', async () => {
    const { h, a } = await boot();
    const taskId = seedTask(h, CHANNEL, '已读任务');
    const created = await api<{ card: { id: string } }>(
      a,
      'POST',
      '/api/cards',
      infoPayload(taskId, '待读消息'),
    );
    const cardId = created.body.data!.card.id;

    const before = await api<CardPage>(a, 'GET', `/api/cards?task_id=${taskId}`);
    expect(before.body.data?.items[0]?.read_at).toBeNull();

    const first = await api<{ read_at: string | null }>(a, 'POST', `/api/cards/${cardId}/read`);
    expect(first.status).toBe(200);
    expect(first.body.data?.read_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 把时钟推后一分钟再读一次：已读是“第一次看到”的事实，不应被刷新成最后一次。
    h.clock.advance(60_000);
    const second = await api<{ read_at: string | null }>(a, 'POST', `/api/cards/${cardId}/read`);
    expect(second.body.data?.read_at).toBe(first.body.data?.read_at);

    const after = await api<CardPage>(a, 'GET', `/api/cards?task_id=${taskId}`);
    expect(after.body.data?.items.find((card) => card.id === cardId)?.read_at).toBe(
      first.body.data?.read_at,
    );
  });

  it('任务树未读数按任务聚合，读一条减一条，归档卡不再计', async () => {
    const { h, a } = await boot();
    const taskA = seedTask(h, CHANNEL, '未读任务 A');
    const taskB = seedTask(h, CHANNEL, '未读任务 B');

    const post = (taskId: string, title: string) =>
      api<{ card: { id: string } }>(a, 'POST', '/api/cards', infoPayload(taskId, title));
    const a1 = (await post(taskA, 'A1')).body.data!.card.id;
    const a2 = (await post(taskA, 'A2')).body.data!.card.id;
    const b1 = (await post(taskB, 'B1')).body.data!.card.id;

    const treeUrl = `/api/tasks/tree?channel_key=${encodeURIComponent(CHANNEL)}`;
    const countOf = async (taskId: string): Promise<number | undefined> => {
      const tree = await api<TreeNode[]>(a, 'GET', treeUrl);
      return tree.body.data?.find((node) => node.id === taskId)?.unread_count;
    };

    expect(await countOf(taskA)).toBe(2);
    expect(await countOf(taskB)).toBe(1);

    // 逐条已读：只影响被读的那张卡所属任务。
    await api(a, 'POST', `/api/cards/${a1}/read`);
    expect(await countOf(taskA)).toBe(1);
    expect(await countOf(taskB)).toBe(1);

    await api(a, 'POST', `/api/cards/${a2}/read`);
    expect(await countOf(taskA)).toBe(0);

    // 归档不是已读：但它不该继续出现在红点里，否则用户永远清不掉。
    await api(a, 'POST', `/api/cards/${b1}/archive`);
    expect(await countOf(taskB)).toBe(0);

    // 任务列表与任务树必须同一口径，否则列表页和树会对不上。
    const list = await api<{ items: Array<{ id: string; unread_count: number }> }>(
      a,
      'GET',
      `/api/tasks?channel_key=${encodeURIComponent(CHANNEL)}`,
    );
    expect(list.body.data?.items.find((task) => task.id === taskA)?.unread_count).toBe(0);
    expect(list.body.data?.items.find((task) => task.id === taskB)?.unread_count).toBe(0);
  });

  it('读一张不存在的卡返回 404，不写入已读记录', async () => {
    const { a } = await boot();
    const missing = await api(a, 'POST', '/api/cards/cd_missing/read');
    expect(missing.status).toBe(404);
  });
});

describe('历史未归属卡', () => {
  it('unassigned 过滤只返回升级前没有任务的卡', async () => {
    const { h, a } = await boot();
    const { channel } = h.ctx.services.channels.ensure({ channel_key: CHANNEL }, testCtx());
    const now = h.clock.now();
    // 直接写库模拟升级前的存量数据：新契约已经不可能再产生 task_id 为空的非 question 卡。
    h.db
      .prepare(
        `INSERT INTO card (id, channel_id, type, title, body_md, severity, created_at, updated_at)
         VALUES (?, ?, 'info', '旧版消息', '正文', 'info', ?, ?)`,
      )
      .run('cd_legacy_fixture', channel.id, now, now);

    const legacy = await api<CardPage>(a, 'GET', '/api/cards?unassigned=true');
    expect(legacy.body.data?.total).toBe(1);
    expect(legacy.body.data?.items[0]?.task_id).toBeNull();

    // 新卡必须挂任务，因此不会混进“历史遗留”入口。
    await api(a, 'POST', '/api/cards', infoPayload(seedTask(h, CHANNEL), '新消息'));
    const again = await api<CardPage>(a, 'GET', '/api/cards?unassigned=true');
    expect(again.body.data?.total).toBe(1);
  });
});
