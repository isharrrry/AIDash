import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { taskCreateSchema } from '../src/shared/schemas.js';
import type { ReportRow, ReportRunRow } from '../src/server/repos/report-repo.js';
import type { ReportRepo } from '../src/server/repos/report-repo.js';
import type { AuditService } from '../src/server/services/audit-service.js';
import type { LlmService } from '../src/server/services/llm-service.js';
import { periodLabel, periodRange, periodRangeFromKey } from '../src/server/services/report-period.js';
import {
  ReportService,
  type ReportServiceDeps,
} from '../src/server/services/report-service.js';
import type { SettingsService } from '../src/server/services/settings-service.js';
import { createHarness, testCtx, type TestHarness } from './helpers.js';
import {
  CHANNEL,
  REPORT_CONTENT,
  configure,
  createRun,
  expectAppError,
  internals,
  makeService,
  seedCardRow,
  seedTaskRow,
  startFakeLlm,
  waitFor,
  waitForIdle,
  waitForRun,
  wrapReports,
  type FakeLlm,
  type ReportServiceInternals,
} from './fakes/report-fixtures.js';

let harness: TestHarness | null = null;
let fake: FakeLlm | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
  harness?.close();
  harness = null;
});

/**
 * 汇报素材收集分支。
 *
 * 由 report-branches 按主题拆出：抽样、隐患/完成标记、截断、运行环境、
 * 未超上限时全量进入提示词。断言保持原样，仅搬移分组。
 */

describe('素材收集', () => {
  /**
   * 大样本素材：
   * - 120 条任务（> MAX_SOURCE_TASKS=80，stride=2，抽样 60 条）；
   * - 70 张卡片（> MAX_SOURCE_CARDS=60，stride=2，抽样 35 条）；
   * - 故意让素材总长超过 40,000 字符，覆盖截断分支。
   *
   * 特殊样本放在 rn=1/3/5/7/9（updated_at 最大），保证它们在截断后仍然可见。
   */
  it('任务/卡片等距抽样、隐患与完成标记、超长截断', () => {
    const h = createHarness();
    harness = h;
    const now = h.clock.now();
    const day = periodRange('day', now);
    const solo = h.ctx.services.channels.ensure({ channel_key: 'solo' }, testCtx()).channel;
    const proj = h.ctx.services.channels.ensure({ channel_key: 'host/proj/topic' }, testCtx()).channel;

    // 运行环境样本：一个通道最近有 MCP 活动，另一个没有；harness 表里有一条 online。
    h.db.prepare('UPDATE channel SET last_mcp_at = ? WHERE id = ?').run(now, solo.id);
    h.db
      .prepare(
        `INSERT INTO harness (harness_id, name, status, last_seen, registered_at, updated_at)
         VALUES ('h1','测试机','online',?,?,?)`,
      )
      .run(now, now, now);

    const createdAt = day.start + 60_000;
    // 长标题：clip(title,200) 会截断并补省略号。
    const longTitle = 'T1' + 'a'.repeat(248);
    for (let i = 0; i < 120; i += 1) {
      const updatedAt = day.start + 3_600_000 + i * 1_000;
      const channelId = i % 2 === 0 ? solo.id : proj.id;
      if (i === 119) {
        // rn=1：无原因/无隐患/未指派/project 为空 → 走最多 default 分支。
        seedTaskRow(h, {
          id: 'bulk_task_119',
          channelId: solo.id,
          title: longTitle,
          status: 'draft',
          priority: 'P1',
          createdAt,
          updatedAt,
        });
      } else if (i === 117) {
        // rn=3：阻塞原因优先于其他原因；隐患已解除且有结论；完成时间存在。
        seedTaskRow(h, {
          id: 'bulk_task_117',
          channelId: proj.id,
          title: '阻塞中的建议任务',
          status: 'blocked',
          priority: 'P0',
          kind: 'suggestion',
          claimedBy: 'agent-x',
          claimToken: 'cl_task_87',
          claimExpiresAt: day.start + 9_999_999,
          blockedReason: '阻塞原因',
          riskNote: '隐患甲',
          riskResolvedAt: day.start + 1_000,
          riskResolution: '已修复',
          completedAt: day.start + 2_000,
          createdAt,
          updatedAt,
        });
      } else if (i === 115) {
        // rn=5：blocked 为空时回落到 fail_reason；隐患未解除；负责人取 assignee。
        seedTaskRow(h, {
          id: 'bulk_task_115',
          channelId: solo.id,
          title: '失败过的任务',
          status: 'draft',
          assignee: 'alice',
          failReason: '失败原因',
          riskNote: '隐患乙',
          createdAt,
          updatedAt,
        });
      } else if (i === 113) {
        // rn=7：cancel_reason；隐患已解除但没有结论。
        seedTaskRow(h, {
          id: 'bulk_task_113',
          channelId: proj.id,
          title: '被取消的任务',
          status: 'draft',
          cancelReason: '取消原因',
          riskNote: '隐患丙',
          riskResolvedAt: day.start + 1_000,
          createdAt,
          updatedAt,
        });
      } else if (i === 111) {
        // rn=9：defer_reason 兜底。
        seedTaskRow(h, {
          id: 'bulk_task_111',
          channelId: solo.id,
          title: '被暂缓的任务',
          status: 'draft',
          priority: 'P3',
          deferReason: '暂缓原因',
          createdAt,
          updatedAt,
        });
      } else {
        // 填充样本：长标题 + 长原因，把素材撑过 40,000 字符。
        seedTaskRow(h, {
          id: `bulk_task_${i}`,
          channelId,
          title: `${'f'.repeat(190)}${String(i).padStart(2, '0')}`,
          status: 'done',
          blockedReason: 'b'.repeat(1_000),
          createdAt,
          updatedAt,
          // 计数样本：失败/取消/阻塞各一条或两条，验证统计行。
          ...(i === 80 ? { failedAt: day.start + 3_000 } : {}),
          ...(i === 79 ? { cancelledAt: day.start + 4_000 } : {}),
          ...(i === 78 || i === 77 ? { blockedAt: day.start + 5_000 } : {}),
        });
      }
    }

    for (let i = 0; i < 70; i += 1) {
      const createdAtCard = day.start + 7_200_000 + i * 1_000;
      const channelId = i % 2 === 0 ? proj.id : solo.id;
      if (i === 69) {
        // rn=1：无标题 + 超长摘要（clip 到 400）+ result 后缀。
        seedCardRow(h, {
          id: 'bulk_card_69',
          channelId: proj.id,
          type: 'status',
          summary: 'S' + 'x'.repeat(449),
          result: 'success',
          createdAt: createdAtCard,
        });
      } else if (i === 67) {
        // rn=3：summary/detail 都为空 → 回落 body_md；severity 后缀。
        seedCardRow(h, {
          id: 'bulk_card_67',
          channelId: proj.id,
          type: 'info',
          title: '信息卡',
          body: '正文B',
          severity: 'warn',
          createdAt: createdAtCard,
        });
      } else if (i === 65) {
        // rn=5：三段文本全空 → continue，整行不进入素材。
        seedCardRow(h, {
          id: 'bulk_card_65',
          channelId: solo.id,
          type: 'question',
          title: '空文本问题卡',
          createdAt: createdAtCard,
        });
      } else if (i === 63) {
        // rn=7：summary 为空 → 取 detail_md。
        seedCardRow(h, {
          id: 'bulk_card_63',
          channelId: proj.id,
          type: 'question',
          title: '详情问题卡',
          detail: '详情D',
          createdAt: createdAtCard,
        });
      } else if (i === 61) {
        // rn=9：summary/detail 为空 → 取 body_md。
        seedCardRow(h, {
          id: 'bulk_card_61',
          channelId: solo.id,
          type: 'question',
          title: '正文问题卡',
          body: '正文E',
          createdAt: createdAtCard,
        });
      } else {
        seedCardRow(h, {
          id: `bulk_card_${i}`,
          channelId,
          type: 'info',
          title: `card-${i}`,
          body: 'C'.repeat(450),
          severity: 'info',
          createdAt: createdAtCard,
        });
      }
    }

    const material = internals(h.ctx.services.reports).collectMaterial(day.start, day.end);

    // 统计行：120 新登记、1 完成、1 失败、1 取消、2 阻塞。
    expect(material.text).toContain('## 本周期任务统计');
    expect(material.text).toContain('新登记 120；完成 1；失败 1；取消 1；进入阻塞 2');
    expect(material.text).toContain('## 本周期有更新的任务（共 120 条，按时间均匀抽样 60 条）');

    // rn=1：长标题截断、无人负责、project 为空时回落 channel_key。
    expect(material.text).toContain(longTitle.slice(0, 200) + '…');
    expect(material.text).toContain('（solo，负责人：未指派）');
    // rn=3：阻塞 / 建议 / 完成时间 / 已解除且有结论的隐患。
    expect(material.text).toContain('[blocked/P0/建议]');
    expect(material.text).toContain('（proj，负责人：agent-x，完成于 ');
    expect(material.text).toContain('；原因：阻塞原因；隐患：隐患甲（已解除：已修复）');
    // rn=5：fail_reason 回落、未解除隐患、assignee 兜底负责人。
    expect(material.text).toContain('（solo，负责人：alice）');
    expect(material.text).toContain('；原因：失败原因；隐患：隐患乙（未解除）');
    // rn=7：cancel_reason、已解除但无结论。
    expect(material.text).toContain('；原因：取消原因；隐患：隐患丙（已解除）');
    // rn=9：defer_reason。
    expect(material.text).toContain('；原因：暂缓原因');

    expect(material.text).toContain('## 本周期卡片（共 70 条，按时间均匀抽样 35 条）');
    expect(material.text).toContain('（无标题）');
    expect(material.text).toContain('/success]');
    expect(material.text).toContain('/warn]');
    expect(material.text).toContain('正文B');
    expect(material.text).toContain('详情D');
    expect(material.text).toContain('正文E');
    // 三段文本都空的卡片整行跳过。
    expect(material.text).not.toContain('空文本问题卡');

    // 超长素材在 40,000 字符处截断并明确标注。
    expect(material.text.length).toBeGreaterThan(40_000);
    expect(material.text.endsWith('\n…（素材过长，已截断）')).toBe(true);

    // count = 新登记 120 + 完成 1 + 失败 1 + 取消 1 + 抽样任务 60 + 抽样卡片 35。
    expect(material.count).toBe(218);
  });

  it('生成时未结束任务与运行环境只在近期窗口附加', () => {
    const h = createHarness();
    harness = h;
    const now = h.clock.now();
    const day = periodRange('day', now);
    const solo = h.ctx.services.channels.ensure({ channel_key: 'solo' }, testCtx()).channel;
    const proj = h.ctx.services.channels.ensure({ channel_key: 'host/proj/topic' }, testCtx()).channel;
    h.db.prepare('UPDATE channel SET last_mcp_at = ? WHERE id = ?').run(now, solo.id);
    h.db
      .prepare(
        `INSERT INTO harness (harness_id, name, status, last_seen, registered_at, updated_at)
         VALUES ('h1','测试机','online',?,?,?)`,
      )
      .run(now, now, now);

    const at = now - 1_000;
    seedTaskRow(h, {
      id: 'open_none',
      channelId: solo.id,
      title: '一切正常的开放任务',
      status: 'draft',
      priority: 'P1',
      createdAt: at,
      updatedAt: at,
    });
    seedTaskRow(h, {
      id: 'open_blocked',
      channelId: proj.id,
      title: '阻塞中的建议',
      status: 'blocked',
      priority: 'P0',
      kind: 'suggestion',
      claimedBy: 'agent-x',
      claimToken: 'cl_blocked',
      claimExpiresAt: now + 60_000,
      blockedReason: '阻塞原因',
      createdAt: at,
      updatedAt: at,
    });
    seedTaskRow(h, {
      id: 'open_risk',
      channelId: solo.id,
      title: '带未解除隐患的任务',
      status: 'draft',
      assignee: 'alice',
      riskNote: '隐患乙',
      createdAt: at,
      updatedAt: at,
    });
    seedTaskRow(h, {
      id: 'open_deferred',
      channelId: proj.id,
      title: '暂缓任务',
      status: 'draft',
      deferReason: '暂缓原因',
      createdAt: at,
      updatedAt: at,
    });
    seedTaskRow(h, {
      id: 'open_other',
      channelId: solo.id,
      title: '普通待办',
      status: 'pending',
      priority: 'P3',
      createdAt: at,
      updatedAt: at,
    });

    const material = internals(h.ctx.services.reports).collectMaterial(day.start, day.end);
    expect(material.text).toContain('## 生成时未结束任务（共 5 条，列出前 5 条）');
    // 已暂缓 / 阻塞 / 未解除隐患 / kind=suggestion / project 回落，一次覆盖。
    expect(material.text).toContain('（已暂缓）：暂缓原因');
    expect(material.text).toContain('（阻塞）：阻塞原因');
    expect(material.text).toContain('（带隐患：隐患乙）');
    expect(material.text).toContain('[blocked/P0/建议]');
    expect(material.text).toContain('（solo，负责人：未指派）');
    expect(material.text).toContain('（proj，负责人：agent-x）');
    expect(material.text).toContain('## 生成时运行环境');
    expect(material.text).toContain('活跃通道 2，其中最近有 MCP 活动 1；harness：online 1');
  });

  /**
   * 回归守卫（原 D-4）：report-service.ts 的抽样谓词曾写成 `rn % stride = 1`。
   * stride = MAX(1, ceil(total / 上限))，所以窗口内条目不超过上限时 stride=1，
   * `rn % 1` 恒为 0，永远选不中任何行——任务/卡片两段整段丢失，而且不报错。
   * 这里断言「未超上限时全量出现」，并且不再用 it.fails 包住前置条件：
   * 原来的写法在报告生成失败、prompt 为空时也会「通过」，守卫是假的。
   */
  it('未超过抽样上限时，任务与卡片素材应全部进入提示词', async () => {
    fake = await startFakeLlm();
    const h = createHarness();
    harness = h;
    configure(h, fake.base);
    const now = h.clock.now();
    const channel = h.ctx.services.channels.ensure({ channel_key: CHANNEL }, testCtx()).channel;

    h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '当天任务 A' }),
      testCtx(),
    );
    h.ctx.services.tasks.create(
      taskCreateSchema.parse({ channel_key: CHANNEL, title: '当天任务 B' }),
      testCtx(),
    );
    for (let i = 0; i < 3; i += 1) {
      seedCardRow(h, {
        id: `bug_card_${i}`,
        channelId: channel.id,
        type: 'info',
        title: `卡片${i}`,
        body: '正文',
        severity: 'info',
        createdAt: now,
      });
    }

    const run = h.ctx.services.reports.startPeriodUpdate(testCtx());
    await waitForIdle(h, run.id);
    const prompt = fake.requests[0]?.user ?? '';
    expect(prompt).not.toBe(''); // 先确认确实拿到了日报提示词

    // 按 `## ` 标题切段，避免「别的段落里也出现了标题文字」造成假阳性。
    const section = (heading: string): string => {
      const start = prompt.indexOf(heading);
      if (start < 0) return '';
      const rest = prompt.slice(start + heading.length);
      const next = rest.indexOf('\n## ');
      return next < 0 ? rest : rest.slice(0, next);
    };
    const taskSection = section('## 本周期有更新的任务');
    const cardSection = section('## 本周期卡片');
    expect(taskSection).not.toBe('');
    expect(cardSection).not.toBe('');

    // 未超上限 → 不该抽样，两条任务与三张卡片都必须具名出现。
    expect(taskSection).not.toContain('均匀抽样');
    expect(cardSection).not.toContain('均匀抽样');
    expect(taskSection).toContain('当天任务 A');
    expect(taskSection).toContain('当天任务 B');
    for (let i = 0; i < 3; i += 1) {
      expect(cardSection).toContain(`卡片${i}`);
    }
  });
});
