import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildTaskIdempotencyKey,
  resolveChannelWorkdir,
  validateSetupFlags,
} from '../src/channel-setup.js';
import { makeTempDir } from './helpers/cli.js';

test('--create-task / --channel-title / --task-description 依赖关系与通道 key 校验', () => {
  assert.throws(() => validateSetupFlags({ createTask: 'task' }), /--ensure-channel/);
  assert.throws(() => validateSetupFlags({ channelTitle: 'title' }), /--ensure-channel/);
  assert.throws(
    () => validateSetupFlags({ ensureChannel: 'host/proj/topic', taskDescription: 'body' }),
    /--create-task/,
  );
  assert.throws(() => validateSetupFlags({ ensureChannel: 'bad key' }), /ASCII/);
  assert.throws(
    () => validateSetupFlags({ ensureChannel: 'host/proj/topic', channelTitle: 'x'.repeat(201) }),
    /200/,
  );
  assert.doesNotThrow(() =>
    validateSetupFlags({
      ensureChannel: 'host/proj/topic',
      channelTitle: 'Demo',
      createTask: 'Initial task',
      taskDescription: 'body',
    }),
  );
});

test('任务幂等键由通道 + 标题决定，不含明文标题，且不超过 128', () => {
  const first = buildTaskIdempotencyKey('host/proj/topic', '标题');
  assert.equal(first, buildTaskIdempotencyKey('host/proj/topic', '标题'));
  assert.notEqual(first, buildTaskIdempotencyKey('host/proj/other', '标题'));
  assert.notEqual(first, buildTaskIdempotencyKey('host/proj/topic', '另一个标题'));
  assert.match(first, /^runner-create-[0-9a-f]{48}$/);
  assert.equal(first.includes('标题'), false);
  assert.ok(first.length <= 128);
});

test('通道 workdir：--cwd 优先，其次唯一配置 cwd，最后当前 cwd', () => {
  const base = path.resolve(makeTempDir('aidash-workdir-test-'));
  const other = path.resolve(makeTempDir('aidash-workdir-test-'));
  const configOne = { commands: [{ run: { cwd: base } }] };
  const configSame = { commands: [{ run: { cwd: base } }, { run: { cwd: base } }] };
  const configMixed = { commands: [{ run: { cwd: base } }, { run: { cwd: other } }] };

  assert.equal(resolveChannelWorkdir({ flags: { cwd: other }, config: configOne, cwd: base }), other);
  assert.equal(resolveChannelWorkdir({ flags: {}, config: configOne, cwd: other }), base);
  assert.equal(resolveChannelWorkdir({ flags: {}, config: configSame, cwd: other }), base);
  assert.equal(resolveChannelWorkdir({ flags: {}, config: configMixed, cwd: other }), other);
  assert.equal(resolveChannelWorkdir({ flags: {}, config: { commands: [] }, cwd: other }), other);
});
