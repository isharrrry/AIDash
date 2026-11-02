import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseAncestor, parseTask } from '../src/task-parse.js';
import { taskMarkdown, taskPayload, writeTaskFiles } from '../src/task-file.js';
import { buildStatusCard } from '../src/report.js';
import { makeTempDir } from './helpers/cli.js';

/**
 * 讨论任务的上下文解析、任务文件提示词与结论卡。
 *
 * 这些字段来自服务端不可信 JSON，且 task.md 是模型看到的第一手材料；
 * 解析收窄和提示词内容一旦回归，表现出来是“模型答非所问”，很难从日志定位。
 */

const tempDirs = [];
function tempDir() {
  const dir = makeTempDir('aidash-discussion-test-');
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/* --------------------------------- 解析上下文 -------------------------------- */

test('parseTask 解析父链上下文并丢弃非法条目', () => {
  const parsed = parseTask({
    id: 'tk_child',
    title: '子讨论',
    kind: 'discussion',
    parent_id: 'tk_parent',
    discussion_answer_md: '当前任务已有结论',
    ancestors: [
      {
        id: 'tk_root',
        title: '根问题',
        kind: 'discussion',
        status: 'done',
        depth: 2,
        description_md: '根描述',
        discussion_answer_md: '根结论',
        claim_token: '不该保留',
      },
      {
        id: 'tk_parent',
        title: '父问题',
        kind: 'task',
        status: 'done',
        depth: 1,
        description_md: null,
        discussion_answer_md: '父结论',
      },
      null,
      'bad-ancestor',
    ],
  });

  assert.equal(parsed.parent_id, 'tk_parent');
  assert.equal(parsed.discussion_answer_md, '当前任务已有结论');
  assert.equal(parsed.ancestors.length, 2);
  assert.deepEqual(parsed.ancestors, [
    {
      id: 'tk_root',
      title: '根问题',
      kind: 'discussion',
      status: 'done',
      depth: 2,
      description_md: '根描述',
      discussion_answer_md: '根结论',
    },
    {
      id: 'tk_parent',
      title: '父问题',
      kind: 'task',
      status: 'done',
      depth: 1,
      description_md: null,
      discussion_answer_md: '父结论',
    },
  ]);
  assert.equal('claim_token' in parsed.ancestors[0], false);
});

test('parseTask 对缺失/错误字段给安全默认值，ancestors 非数组时为空', () => {
  const parsed = parseTask({
    id: 'tk_x',
    parent_id: 42,
    discussion_answer_md: { answer: 'no' },
    ancestors: 'not-an-array',
  });
  assert.equal(parsed.parent_id, null);
  assert.equal(parsed.discussion_answer_md, null);
  assert.deepEqual(parsed.ancestors, []);

  // 缺 depth 时按根→直接父的顺序倒推：最后一项是直接父（1 层）。
  const fallback = parseTask({
    id: 'tk_y',
    ancestors: [{ title: '只有标题' }, { id: 'tk_parent' }],
  });
  assert.deepEqual(fallback.ancestors, [
    {
      id: '',
      title: '只有标题',
      kind: 'task',
      status: 'unknown',
      depth: 2,
      description_md: null,
      discussion_answer_md: null,
    },
    {
      id: 'tk_parent',
      title: 'tk_parent',
      kind: 'task',
      status: 'unknown',
      depth: 1,
      description_md: null,
      discussion_answer_md: null,
    },
  ]);
  assert.equal(parseAncestor(null), null);
  assert.equal(parseAncestor({ id: 'a' }, 3).depth, 3);
});

/* --------------------------------- task.json -------------------------------- */

test('taskPayload 带父链上下文但绝不写认领令牌/租约', () => {
  const task = {
    id: 'tk_child',
    channel_key: 'chan',
    title: '子任务',
    description_md: '正文',
    kind: 'discussion',
    status: 'claimed',
    priority: 'P1',
    tags: [],
    due_at: null,
    assignee: 'watch-1',
    claim_token: 'claim-secret',
    claim_expires_at: '2099-01-01T00:00:00.000Z',
    lease_expires_at: '2099-01-01T00:00:00.000Z',
    parent_id: 'tk_parent',
    ancestors: [
      {
        id: 'tk_parent',
        title: '父任务',
        kind: 'discussion',
        status: 'done',
        depth: 1,
        description_md: '父描述',
        discussion_answer_md: '父结论',
        claim_token: 'nested-claim-secret',
      },
    ],
  };

  const payload = taskPayload(task);
  assert.equal(payload.parent_id, 'tk_parent');
  assert.deepEqual(payload.ancestors, [
    {
      id: 'tk_parent',
      title: '父任务',
      kind: 'discussion',
      status: 'done',
      depth: 1,
      description_md: '父描述',
      discussion_answer_md: '父结论',
    },
  ]);
  assert.equal('claim_token' in payload, false);
  assert.equal('claim_expires_at' in payload, false);
  assert.equal('lease_expires_at' in payload, false);
  assert.equal('claim_token' in payload.ancestors[0], false);
  assert.equal(JSON.stringify(payload).includes('claim-secret'), false);

  // 老服务端/普通任务没有父链时必须是稳定默认值，而不是 undefined。
  const bare = taskPayload({ id: 'tk_bare' });
  assert.equal(bare.parent_id, null);
  assert.deepEqual(bare.ancestors, []);
});

test('writeTaskFiles 同时把上下文写进 task.json 与 task.md', () => {
  const baseDir = tempDir();
  const task = {
    id: 'tk_child',
    channel_key: 'chan',
    title: '该不该上队列',
    kind: 'discussion',
    priority: 'P1',
    tags: ['arch'],
    description_md: '当前问题正文',
    parent_id: 'tk_parent',
    ancestors: [
      {
        id: 'tk_parent',
        title: '父问题',
        kind: 'discussion',
        status: 'done',
        depth: 1,
        description_md: '父描述',
        discussion_answer_md: '父结论',
      },
    ],
  };
  const files = writeTaskFiles(task, { baseDir });
  try {
    const payload = JSON.parse(fs.readFileSync(files.jsonPath, 'utf8'));
    assert.equal(payload.parent_id, 'tk_parent');
    assert.equal(payload.ancestors[0].discussion_answer_md, '父结论');
    assert.equal('claim_token' in payload, false);

    const markdown = fs.readFileSync(files.mdPath, 'utf8');
    assert.match(markdown, /## 讨论任务/);
    assert.match(markdown, /## 父级讨论上下文/);
    assert.match(markdown, /父结论/);
  } finally {
    files.cleanup();
  }
  assert.equal(fs.existsSync(files.dir), false);
});

/* ---------------------------------- task.md --------------------------------- */

test('taskMarkdown：讨论提示 + 父级上下文按根→父顺序渲染', () => {
  const markdown = taskMarkdown({
    id: 'tk_child',
    channel_key: 'chan',
    title: '该不该上队列',
    kind: 'discussion',
    priority: 'P1',
    tags: [],
    description_md: '当前问题正文',
    ancestors: [
      {
        id: 'tk_root',
        title: '最初的根问题',
        kind: 'discussion',
        status: 'done',
        depth: 2,
        description_md: '根描述正文',
        discussion_answer_md: '根结论正文',
      },
      {
        id: 'tk_parent',
        title: '直接父问题',
        kind: 'task',
        status: 'done',
        depth: 1,
        description_md: '父描述正文',
        discussion_answer_md: null,
      },
    ],
  });

  assert.match(markdown, /- 类型: 讨论/);
  assert.match(markdown, /## 讨论任务/);
  assert.match(markdown, /大白话/);
  assert.match(markdown, /不要跑工程命令/);
  assert.match(markdown, /讨论结论/);
  assert.match(markdown, /下级讨论任务的父级上下文/);
  assert.match(markdown, /result_file/);
  assert.match(markdown, /## 父级讨论上下文/);

  // 顺序：讨论提示 → 父级上下文（根在前）→ 当前描述。
  assert.ok(markdown.indexOf('## 讨论任务') < markdown.indexOf('## 父级讨论上下文'));
  assert.ok(markdown.indexOf('## 父级讨论上下文') < markdown.indexOf('## 描述'));
  assert.ok(markdown.indexOf('最初的根问题') < markdown.indexOf('直接父问题'));
  assert.match(markdown, /距离当前任务: 2 层/);
  assert.match(markdown, /距离当前任务: 1 层/);
  assert.match(markdown, /根描述正文/);
  assert.match(markdown, /父描述正文/);
  assert.equal(markdown.includes('**上级结论**：\n\n根结论正文'), true);
  assert.equal(markdown.includes('**上级结论**：\n\n父结论'), false);
});

test('taskMarkdown：非讨论任务不出现讨论提示，类型标签正确', () => {
  const normal = taskMarkdown({
    id: 'tk_normal',
    title: '普通任务',
    kind: 'task',
    tags: [],
    description_md: '正文',
  });
  assert.match(normal, /- 类型: 任务/);
  assert.equal(normal.includes('## 讨论任务'), false);
  assert.equal(normal.includes('## 父级讨论上下文'), false);
  assert.match(normal, /## 描述/);

  const suggestion = taskMarkdown({ id: 'tk_s', title: '建议', kind: 'suggestion', tags: [] });
  assert.match(suggestion, /- 类型: 建议/);
});

/* ---------------------------------- 结论卡 ---------------------------------- */

function discussionCard(overrides = {}) {
  return buildStatusCard({
    task: {
      id: 'tk_discussion',
      channel_key: 'chan',
      title: '该不该换框架',
      priority: 'P1',
      kind: 'discussion',
    },
    argv: ['node', 'run.js', '--should-not-appear'],
    cwd: '/work',
    execResult: {
      started: true,
      exitCode: 0,
      signal: null,
      durationMs: 1234,
      timedOut: false,
      spawnError: null,
      output: 'COMMAND-OUTPUT-SHOULD-NOT-APPEAR',
      stderrTail: 'STDERR-TAIL-SHOULD-NOT-APPEAR',
    },
    resultFile: {
      summary: '结论：先别换',
      detail_md: '## 结论\n\n先别换框架，迁移成本大于收益。',
      result: 'success',
    },
    logFile: '/logs/should-not-appear.log',
    idempotencyKey: 'runner-key',
    result: 'success',
    ...overrides,
  });
}

test('discussion 结论卡只放回答，不拼命令/退出码/输出尾巴', () => {
  const card = discussionCard();
  assert.equal(card.type, 'status');
  assert.equal(card.task_id, 'tk_discussion');
  assert.equal(card.title, '讨论「该不该换框架」的结论');
  assert.equal(card.priority, 'P1');
  assert.equal(card.result, 'success');
  assert.equal(card.summary, '结论：先别换');
  assert.equal(card.detail_md, '## 结论\n\n先别换框架，迁移成本大于收益。');
  assert.equal(card.detail_md.includes('node run.js'), false);
  assert.equal(card.detail_md.includes('退出码'), false);
  assert.equal(card.detail_md.includes('COMMAND-OUTPUT'), false);
  assert.equal(card.detail_md.includes('STDERR-TAIL'), false);
  assert.equal(card.detail_md.includes('/logs/'), false);
  assert.equal(card.idempotency_key, 'runner-key');
});

test('discussion 结论卡 detail 为空回退 summary；标题截断到 200', () => {
  const card = discussionCard({
    task: {
      id: 'tk_discussion',
      channel_key: 'chan',
      title: '长'.repeat(300),
      priority: 'P2',
      kind: 'discussion',
    },
    resultFile: { summary: '只有一句话结论', detail_md: '   ', result: 'success' },
  });
  assert.equal(card.detail_md, '只有一句话结论');
  assert.equal(card.summary, '只有一句话结论');
  assert.ok(card.title.length <= 200);
  assert.ok(card.title.startsWith('讨论「'));

  // result_file 完全缺失时也不能退回命令日志，summary 用状态兜底。
  const noFile = discussionCard({ resultFile: null, result: 'failed' });
  assert.equal(noFile.summary, '讨论任务失败');
  assert.equal(noFile.detail_md, '');
});

test('非 discussion 卡片保持原有命令日志格式', () => {
  const card = discussionCard({
    task: { id: 'tk_normal', channel_key: 'chan', title: '普通任务', priority: 'P2', kind: 'task' },
    resultFile: null,
  });
  assert.equal(card.title, '任务 tk_normal 执行成功');
  assert.match(card.summary, /命令执行成功/);
  assert.match(card.detail_md, /### 命令/);
  assert.match(card.detail_md, /node run\.js/);
  assert.match(card.detail_md, /退出码：0/);
  assert.match(card.detail_md, /\/logs\/should-not-appear\.log/);
  assert.match(card.detail_md, /COMMAND-OUTPUT-SHOULD-NOT-APPEAR/);
});
