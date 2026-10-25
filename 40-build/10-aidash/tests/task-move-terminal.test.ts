import { describe, expect, it } from 'vitest';
import { cardPostSchema, taskCreateSchema } from '../src/shared/schemas.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import { createHarness, testCtx, type TestHarness } from './helpers.js';

/**
 * task.move 的终态定案（任务 tk_01M5S0W61PRYKS60RHETNPSRHT）。
 *
 * 设计原意只允许移动 draft/pending/blocked；实测 move 不校验状态。
 * 本次选择“保留能力 + 留痕 + 文档登记偏差”，因此不改服务端，只用本文件锁住：
 * 1) done 任务可以换父节点；
 * 2) 移动不改变状态、完成时间、结束通知未读标记；
 * 3) task_event 里必须留下 moved，且 from_parent / to_parent 能还原移动轨迹。
 *
 * 独立成文件而不是塞进现有大文件：四个超长测试正在由另一路拆分，避免同文件冲突；
 * 也让这条“终态整理”契约有一个可单独定位的回归入口。
 */

const CHANNEL = 'devhost/terminal-move/topic';
const HARNESS_ID = 'h-terminal-move';

interface TaskEventRow {
  event: string;
  actor: string | null;
  detail_json: string | null;
  created_at: number;
}

function registerHarness(h: TestHarness): void {
  h.ctx.repos.harnesses.upsert({
    harness_id: HARNESS_ID,
    name: HARNESS_ID,
    host: null,
    capabilities_json: null,
    now: h.clock.now(),
  });
}

function createSubmittedTask(h: TestHarness, title: string) {
  return h.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: CHANNEL, title }),
    testCtx(),
    { submit: true },
  ).task;
}

/** 走完 claim → start → 证据卡 → complete，得到真正的 done 任务。 */
function completeTask(h: TestHarness, title: string) {
  const task = createSubmittedTask(h, title);
  const claim = h.ctx.services.tasks.claim(
    { task_id: task.id, harness_id: HARNESS_ID },
    testCtx(),
  );
  h.ctx.services.tasks.update(
    { task_id: task.id, event: 'start', claim_token: claim.claim_token },
    testCtx(),
  );

  // 完成前置条件：必须有一张关联到本任务的 status/artifact 证据卡。
  const evidence = h.ctx.services.cards.post(
    cardPostSchema.parse({
      channel_key: CHANNEL,
      type: 'status',
      task_id: task.id,
      summary: '已完成，允许后续整理位置',
      result: 'success',
    }) as CardPostInput,
    testCtx(),
  ).card;

  return h.ctx.services.tasks.update(
    {
      task_id: task.id,
      event: 'complete',
      claim_token: claim.claim_token,
      evidence_card_ids: [evidence.id],
    },
    testCtx(),
  );
}

describe('task.move 移动终态任务', () => {
  it('done 任务可移动；状态与完成时间不变，moved 事件的 from/to 可追溯', () => {
    const h = createHarness();
    try {
      registerHarness(h);
      const done = completeTask(h, '已完成但需要重新归位的任务');
      const parentA = createSubmittedTask(h, '整理目标 A');
      const parentB = createSubmittedTask(h, '整理目标 B');

      const completedAt = done.completed_at;
      expect(done.status).toBe('done');
      expect(completedAt).not.toBeNull();
      expect(done.parent_id).toBeNull();
      // 完成即产生结束通知；移动只是整理位置，不能替用户“已读”。
      expect(done.end_notice_pending).toBe(true);

      h.clock.advance(1_000);
      const firstMoveAt = h.clock.now();
      const movedToA = h.ctx.services.tasks.move(done.id, parentA.id, testCtx());

      expect(movedToA.status).toBe('done');
      expect(movedToA.parent_id).toBe(parentA.id);
      expect(movedToA.path).toBe(`${parentA.path}${done.id}/`);
      expect(movedToA.completed_at).toBe(completedAt);
      expect(movedToA.end_notice_pending).toBe(true);

      h.clock.advance(1_000);
      const secondMoveAt = h.clock.now();
      const movedToB = h.ctx.services.tasks.move(done.id, parentB.id, testCtx());

      expect(movedToB.status).toBe('done');
      expect(movedToB.parent_id).toBe(parentB.id);
      expect(movedToB.path).toBe(`${parentB.path}${done.id}/`);
      expect(movedToB.completed_at).toBe(completedAt);

      // 事件表是审计之外的业务时间线：即使任务行只保留“当前父节点”，
      // 也能从两次 moved 的 from_parent/to_parent 还原完整移动轨迹。
      const movedEvents = (h.ctx.repos.events.listTask(done.id) as TaskEventRow[])
        .filter((event) => event.event === 'moved')
        .sort((left, right) => left.created_at - right.created_at);

      expect(movedEvents).toHaveLength(2);
      expect(movedEvents.map((event) => event.actor)).toEqual(['tester', 'tester']);
      expect(movedEvents.map((event) => event.created_at)).toEqual([firstMoveAt, secondMoveAt]);
      expect(JSON.parse(movedEvents[0]!.detail_json!)).toEqual({
        from_parent: null,
        to_parent: parentA.id,
      });
      expect(JSON.parse(movedEvents[1]!.detail_json!)).toEqual({
        from_parent: parentA.id,
        to_parent: parentB.id,
      });
    } finally {
      h.close();
    }
  });
});
