import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClient } from '../src/mcp-client.js';
import { AuthError, BusinessError, TransportError } from '../src/errors.js';
import { callWithRetry, retryDelayMs } from '../src/retry.js';
import { redact, resetSecrets } from '../src/redact.js';
import { FakeAidash, makeTask } from './helpers/fake-mcp.js';
import { DEFAULT_FAKE_TOKEN } from './helpers/cli.js';

test.afterEach(() => {
  resetSecrets();
});

test('MCP 客户端：initialize、通知、tools/list 与工具调用', async () => {
  const fake = await new FakeAidash().start();
  const client = new McpClient({ endpoint: fake.url, token: DEFAULT_FAKE_TOKEN });
  try {
    const init = await client.connect();
    assert.equal(init.serverInfo.name, 'fake-aidash');
    assert.equal(fake.messages.some((message) => message.method === 'notifications/initialized'), true);
    assert.equal(client.initialized, true);

    const tools = await client.listToolNames();
    assert.ok(tools.includes('task.claim'));
    assert.equal(tools.includes('task.get'), false);

    const task = makeTask({ tags: ['it'] });
    fake.addTask(task);
    const listed = await client.call('task.list', { status: 'pending' });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].description_md, null);

    const registered = await client.call('harness.register', { harness_id: 'watch-x', name: 'x' });
    assert.equal(registered.harness_id, 'watch-x');
  } finally {
    await fake.stop();
  }
});

test('MCP 客户端：SSE 响应可解析', async () => {
  const fake = await new FakeAidash({ sse: true }).start();
  const client = new McpClient({ endpoint: fake.url, token: DEFAULT_FAKE_TOKEN });
  try {
    await client.connect();
    const tools = await client.listToolNames();
    assert.ok(tools.includes('card.post'));
  } finally {
    await fake.stop();
  }
});

test('MCP 客户端：isError 文本转 BusinessError，可重试码被标记', async () => {
  const fake = await new FakeAidash().start();
  const client = new McpClient({ endpoint: fake.url, token: DEFAULT_FAKE_TOKEN });
  try {
    await client.connect();
    fake.failNextTool('task.list', 'ALREADY_CLAIMED', '已被别人认领');
    await assert.rejects(
      () => client.call('task.list', { status: 'pending' }),
      (error) =>
        error instanceof BusinessError &&
        error.code === 'ALREADY_CLAIMED' &&
        error.retryable === true &&
        error.message.includes('已被别人认领'),
    );
  } finally {
    await fake.stop();
  }
});

test('MCP 客户端：HTTP 401 抛 AuthError，不重试', async () => {
  const fake = await new FakeAidash().start();
  fake.unauthorized = true;
  const client = new McpClient({ endpoint: fake.url, token: DEFAULT_FAKE_TOKEN });
  try {
    await assert.rejects(
      () => client.connect(),
      (error) => error instanceof AuthError && error.exitCode === 2,
    );
    assert.equal(fake.requests, 1);
  } finally {
    await fake.stop();
  }
});

test('MCP 客户端：HTTP 503/429 是可重试的业务错误', async () => {
  const fake = await new FakeAidash().start();
  const client = new McpClient({ endpoint: fake.url, token: DEFAULT_FAKE_TOKEN });
  try {
    fake.httpStatus = 503;
    fake.httpMessage = '服务繁忙';
    await assert.rejects(
      () => client.connect(),
      (error) => error instanceof BusinessError && error.code === 'BUSY' && error.retryable === true,
    );
    fake.httpStatus = 429;
    await assert.rejects(
      () => client.connect(),
      (error) => error instanceof BusinessError && error.code === 'RATE_LIMITED' && error.retryable === true,
    );
    fake.httpStatus = null;
  } finally {
    await fake.stop();
  }
});

test('MCP 客户端：传输失败是 TransportError', async () => {
  const fake = await new FakeAidash().start();
  const client = new McpClient({ endpoint: fake.url, token: DEFAULT_FAKE_TOKEN });
  try {
    fake.httpStatus = 500;
    await assert.rejects(
      () => client.connect(),
      (error) => error instanceof TransportError && error.kind === 'transport',
    );
    fake.httpStatus = null;
    fake.stop();
    await assert.rejects(
      () => client.connect(),
      (error) => error instanceof TransportError,
    );
  } finally {
    await fake.stop();
  }
});

test('MCP 客户端构造时登记令牌，日志脱敏可覆盖 --token 来源', async () => {
  resetSecrets();
  const token = 'fake-cli-token-abcdef123456';
  // eslint-disable-next-line no-new
  new McpClient({ endpoint: 'http://127.0.0.1:1/mcp', token });
  assert.equal(redact(`回显 ${token}`).includes(token), false);
  assert.match(redact(`回显 ${token}`), /\*\*\*/);
});

test('有界重试：前两次 429、第三次成功，退避 500/1500ms', async () => {
  const fake = await new FakeAidash().start();
  const client = new McpClient({ endpoint: fake.url, token: DEFAULT_FAKE_TOKEN });
  const delays = [];
  try {
    await client.connect();
    const requestsBefore = fake.requests;
    fake.failHttpTimes(2, 429, '连续任务触发限流');

    const listed = await callWithRetry(() => client.call('task.list', { status: 'pending' }), {
      // 注入 sleep：验证退避值，同时不让单测真的等待 2 秒。
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    assert.deepEqual(listed.items, []);
    assert.equal(fake.requests - requestsBefore, 3, '应当是三次 HTTP 请求后才成功');
    assert.deepEqual(delays, [500, 1_500]);
    assert.equal(fake.callsFor('task.list').length, 1, '业务层只成功执行一次');
  } finally {
    await fake.stop();
  }
});

test('有界重试：401 是 AuthError，立即失败且只请求一次', async () => {
  const fake = await new FakeAidash().start();
  const client = new McpClient({ endpoint: fake.url, token: DEFAULT_FAKE_TOKEN });
  const delays = [];
  try {
    await client.connect();
    const requestsBefore = fake.requests;
    fake.unauthorized = true;

    await assert.rejects(
      () =>
        callWithRetry(() => client.call('task.list', { status: 'pending' }), {
          sleep: async (ms) => {
            delays.push(ms);
          },
        }),
      (error) => error instanceof AuthError && error.code === 'UNAUTHORIZED',
    );

    assert.equal(fake.requests - requestsBefore, 1, '401 后不得再发请求');
    assert.deepEqual(delays, [], 'AuthError 不进入退避');
  } finally {
    await fake.stop();
  }
});

test('有界重试：TransportError 按类可重试，不可重试的业务错误直接抛出', async () => {
  let transportAttempts = 0;
  const recovered = await callWithRetry(
    async () => {
      transportAttempts += 1;
      if (transportAttempts < 3) throw new TransportError('模拟断线');
      return 'ok';
    },
    { sleep: async () => {} },
  );
  assert.equal(recovered, 'ok');
  assert.equal(transportAttempts, 3);

  let businessAttempts = 0;
  await assert.rejects(
    () =>
      callWithRetry(
        async () => {
          businessAttempts += 1;
          throw new BusinessError('INVALID_ARGUMENT', '参数不对');
        },
        { sleep: async () => {} },
      ),
    (error) => error instanceof BusinessError && error.code === 'INVALID_ARGUMENT',
  );
  assert.equal(businessAttempts, 1, '未标记 retryable 的业务错误不应重试');
});

test('有界重试：details.retry_after 优先，且封顶 5 秒', () => {
  const limited = new BusinessError('RATE_LIMITED', '限流', {
    retryable: true,
    details: { retry_after: 2 },
  });
  assert.equal(retryDelayMs(limited, 1), 2_000);

  const capped = new BusinessError('RATE_LIMITED', '限流', {
    retryable: true,
    details: { retry_after: 60 },
  });
  assert.equal(retryDelayMs(capped, 1), 5_000);

  const normal = new BusinessError('BUSY', '繁忙', { retryable: true });
  assert.equal(retryDelayMs(normal, 1), 500);
  assert.equal(retryDelayMs(normal, 2), 1_500);
});

test('claim 返回 claim_token 与任务视图；list 支持分页', async () => {
  const fake = await new FakeAidash().start();
  const client = new McpClient({ endpoint: fake.url, token: DEFAULT_FAKE_TOKEN });
  try {
    await client.connect();
    await client.call('harness.register', { harness_id: 'watch-x', name: 'x' });
    for (let index = 0; index < 3; index += 1) fake.addTask(makeTask({ tags: ['it'] }));

    const page1 = await client.call('task.list', { status: 'pending', page: 1, page_size: 2 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.has_more, true);
    const page2 = await client.call('task.list', { status: 'pending', page: 2, page_size: 2 });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.has_more, false);

    const [first] = page1.items;
    const claim = await client.call('task.claim', {
      task_id: first.id,
      harness_id: 'watch-x',
      lease_seconds: 60,
    });
    assert.match(claim.claim_token, /^claim-token-/);
    assert.equal(claim.renewed, false);
    assert.equal(claim.task.id, first.id);

    const renewed = await client.call('task.claim', {
      task_id: first.id,
      harness_id: 'watch-x',
      lease_seconds: 60,
      claim_token: claim.claim_token,
    });
    assert.equal(renewed.renewed, true);
  } finally {
    await fake.stop();
  }
});
