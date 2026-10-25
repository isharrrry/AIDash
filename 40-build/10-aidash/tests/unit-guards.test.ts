import { describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { normalizeCardResult } from '../src/shared/schemas.js';
import { assertSafeUrl, findSecret } from '../src/shared/secrets.js';
import { ManualClock } from '../src/shared/time.js';
import type { Task } from '../src/shared/types.js';
import { openDb } from '../src/server/db/connection.js';
import { migrate } from '../src/server/db/migrate.js';
import { AuditRepo, segmentCjk } from '../src/server/repos/support-repos.js';
import { safeJoin } from '../src/server/services/kb-service.js';
import {
  assertClaimToken,
  assertTaskTransition,
  cancelNeedsToken,
} from '../src/server/services/state-machine.js';

function task(status: Task['status'], patch: Partial<Task> = {}): Task {
  return {
    id: 'tk_test',
    channel_id: 'ch_test',
    parent_id: null,
    path: '/tk_test/',
    title: 't',
    description_md: null,
    status,
    priority: 'P2',
    assignee: null,
    tags_json: null,
    due_at: null,
    claimed_by: 'h1',
    claim_token: 'cl_secret',
    claim_expires_at: 10_000,
    started_at: null,
    blocked_reason: null,
    fail_reason: null,
    cancel_reason: null,
    evidence_json: null,
    idempotency_key: null,
    created_by: 'tester',
    created_at: 1,
    updated_at: 1,
    ...patch,
  };
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('expected function to throw');
}

describe('任务状态机', () => {
  it('允许合法迁移并返回目标状态', () => {
    expect(assertTaskTransition(task('draft'), 'submit')).toBe('pending');
    expect(assertTaskTransition(task('claimed'), 'start')).toBe('in_progress');
    expect(assertTaskTransition(task('in_progress'), 'block')).toBe('blocked');
    expect(assertTaskTransition(task('blocked'), 'unblock')).toBe('in_progress');
    expect(assertTaskTransition(task('in_progress'), 'complete')).toBe('done');
    expect(assertTaskTransition(task('in_progress'), 'fail')).toBe('failed');
  });

  it('拒绝跳级与非法迁移', () => {
    expect(errorCode(() => assertTaskTransition(task('draft'), 'complete'))).toBe('CONFLICT');
    expect(errorCode(() => assertTaskTransition(task('done'), 'start'))).toBe('CONFLICT');
    expect(errorCode(() => assertTaskTransition(task('pending'), 'block'))).toBe('CONFLICT');
  });

  it('认领令牌缺失/不匹配分别报错', () => {
    expect(errorCode(() => assertClaimToken(task('claimed'), undefined))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(errorCode(() => assertClaimToken(task('claimed'), 'wrong'))).toBe('FORBIDDEN');
    expect(() => assertClaimToken(task('claimed'), 'cl_secret')).not.toThrow();
  });

  it('只有已认领状态取消才需要令牌', () => {
    expect(cancelNeedsToken('pending')).toBe(false);
    expect(cancelNeedsToken('claimed')).toBe(true);
    expect(cancelNeedsToken('in_progress')).toBe(true);
  });
});

describe('输入安全', () => {
  it('识别令牌与密码模式但不回显原文', () => {
    expect(findSecret('api_key: abcdefghijklmnop123')).toBe('generic_token');
    expect(findSecret('sk-abcdefghijklmnopqrstuv')).toBe('openai_key');
    expect(findSecret('普通文本')).toBeNull();
  });

  it('链接协议白名单拦住 javascript:', () => {
    expect(errorCode(() => assertSafeUrl('javascript:alert(1)'))).toBe('INVALID_ARGUMENT');
    expect(errorCode(() => assertSafeUrl('//evil.com/x'))).toBe('INVALID_ARGUMENT');
    expect(() => assertSafeUrl('https://example.com/a')).not.toThrow();
    expect(() => assertSafeUrl('wiki/页面.md', { allowFile: true })).not.toThrow();
  });

  it('知识库路径不能越出根目录', () => {
    expect(errorCode(() => safeJoin('/srv/kb', '../etc/passwd'))).toBe('INVALID_ARGUMENT');
    expect(errorCode(() => safeJoin('/srv/kb', '/etc/passwd'))).toBe('INVALID_ARGUMENT');
    expect(safeJoin('/srv/kb', 'docs/a.md')).toContain('docs');
  });

  it('中文按字切分，保留英文单词', () => {
    expect(segmentCjk('登录失败')).toBe('登 录 失 败');
    expect(segmentCjk('SSO 登录')).toBe('SSO 登 录');
  });

  it('历史 ok/fail 归一化为新枚举', () => {
    expect(normalizeCardResult('ok')).toBe('success');
    expect(normalizeCardResult('fail')).toBe('failed');
    expect(normalizeCardResult('PARTIAL')).toBe('partial');
    expect(normalizeCardResult('unknown')).toBeNull();
  });
});

describe('审计哈希链', () => {
  it('连续追加后校验通过，并能按结果过滤', () => {
    const db = openDb(':memory:');
    migrate(db);
    const clock = new ManualClock();
    const repo = new AuditRepo(db);
    const base = {
      actor_label: 'tester',
      object_type: 'card',
      object_id: 'cd_1',
      request_id: null,
      detail_json: null,
    };
    repo.append({ ...base, ts: clock.now(), action: 'a', result: 'ok' });
    repo.append({ ...base, ts: clock.now(), action: 'b', result: 'denied' });

    expect(repo.verifyChain().ok).toBe(true);
    expect(repo.list({ result: 'denied' }).total).toBe(1);
    expect(repo.lastHash()).toMatch(/^[a-f0-9]{64}$/);
    db.close();
  });
});
