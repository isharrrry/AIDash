import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cardPostSchema, taskCreateSchema } from '../src/shared/schemas.js';
import type { TaskAncestorView, TaskView, TreeNode } from '../src/shared/types.js';
import type { CardPostInput } from '../src/server/services/card-service.js';
import type { TaskUpdateInput } from '../src/server/services/task-service.js';
import { openDb } from '../src/server/db/connection.js';
import { migrate } from '../src/server/db/migrate.js';
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
import { expectAppError } from './fakes/core-fixtures.js';

const CHANNEL = 'devhost/discussion/topic';
const HARNESS_ID = 'h-discussion';
let rpcId = 0;

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

async function callTool(
  app: RunningApp,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const payload = await mcp(app, {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return mcpToolData(payload);
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

function createTask(
  h: TestHarness,
  input: Record<string, unknown>,
  submit = true,
): TaskView {
  return h.ctx.services.tasks.create(
    taskCreateSchema.parse({ channel_key: CHANNEL, ...input }),
    testCtx(),
    { submit },
  ).task;
}

function claimTask(h: TestHarness, taskId: string) {
  return h.ctx.services.tasks.claim({ task_id: taskId, harness_id: HARNESS_ID }, testCtx());
}

/** 走完 claim → start → 证据卡，返回可用于 complete 的令牌与证据卡 id。 */
function prepareCompletion(
  h: TestHarness,
  taskId: string,
): { claimToken: string; evidenceIds: string[] } {
  const claim = claimTask(h, taskId);
  h.ctx.services.tasks.update(
    { task_id: taskId, event: 'start', claim_token: claim.claim_token },
    testCtx(),
  );
  const evidence = h.ctx.services.cards.post(
    cardPostSchema.parse({
      channel_key: CHANNEL,
      type: 'status',
      task_id: taskId,
      summary: '讨论已完成',
      result: 'success',
    }) as CardPostInput,
    testCtx(),
  ).card;
  return { claimToken: claim.claim_token, evidenceIds: [evidence.id] };
}

function completeTask(h: TestHarness, taskId: string, answerMd?: string): TaskView {
  const { claimToken, evidenceIds } = prepareCompletion(h, taskId);
  const input: TaskUpdateInput = {
    task_id: taskId,
    event: 'complete',
    claim_token: claimToken,
    evidence_card_ids: evidenceIds,
  };
  if (answerMd !== undefined) input.answer_md = answerMd;
  return h.ctx.services.tasks.update(input, testCtx());
}

describe('讨论任务', () => {
  it('迁移 018 给 task 表增加 discussion_answer_md / discussion_answered_at', () => {
    const h = createHarness();
    try {
      const columns = h.db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('discussion_answer_md');
      expect(columns.map((column) => column.name)).toContain('discussion_answered_at');
    } finally {
      h.close();
    }
  });

  it('REST 创建 discussion 任务，list/tree 保留 kind', async () => {
    const h = createHarness();
    const app = await startApp(h);
    try {
      const created = await api<{ task: TaskView }>(app, 'POST', '/api/tasks', {
        channel_key: CHANNEL,
        title: 'REST 讨论任务',
        kind: 'discussion',
        submit: true,
      });
      expect(created.status).toBe(201);
      expect(created.body.data?.task.kind).toBe('discussion');
      expect(created.body.data?.task.status).toBe('pending');

      const taskId = created.body.data!.task.id;
      const listed = await api<{ items: TaskView[] }>(
        app,
        'GET',
        `/api/tasks?channel_key=${encodeURIComponent(CHANNEL)}`,
      );
      expect(listed.body.data?.items.find((item) => item.id === taskId)?.kind).toBe('discussion');

      const tree = await api<TreeNode[]>(
        app,
        'GET',
        `/api/tasks/tree?channel_key=${encodeURIComponent(CHANNEL)}`,
      );
      expect(flatten(tree.body.data ?? []).find((node) => node.id === taskId)?.kind).toBe(
        'discussion',
      );
    } finally {
      await app.close();
      h.close();
    }
  });

  it('MCP task.create 支持 discussion，task.list/task.tree 保留 kind', async () => {
    const h = createHarness();
    const app = await startApp(h);
    try {
      const created = (await callTool(app, 'task.create', {
        channel_key: CHANNEL,
        title: 'MCP 讨论任务',
        kind: 'discussion',
        submit: true,
      })) as { task: TaskView };
      expect(created.task.kind).toBe('discussion');

      const listed = (await callTool(app, 'task.list', {
        channel_key: CHANNEL,
      })) as { items: TaskView[] };
      expect(listed.items.find((item) => item.id === created.task.id)?.kind).toBe('discussion');

      const tree = (await callTool(app, 'task.tree', { channel_key: CHANNEL })) as TreeNode[];
      expect(flatten(tree).find((node) => node.id === created.task.id)?.kind).toBe('discussion');
    } finally {
      await app.close();
      h.close();
    }
  });

  it('complete 带 answer_md 写入结论与 answered_at；空串视为未提供', () => {
    const h = createHarness();
    try {
      registerHarness(h);
      const discussion = createTask(h, { title: '要结论的讨论', kind: 'discussion' });
      h.clock.advance(1_000);
      const answer = '## 结论\n\n先回滚，再补白名单。';
      const completed = completeTask(h, discussion.id, `  ${answer}  `);

      expect(completed.status).toBe('done');
      expect(completed.discussion_answer_md).toBe(answer);
      expect(completed.discussion_answered_at).toBe(
        new Date(h.clock.now()).toISOString(),
      );
      const raw = h.ctx.repos.tasks.get(discussion.id)!;
      expect(raw.discussion_answer_md).toBe(answer);
      expect(raw.discussion_answered_at).toBe(h.clock.now());

      // 空串/纯空白按“没提供”处理：不产生空结论，也不写时间。
      const blank = createTask(h, { title: '空结论讨论', kind: 'discussion' });
      const blankDone = completeTask(h, blank.id, '   ');
      expect(blankDone.discussion_answer_md).toBeNull();
      expect(blankDone.discussion_answered_at).toBeNull();
    } finally {
      h.close();
    }
  });

  it('非讨论任务或非 complete 事件传 answer_md 被拒绝', () => {
    const h = createHarness();
    try {
      registerHarness(h);

      const normal = createTask(h, { title: '普通任务' });
      const { claimToken, evidenceIds } = prepareCompletion(h, normal.id);
      expectAppError(
        () =>
          h.ctx.services.tasks.update(
            {
              task_id: normal.id,
              event: 'complete',
              claim_token: claimToken,
              evidence_card_ids: evidenceIds,
              answer_md: '普通任务不该有这个',
            },
            testCtx(),
          ),
        'INVALID_ARGUMENT',
        'ANSWER_NOT_DISCUSSION',
      );
      // 拒绝发生在写库之前：任务仍在执行中，结论列保持为空。
      const normalAfter = h.ctx.repos.tasks.get(normal.id)!;
      expect(normalAfter.status).toBe('in_progress');
      expect(normalAfter.discussion_answer_md).toBeNull();

      const draft = createTask(h, { title: '草稿讨论', kind: 'discussion' }, false);
      expectAppError(
        () =>
          h.ctx.services.tasks.update(
            { task_id: draft.id, event: 'submit', answer_md: '结论不能跳过 complete' },
            testCtx(),
          ),
        'INVALID_ARGUMENT',
        'ANSWER_REQUIRES_COMPLETE',
      );
    } finally {
      h.close();
    }
  });

  it('claim 响应带 ancestors：根→父顺序、depth、父讨论结论与描述截断', () => {
    const h = createHarness();
    try {
      registerHarness(h);
      const longDescription = 'x'.repeat(6_001);
      const root = createTask(h, { title: '根讨论', kind: 'discussion' });
      const rootAnswer = '根讨论的结论：先复现再定位。';
      completeTask(h, root.id, rootAnswer);
      const parent = createTask(h, {
        title: '中间讨论',
        kind: 'discussion',
        parent_id: root.id,
        description_md: longDescription,
      });
      const target = createTask(h, {
        title: '子讨论',
        kind: 'discussion',
        parent_id: parent.id,
      });

      const claimed = claimTask(h, target.id);
      const ancestors = claimed.task.ancestors as TaskAncestorView[];
      expect(ancestors.map((ancestor) => ancestor.id)).toEqual([root.id, parent.id]);
      expect(ancestors.map((ancestor) => ancestor.depth)).toEqual([2, 1]);
      expect(ancestors[0].discussion_answer_md).toBe(rootAnswer);
      expect(ancestors[1].discussion_answer_md).toBeNull();
      // 描述超过 6000 字符时只保留前 6000，避免父链把 base64 全文带进提示词。
      expect(ancestors[1].description_md).toHaveLength(6_000);
      expect(ancestors[1].description_md).toBe(longDescription.slice(0, 6_000));
    } finally {
      h.close();
    }
  });

  it('GET /api/tasks/:id 带 ancestors 与完整结论，list/tree 默认不带', async () => {
    const h = createHarness();
    const app = await startApp(h);
    try {
      registerHarness(h);
      const root = createTask(h, { title: '父讨论', kind: 'discussion' });
      const answer = '父讨论结论：按方案 A 执行。';
      completeTask(h, root.id, answer);
      const child = createTask(h, {
        title: '子讨论',
        kind: 'discussion',
        parent_id: root.id,
      });

      const detail = await api<TaskView>(app, 'GET', `/api/tasks/${child.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data?.ancestors?.map((ancestor) => ancestor.id)).toEqual([root.id]);
      expect(detail.body.data?.ancestors?.[0].discussion_answer_md).toBe(answer);

      // 详情默认带完整结论；列表/树为了轮询体积默认投影成 null。
      const rootDetail = await api<TaskView>(app, 'GET', `/api/tasks/${root.id}`);
      expect(rootDetail.body.data?.discussion_answer_md).toBe(answer);

      const listed = await api<{ items: TaskView[] }>(
        app,
        'GET',
        `/api/tasks?channel_key=${encodeURIComponent(CHANNEL)}`,
      );
      const listRoot = listed.body.data?.items.find((item) => item.id === root.id);
      expect(listRoot?.discussion_answer_md).toBeNull();
      expect(listRoot && 'ancestors' in listRoot).toBe(false);

      const tree = await api<TreeNode[]>(
        app,
        'GET',
        `/api/tasks/tree?channel_key=${encodeURIComponent(CHANNEL)}`,
      );
      const treeRoot = flatten(tree.body.data ?? []).find((node) => node.id === root.id);
      expect(treeRoot?.discussion_answer_md).toBeNull();
      expect(treeRoot && 'ancestors' in treeRoot).toBe(false);
    } finally {
      await app.close();
      h.close();
    }
  });

  it('MCP task.get 返回单任务详情与 ancestors', async () => {
    const h = createHarness();
    const app = await startApp(h);
    try {
      const parent = createTask(h, { title: 'MCP 父任务', kind: 'discussion' });
      const child = createTask(h, {
        title: 'MCP 子任务',
        kind: 'discussion',
        parent_id: parent.id,
      });

      const fetched = (await callTool(app, 'task.get', { task_id: child.id })) as TaskView;
      expect(fetched.id).toBe(child.id);
      expect(fetched.kind).toBe('discussion');
      expect(fetched.ancestors?.map((ancestor) => ancestor.id)).toEqual([parent.id]);
      expect(fetched.ancestors?.[0].depth).toBe(1);
    } finally {
      await app.close();
      h.close();
    }
  });
});

const BOOTSTRAP = fileURLToPath(
  new URL('../src/server/db/migrations/000_bootstrap.sql', import.meta.url),
);

interface MigrationProbe {
  dir: string;
  db: ReturnType<typeof openDb>;
}

function makeMigrationProbe(sql: string): MigrationProbe {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidash-discussion-mig-'));
  fs.copyFileSync(BOOTSTRAP, path.join(dir, '000_bootstrap.sql'));
  fs.writeFileSync(path.join(dir, '900_probe.sql'), sql, 'utf8');
  const db = openDb(':memory:');
  return { dir, db };
}

function closeProbe(probe: MigrationProbe): void {
  probe.db.close();
  fs.rmSync(probe.dir, { recursive: true, force: true });
}

function probeChecksum(probe: MigrationProbe): string {
  return (
    probe.db
      .prepare('SELECT checksum FROM schema_migration WHERE version = 900')
      .get() as { checksum: string }
  ).checksum;
}

describe('迁移 checksum 换行归一', () => {
  it('同一 SQL 的 LF 与 CRLF 版本得到相同 checksum，CRLF 源码可匹配已应用的 LF 记录', () => {
    const lf = 'CREATE TABLE mig_lf_probe(x INTEGER);\nCREATE INDEX idx_lf_probe ON mig_lf_probe(x);\n';
    const crlf = lf.replace(/\n/g, '\r\n');

    const lfProbe = makeMigrationProbe(lf);
    const crlfProbe = makeMigrationProbe(crlf);
    try {
      migrate(lfProbe.db, { migrationsDir: lfProbe.dir });
      migrate(crlfProbe.db, { migrationsDir: crlfProbe.dir });
      expect(probeChecksum(crlfProbe)).toBe(probeChecksum(lfProbe));

      // 部署实际场景：库里已有 LF 时代写入的 checksum，换成 CRLF 检出后再次启动应跳过而非报错。
      fs.writeFileSync(path.join(lfProbe.dir, '900_probe.sql'), crlf, 'utf8');
      expect(() => migrate(lfProbe.db, { migrationsDir: lfProbe.dir })).not.toThrow();

      // 归一只忽略换行风格；SQL 内容变化仍必须被 checksum 拦下。
      fs.writeFileSync(
        path.join(crlfProbe.dir, '900_probe.sql'),
        crlf.replace('CREATE INDEX', 'CREATE INDEX changed'),
        'utf8',
      );
      expectAppError(
        () => migrate(crlfProbe.db, { migrationsDir: crlfProbe.dir }),
        'INTERNAL',
        'MIGRATION_CHECKSUM_MISMATCH',
      );
    } finally {
      closeProbe(lfProbe);
      closeProbe(crlfProbe);
    }
  });
});
