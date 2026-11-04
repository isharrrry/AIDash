import test from 'node:test';
import assert from 'node:assert/strict';
import { HARNESS_TEMPLATES, TASK_PROMPT, getTemplate } from '../src/templates.js';

test('模板覆盖 claude/codex/dsh/narnat/custom', () => {
  assert.deepEqual(
    HARNESS_TEMPLATES.map((item) => item.key),
    ['claude', 'codex', 'dsh', 'narnat', 'custom'],
  );
});

test('每个模板都把任务文件与结果文件交给 harness', () => {
  for (const template of HARNESS_TEMPLATES) {
    assert.ok(template.argv.length > 0, `${template.key} argv 为空`);
    assert.ok(template.argv.some((arg) => arg.includes('{task_file}')), `${template.key} 缺少 {task_file}`);
    assert.ok(template.argv.some((arg) => arg.includes('{result_file}')), `${template.key} 缺少 {result_file}`);
    assert.ok(template.result_file.includes('{task_file_dir}'), `${template.key} result_file 未按任务隔离`);
    assert.ok(template.name && template.description && template.install_hint);
  }
  assert.ok(TASK_PROMPT.includes('{task_file}'));
  assert.ok(TASK_PROMPT.includes('{result_file}'));
});

test('各 CLI 的关键非交互参数没有漂移', () => {
  assert.deepEqual(getTemplate('claude').argv.slice(0, 2), ['claude', '--dangerously-skip-permissions']);
  assert.deepEqual(getTemplate('codex').argv.slice(0, 2), ['codex', 'exec']);
  assert.deepEqual(getTemplate('dsh').argv.slice(0, 3), ['dsh', '--profile', 'headless']);
  assert.deepEqual(getTemplate('narnat').argv.slice(0, 2), ['narnat', '-p']);
  assert.equal(getTemplate('nope'), null);
});

test('dsh/narnat 模板说明与官方帮助一致', () => {
  const dsh = getTemplate('dsh');
  assert.ok(dsh.notes.some((note) => note.includes('dsh headless')));
  assert.match(dsh.credential_hint, /\.credentials\.yaml/);

  const narnat = getTemplate('narnat');
  assert.ok(narnat.notes.some((note) => note.includes('--goal-rounds')));
  assert.ok(narnat.notes.some((note) => note.includes('[NN_DONE]')));
  assert.match(narnat.notes.join('\n'), /Linux/);
  assert.match(narnat.credential_hint, /NARNAT_HOME/);
});
