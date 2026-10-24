import { afterEach, describe, expect, it } from 'vitest';
import { api, createHarness, startApp, type RunningApp, type TestHarness } from './helpers.js';
import { MAX_TASK_DESCRIPTION_CHARS } from '../src/shared/constants.js';
import { taskCreateSchema } from '../src/shared/schemas.js';
// 直接复用前端纯函数：插入逻辑与安全过滤都是纯字符串处理，不需要浏览器环境。
import { insertAtSelection } from '../src/web/src/lib/markdown-image.js';
import { isSafeImageSrc } from '../src/web/src/components/Markdown.js';

// 只由 vitest 收集：验证任务描述上限、图片 Markdown 插入与批量查询不返回正文。
// 不启动真实 8787、不写磁盘库；每个用例用内存库。
const CHANNEL = 'devhost/myproj/task-description';

let harness: TestHarness | null = null;
let app: RunningApp | null = null;

afterEach(async () => {
  if (app) await app.close();
  harness?.close();
  app = null;
  harness = null;
});

describe('任务描述与内嵌图片', () => {
  it('描述上限从 64KB 提升到共享常量，并仍拒绝超限内容', () => {
    const longBody = 'x'.repeat(100_000);
    const parsed = taskCreateSchema.parse({
      channel_key: CHANNEL,
      title: '带长描述的任务',
      description_md: longBody,
    });
    expect(parsed.description_md).toHaveLength(100_000);

    expect(() =>
      taskCreateSchema.parse({
        channel_key: CHANNEL,
        title: '超限',
        description_md: 'x'.repeat(MAX_TASK_DESCRIPTION_CHARS + 1),
      }),
    ).toThrow();
  });

  it('图片 Markdown 只放行 http(s) 与常见位图 base64', () => {
    expect(isSafeImageSrc('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isSafeImageSrc('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    expect(isSafeImageSrc('https://example.com/a.png')).toBe(true);
    // SVG 可携带脚本，且 <img> 渲染它没有必要性，直接拒绝。
    expect(isSafeImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isSafeImageSrc('javascript:alert(1)')).toBe(false);
  });

  it('在光标处插入图片并补足块级空行', () => {
    const inserted = insertAtSelection('abcd', '![图](data:image/png;base64,AA)', 2, 3);
    expect(inserted.value).toBe('ab\n\n![图](data:image/png;base64,AA)\n\nd');
    expect(inserted.cursor).toBe(inserted.value.length - 1);

    // 已经处于行尾时不再重复补换行。
    expect(insertAtSelection('a\n', 'IMG', 2, 2).value).toBe('a\nIMG');

    // 异常选区被夹到合法范围，避免 slice 出空串。
    expect(insertAtSelection('abc', 'IMG', 99, 99).value).toBe('abc\n\nIMG');
  });

  it('列表/树默认不返回描述，显式参数与详情接口仍可拿到正文', async () => {
    harness = createHarness();
    app = await startApp(harness);
    const body = '正文 ' + 'x'.repeat(70_000);

    const created = await api<{ task: { id: string; description_md: string | null } }>(
      app,
      'POST',
      '/api/tasks',
      { channel_key: CHANNEL, title: '带截图的任务', description_md: body },
    );
    expect(created.status).toBe(201);
    const taskId = created.body.data?.task.id ?? '';
    // 创建响应本身是“写操作回执”，应当带完整正文，方便前端直接进入详情。
    expect(created.body.data?.task.description_md).toBe(body);

    const list = await api<{ items: Array<{ id: string; description_md: string | null }> }>(
      app,
      'GET',
      `/api/tasks?channel_key=${encodeURIComponent(CHANNEL)}`,
    );
    expect(list.body.data?.items[0]?.description_md).toBeNull();

    const listFull = await api<{ items: Array<{ id: string; description_md: string | null }> }>(
      app,
      'GET',
      `/api/tasks?channel_key=${encodeURIComponent(CHANNEL)}&include_description=true`,
    );
    expect(listFull.body.data?.items[0]?.description_md).toBe(body);

    const tree = await api<Array<{ id: string; description_md: string | null }>>(
      app,
      'GET',
      `/api/tasks/tree?channel_key=${encodeURIComponent(CHANNEL)}`,
    );
    expect(tree.body.data?.[0]?.description_md).toBeNull();

    const treeFull = await api<Array<{ id: string; description_md: string | null }>>(
      app,
      'GET',
      `/api/tasks/tree?channel_key=${encodeURIComponent(CHANNEL)}&include_description=true`,
    );
    expect(treeFull.body.data?.[0]?.description_md).toBe(body);

    const detail = await api<{ description_md: string | null }>(
      app,
      'GET',
      `/api/tasks/${taskId}`,
    );
    expect(detail.body.data?.description_md).toBe(body);

    // 写操作回执也必须带完整正文：前端保存后直接用回执回填，不应再补一次详情请求。
    const nextBody = `${body} 更新`;
    const patched = await api<{ description_md: string | null }>(
      app,
      'PATCH',
      `/api/tasks/${taskId}`,
      { patch: { description_md: nextBody } },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.data?.description_md).toBe(nextBody);

    // 事件表只留“改过描述”的痕迹，不能复制整段 base64：
    // 否则每保存一次就多一份截图，数据库会被审计日志撑爆。
    const event = harness.db
      .prepare(
        "SELECT detail_json FROM task_event WHERE task_id = ? AND event = 'updated' ORDER BY id DESC LIMIT 1",
      )
      .get(taskId) as { detail_json: string };
    expect(event.detail_json).toContain('[omitted');
    expect(event.detail_json.length).toBeLessThan(1_000);
    expect(event.detail_json).not.toContain('x'.repeat(1_000));
  });
});
