import { describe, expect, it } from 'vitest';
import { pickGroupAlias } from '../src/web/src/lib/channel-group.js';
import { markdownFileName, safeFilename } from '../src/web/src/lib/download.js';
import { FEED_PAGE_SIZE, toAscendingPage } from '../src/web/src/lib/feed-page.js';
import { sortMemoryProjects } from '../src/web/src/lib/memory-sort.js';

/**
 * 列表展示相关的纯函数测试。
 *
 * 这些函数都不碰 DOM：下载文件名、记忆排序、通道分组别名都可以直接单测，
 * 避免为了验证“排序对不对”去起浏览器。真正的浏览器验收另走真机 CDP。
 */

describe('通道分组别名', () => {
  it('没有别名或只有空白时回退 null', () => {
    expect(pickGroupAlias([])).toBeNull();
    expect(
      pickGroupAlias([
        { alias: null },
        { alias: '   ' },
      ]),
    ).toBeNull();
  });

  it('优先选在线通道的别名，即使它更新更早', () => {
    const alias = pickGroupAlias([
      { alias: '离线但更新更晚', agent_online: false, last_active_at: '2026-10-24T12:00:00Z' },
      { alias: '在线这条', agent_online: true, last_active_at: '2026-10-24T09:00:00Z' },
    ]);
    expect(alias).toBe('在线这条');
  });

  it('在线状态相同时按最近活动时间倒序，缺少活动时间再退回 updated_at/created_at', () => {
    expect(
      pickGroupAlias([
        { alias: '较早', agent_online: false, last_active_at: '2026-10-24T09:00:00Z' },
        { alias: '较晚', agent_online: false, last_active_at: '2026-10-24T12:00:00Z' },
      ]),
    ).toBe('较晚');

    expect(
      pickGroupAlias([
        { alias: '旧创建', created_at: '2026-10-20T09:00:00Z' },
        { alias: '新更新', created_at: '2026-10-20T09:00:00Z', updated_at: '2026-10-24T09:00:00Z' },
      ]),
    ).toBe('新更新');
  });

  it('别名去首尾空格后再返回，避免分组标题里出现不可见空白', () => {
    expect(pickGroupAlias([{ alias: '  登录排查  ' }])).toBe('登录排查');
  });
});

describe('下载文件名', () => {
  it('替换 Windows/Unix 路径非法字符并压缩空白', () => {
    expect(safeFilename('年报: 2026/Q4 *终版*')).toBe('年报 2026 Q4 终版');
  });

  it('空文件名回退到兜底值，开头的点会被去掉，避免生成隐藏文件', () => {
    expect(safeFilename('   ')).toBe('download');
    expect(safeFilename('...')).toBe('download');
    expect(safeFilename('../secret')).toBe('secret');
  });

  it('超长标题截断，避免触发文件系统长度限制', () => {
    expect(safeFilename('长'.repeat(200)).length).toBeLessThanOrEqual(120);
  });

  it('Markdown 文件名统一补 .md，不重复追加', () => {
    expect(markdownFileName('月报')).toBe('月报.md');
    expect(markdownFileName('月报.md')).toBe('月报.md');
    expect(markdownFileName('月报.MD')).toBe('月报.MD');
  });
});

const MEMORY_PROJECTS = [
  {
    project: 'beta',
    alias: '乙项目',
    updated_at: '2026-10-24T09:00:00.000Z',
    line_count: 3,
  },
  {
    project: 'alpha',
    alias: null,
    updated_at: '2026-10-24T12:00:00.000Z',
    line_count: 8,
  },
  {
    project: 'gamma',
    alias: '甲项目',
    updated_at: null,
    line_count: 1,
  },
];

describe('信息流倒序取窗', () => {
  it('把服务端倒序结果反转成正序，且不修改入参', () => {
    // 服务端按 created_at desc 返回：最新在前。
    const descending = [{ id: 'newest' }, { id: 'middle' }, { id: 'oldest' }];
    const page = toAscendingPage(descending, descending.length, FEED_PAGE_SIZE);

    expect(page.items.map((item) => item.id)).toEqual(['oldest', 'middle', 'newest']);
    expect(descending.map((item) => item.id)).toEqual(['newest', 'middle', 'oldest']);
    expect(page.truncated).toBe(false);
    expect(page.limit).toBe(FEED_PAGE_SIZE);
  });

  it('total 大于实收条数时标记截断，并带回总量与窗口大小', () => {
    const items = Array.from({ length: FEED_PAGE_SIZE }, (_, index) => index);
    const page = toAscendingPage(items, FEED_PAGE_SIZE + 7, FEED_PAGE_SIZE);

    expect(page.total).toBe(FEED_PAGE_SIZE + 7);
    expect(page.truncated).toBe(true);
    expect(page.limit).toBe(FEED_PAGE_SIZE);
    expect(page.items).toHaveLength(FEED_PAGE_SIZE);
    // 输入按倒序理解（0 是最新），反转后第一条应是最旧的那个。
    expect(page.items[0]).toBe(FEED_PAGE_SIZE - 1);
  });

  it('total 等于实收条数（恰好取满一页）时不误报截断', () => {
    const page = toAscendingPage([3, 2, 1], 3, FEED_PAGE_SIZE);

    expect(page.truncated).toBe(false);
    expect(page.total).toBe(3);
  });

  it('total 小于实收条数（服务端数据异常）时也不提示截断', () => {
    const page = toAscendingPage([2, 1], 1, FEED_PAGE_SIZE);

    expect(page.truncated).toBe(false);
  });

  it('total 缺失或非法时回退为实际条数，避免制造假的截断提示', () => {
    const page = toAscendingPage([2, 1], undefined as unknown as number, FEED_PAGE_SIZE);

    expect(page.total).toBe(2);
    expect(page.truncated).toBe(false);
  });
});

describe('记忆项目排序', () => {
  it('默认按修改时间倒序，未写记忆的项目排最后', () => {
    expect(sortMemoryProjects(MEMORY_PROJECTS, 'updated').map((item) => item.project)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('按名称排序时优先使用别名，没有别名再用 project', () => {
    // 中文按拼音排序：甲(jiǎ) 在 乙(yǐ) 之前；没有别名的 alpha 排在拼音之后。
    expect(sortMemoryProjects(MEMORY_PROJECTS, 'name').map((item) => item.project)).toEqual([
      'gamma', // 甲项目
      'beta', // 乙项目
      'alpha', // alpha
    ]);
  });

  it('按行数倒序，行数相同再按名称稳定排序', () => {
    expect(sortMemoryProjects(MEMORY_PROJECTS, 'lines').map((item) => item.project)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('排序返回新数组，不原地修改调用方数据', () => {
    const original = [...MEMORY_PROJECTS];
    sortMemoryProjects(MEMORY_PROJECTS, 'updated');
    expect(MEMORY_PROJECTS).toEqual(original);
  });
});
