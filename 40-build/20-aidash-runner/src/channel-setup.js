import path from 'node:path';
import { BusinessError, ConfigError } from './errors.js';
import { selectRule, skipReasons } from './match.js';
import { parseCreatedTask } from './task-parse.js';
import { asRecord, asString, resolvePath, sha256Hex } from './util.js';

/**
 * 启动时的“精确通道 + 初始化任务”。
 *
 * 与 --channel 的区别：
 * - --channel 是已有的匹配过滤器（支持 * / prefix/*），只影响“认领哪些任务”；
 * - --ensure-channel 是副作用：用精确 channel_key 调一次 channel.upsert，创建或复用通道。
 *
 * 任务用确定性 idempotency_key（通道 + 标题）防重复：同一通道同一标题重复启动
 * 会拿回同一任务，即使那个任务已经完成。要建新任务请换标题。
 */

export const CHANNEL_KEY_PATTERN = /^[A-Za-z0-9._~:/-]+$/;
const MAX_CHANNEL_KEY = 200;
const MAX_TITLE = 200;
const MAX_WORKDIR = 500;
const MAX_TASK_DESCRIPTION = 2_000_000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 本地先校验，避免把明显错误发到服务端再靠业务错误排障。 */
export function validateSetupFlags(flags = {}) {
  const ensureChannel = text(flags.ensureChannel);
  const channelTitle = flags.channelTitle === undefined ? undefined : text(flags.channelTitle);
  const createTask = flags.createTask === undefined ? undefined : text(flags.createTask);
  const taskDescription = flags.taskDescription === undefined ? undefined : String(flags.taskDescription);

  if (flags.channelTitle !== undefined && !ensureChannel) {
    throw new ConfigError('--channel-title 必须配合 --ensure-channel 使用');
  }
  if (flags.createTask !== undefined && !ensureChannel) {
    throw new ConfigError('--create-task 必须配合 --ensure-channel 使用：任务需要归属到精确通道');
  }
  if (flags.taskDescription !== undefined && flags.createTask === undefined) {
    throw new ConfigError('--task-description 必须配合 --create-task 使用');
  }
  if (ensureChannel) {
    if (ensureChannel.length > MAX_CHANNEL_KEY || !CHANNEL_KEY_PATTERN.test(ensureChannel)) {
      throw new ConfigError(
        `--ensure-channel 必须是 1..${MAX_CHANNEL_KEY} 位 ASCII，且不含空白：${ensureChannel}`,
      );
    }
  }
  if (channelTitle !== undefined) {
    if (!channelTitle) throw new ConfigError('--channel-title 不能为空');
    if (channelTitle.length > MAX_TITLE) throw new ConfigError(`--channel-title 不能超过 ${MAX_TITLE} 字符`);
  }
  if (createTask !== undefined) {
    if (!createTask) throw new ConfigError('--create-task 不能为空');
    if (createTask.length > MAX_TITLE) throw new ConfigError(`--create-task 不能超过 ${MAX_TITLE} 字符`);
  }
  if (taskDescription !== undefined && taskDescription.length > MAX_TASK_DESCRIPTION) {
    throw new ConfigError(`--task-description 不能超过 ${MAX_TASK_DESCRIPTION} 字符`);
  }
}

/**
 * 通道 workdir 的取值顺序：显式 --cwd > 配置里唯一/一致的 run.cwd > runner 当前 cwd。
 * 相对路径在 --cwd 这一层按“启动时的 cwd”解析；配置里的 run.cwd 已在配置加载时解析。
 */
export function resolveChannelWorkdir({ flags = {}, config, cwd = process.cwd() }) {
  let workdir;
  if (flags.cwd) {
    workdir = resolvePath(flags.cwd, cwd);
  } else {
    const configured = new Set(
      (config.commands ?? [])
        .map((rule) => rule.run?.cwd)
        .filter(Boolean)
        .map((item) => path.resolve(item)),
    );
    workdir = configured.size === 1 ? [...configured][0] : path.resolve(cwd);
  }
  const resolved = path.resolve(workdir);
  if (resolved.length > MAX_WORKDIR) {
    throw new ConfigError(`通道 workdir 超过 ${MAX_WORKDIR} 字符：${resolved}`);
  }
  return resolved;
}

/** 确定性幂等键：只含哈希，不含标题/令牌，长度远小于服务端 128 上限。 */
export function buildTaskIdempotencyKey(channelKey, title) {
  // channel_key 的字符集不含 |，用它做无歧义分隔，避免拼接串碰撞。
  return `runner-create-${sha256Hex(`${channelKey}|${title}`).slice(0, 48)}`;
}

function parseChannelUpsert(value) {
  const root = asRecord(value);
  const record = asRecord(root?.data) ?? root;
  if (!record) throw new BusinessError('INVALID_ARGUMENT', 'channel.upsert 返回格式不符：期望 JSON 对象');
  return {
    channel_key: asString(record.channel_key) ?? '',
    created: record.created === true,
    restored: record.restored === true,
  };
}

function warnIfTaskNotClaimable({ task, config, logger }) {
  if (!task || !['pending', 'draft'].includes(task.status)) return;
  const reasons = skipReasons(task, config);
  if (reasons.length === 0 && selectRule(task, config.commands)) return;
  if (reasons.length === 0) reasons.push('没有匹配的 command 规则');
  logger?.warn?.(
    `初始化任务 ${task.id} 当前不会被本实例认领：${reasons.join('；')}；` +
      '请检查 --channel 过滤、channels 配置和 commands.match',
  );
}

/**
 * 启动时执行一次：创建/复用精确通道，并可选地创建并提交任务。
 * 调用方必须在 MCP connect + harness.register 成功之后调用。
 */
export async function applyRunnerSetup({
  client,
  config,
  flags = {},
  logger = null,
  cwd = process.cwd(),
}) {
  validateSetupFlags(flags);
  const channelKey = text(flags.ensureChannel);
  if (!channelKey) return { applied: false };

  const workdir = resolveChannelWorkdir({ flags, config, cwd });
  const channelTitle = text(flags.channelTitle);
  const upsertArgs = { channel_key: channelKey, workdir };
  if (channelTitle) upsertArgs.title = channelTitle;

  const upsert = parseChannelUpsert(
    await client.call('channel.upsert', upsertArgs, { timeoutMs: 20_000 }),
  );
  logger?.info?.(
    `通道${upsert.created ? '已创建' : '已复用'}：${channelKey}（workdir ${workdir}）` +
      `${upsert.restored ? '；已从归档恢复' : ''}`,
  );

  let task = null;
  if (flags.createTask !== undefined) {
    const title = text(flags.createTask);
    const payload = {
      channel_key: channelKey,
      title,
      submit: true,
      idempotency_key: buildTaskIdempotencyKey(channelKey, title),
    };
    if (flags.taskDescription !== undefined) payload.description_md = String(flags.taskDescription);
    const created = parseCreatedTask(
      await client.call('task.create', payload, { timeoutMs: 20_000 }),
    );
    task = created.task;
    logger?.info?.(
      `任务${created.created ? '已创建并提交' : '已存在（幂等），复用'}：${task.id}（${task.status}）`,
    );
    warnIfTaskNotClaimable({ task, config, logger });
  }

  return {
    applied: true,
    channel: { ...upsert, channel_key: channelKey, workdir, title: channelTitle || null },
    task,
  };
}
