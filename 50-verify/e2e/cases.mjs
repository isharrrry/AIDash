/**
 * E2E 用例集：五个视图 + 一条鉴权负向。
 *
 * 断言策略（为什么不用 CSS 选择器）：
 * 选择器绑定的是实现细节，改一次 class 名就红一片，维护成本高且假阳性多。
 * 这里断言「用户真正看到的东西」——页面上有没有这段文字、抽屉有没有打开。
 * 代价是文案改动也会让用例失败，但那恰好是我们希望被人看见的变化。
 *
 * 每个用例独立可用：不依赖上一个用例留下的页面状态。
 */

/** 页面可见文本。innerText 会忽略 display:none 的内容，比 textContent 更接近“用户看到”。 */
const BODY_TEXT = 'document.body.innerText';

async function bodyText(client) {
  return (await client.evaluate(BODY_TEXT)) ?? '';
}

/** 等某段文字出现在页面上；失败时把当前页面文本的前 500 字带出来，方便定位。 */
async function expectText(client, needle, label) {
  try {
    await client.waitFor(`${BODY_TEXT}.includes(${JSON.stringify(needle)})`, label);
  } catch {
    const text = await bodyText(client).catch(() => '');
    throw new Error(
      `${label}：页面上找不到「${needle}」。当前可见文本（前 500 字）：\n${text.slice(0, 500)}`,
    );
  }
}

/** 断言页面上不出现某段文字，用于“不该看到的东西真的没出现”。 */
async function expectNoText(client, needle, label) {
  const text = await bodyText(client);
  if (text.includes(needle)) {
    throw new Error(`${label}：页面上不该出现「${needle}」，但它出现了。`);
  }
}

/** 点击文字匹配的元素（只点可见元素），返回是否命中。 */
async function clickByText(client, selector, text) {
  return client.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const target = nodes.find((node) => (node.innerText || '').trim().includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

/** 点击任务树里标题包含指定文字的任务行，打开右侧详情。 */
async function openTaskRow(client, title) {
  const clicked = await clickByText(client, '.task-row', title);
  if (!clicked) throw new Error(`任务树里找不到任务行：${title}`);
  await client.waitFor(`document.querySelector('.task-detail') !== null`, '任务详情打开');
}

/** 用原生 setter 写受控 textarea，并派发 input 事件让 React 收到变更。 */
async function fillTextarea(client, selector, value) {
  await client.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

/**
 * 五个视图 + 一个鉴权用例。
 *
 * ctx 形状：
 * - client：CdpClient
 * - baseUrl / token：服务地址与本次 E2E 的一次性令牌
 * - data：harness.seed() 的返回值
 */
export const CASES = [
  {
    name: '决策台：待拍板队列显示问题卡',
    async run({ client, baseUrl, data }) {
      await client.navigate(`${baseUrl}/#/`);
      await expectText(client, '决策台', '决策台标题');
      // 决策台只列 question 类型；info 卡挂在任务下，不该出现在这里。
      await expectText(client, data.questionCardTitle, '待拍板队列里的问题卡');
      await expectNoText(client, data.infoCardTitle, '决策台不应显示挂任务的 info 卡');
    },
  },

  {
    name: '通道页：别名作为标题，卡片流显示两张卡',
    async run({ client, baseUrl, data }) {
      await client.navigate(`${baseUrl}/#/c/${encodeURIComponent(data.channelKey)}`);
      await expectText(client, 'E2E 通道别名', '通道页标题（别名优先）');
      await expectText(client, '卡片流', '卡片流区块');
      // 通道页的卡片流不分类型，两张都应该在。
      await expectText(client, data.infoCardTitle, '卡片流里的 info 卡');
      await expectText(client, data.questionCardTitle, '卡片流里的 question 卡');
    },
  },

  {
    name: '任务树：显示本通道任务',
    async run({ client, baseUrl, data }) {
      // 任务页按「当前通道」取数，而当前通道存在 sessionStorage / React 状态里。
      // 先走一次通道页把它同步好，再切到任务页——这条路径也正是用户的真实操作顺序。
      await client.navigate(`${baseUrl}/#/c/${encodeURIComponent(data.channelKey)}`);
      await client.setHash('#/tasks');
      await expectText(client, data.taskTitle, '任务树里的任务标题');
    },
  },

  {
    name: '任务树：点击全部通道后跨通道任务可见',
    async run({ client, baseUrl, data }) {
      // 先进入单通道，模拟用户平时的起点；再从通道树切到“全部通道”。
      await client.navigate(`${baseUrl}/#/c/${encodeURIComponent(data.channelKey)}`);
      await client.setHash('#/tasks');
      await expectText(client, data.taskTitle, '单通道任务');

      await client.evaluate("document.querySelector('.channel-tree-trigger')?.click()");
      if (!(await clickByText(client, '.channel-tree-all', '全部通道'))) {
        throw new Error('通道树里找不到“全部通道”根节点');
      }
      // 全部通道视图与主对话视图一致：每条通道一块独立看板，
      // 而不是把所有通道塞进同一个“本次通道任务”看板里。
      const boardCount = await client.evaluate(
        "document.querySelectorAll('.task-channel-group .task-board.compact').length",
      );
      if (boardCount < 2) {
        throw new Error(`全部通道视图应每条通道一块看板，实际只有 ${boardCount} 块`);
      }
      await expectText(client, data.taskTitle, '全部通道里的本通道任务');
      await expectText(client, data.secondTaskTitle, '全部通道里的第二通道任务');
      await expectNoText(client, '选择一个通道或主对话开始', '全部通道不应显示空状态');
    },
  },

  {
    name: '任务详情：信息流条目点击后原位展开卡片详情',
    async run({ client, baseUrl, data }) {
      await client.navigate(`${baseUrl}/#/c/${encodeURIComponent(data.channelKey)}`);
      await client.setHash('#/tasks');
      await expectText(client, data.taskTitle, '任务树里的任务标题');
      await openTaskRow(client, data.taskTitle);

      // 信息流条目默认收起：只显示标题/摘要，没有卡片详情里的操作区。
      await expectText(client, data.infoCardTitle, '任务信息流里的卡片标题');
      await expectNoText(client, '在抽屉中打开', '收起时不应展开卡片详情');

      if (!(await clickByText(client, '.task-feed-main', data.infoCardTitle))) {
        throw new Error('任务信息流里找不到可展开的卡片条目');
      }
      // 展开后详情直接长在任务详情里，且地址仍是任务页（没有跳到 ?card= 抽屉）。
      await expectText(client, '在抽屉中打开', '点击条目后原位展开卡片详情');
      const hash = await client.evaluate('window.location.hash');
      if (String(hash).includes('card=')) {
        throw new Error(`原位展开不应打开卡片抽屉，实际 hash：${hash}`);
      }

      if (!(await clickByText(client, '.task-feed-main', data.infoCardTitle))) {
        throw new Error('任务信息流里找不到可收起的卡片条目');
      }
      // 收起是状态更新，给它一个短轮询窗口；直接读一次可能会读到上一帧。
      await client.waitFor(
        `!${BODY_TEXT}.includes('在抽屉中打开')`,
        '再次点击后收起卡片详情',
      );
    },
  },

  {
    name: '讨论任务：结论、父链上下文与批量拆子讨论',
    async run({ client, baseUrl, data }) {
      await client.navigate(`${baseUrl}/#/c/${encodeURIComponent(data.channelKey)}`);
      await client.setHash('#/tasks');
      await expectText(client, data.discussionTitle, '讨论父任务出现在任务树');

      // 子讨论打开时必须能看到父任务的问题与上级结论。
      await openTaskRow(client, data.discussionChildTitle);
      await expectText(client, '讨论上下文', '子讨论的父链上下文');
      await expectText(client, '上级结论', '父讨论结论标题');
      await expectText(client, data.discussionAnswer, '父讨论结论正文');
      await expectText(client, '快速拆分子任务', '详情页批量拆分入口');

      // 父讨论详情：结论置顶，并且能一次拆出多条待认领子讨论。
      await openTaskRow(client, data.discussionTitle);
      await expectText(client, '讨论结论', '父任务讨论结论区');
      await expectText(client, data.discussionAnswer, '父任务讨论结论正文');
      const first = `E2E 快速子讨论 A ${data.suffix}`;
      const second = `E2E 快速子讨论 B ${data.suffix}`;
      await fillTextarea(
        client,
        '.task-discussion-children textarea',
        `- ${first}\n2. ${second}`,
      );
      if (!(await clickByText(client, '.task-discussion-children button', '创建 2 个讨论子任务'))) {
        throw new Error('批量创建按钮未出现或文案不符合预期');
      }
      await expectText(client, '已创建 2 个讨论子任务', '批量创建成功提示');
      await expectText(client, first, '第一个快速子讨论出现在任务树');
      await expectText(client, second, '第二个快速子讨论出现在任务树');
    },
  },

  {
    name: '设置页：分区导航、数据库路径只出现一处',
    async run({ client, baseUrl }) {
      await client.navigate(`${baseUrl}/#/settings`);
      await expectText(client, '设置与运维', '设置页标题');
      // 默认概览只应有健康检查；服务参数不该在未切 Tab 时被渲染。
      await expectText(client, '健康检查', '健康检查区块');
      // 概览说明文字可以提到“数据库路径放在服务参数”，但健康指标里不能有一份实际值。
      const overviewPathMetrics = await client.evaluate(
        "[...document.querySelectorAll('.health-grid .metric')].filter((node) => (node.innerText || '').includes('数据库路径')).length",
      );
      if (overviewPathMetrics !== 0) {
        throw new Error(`概览的健康指标不应再显示数据库路径，实际 ${overviewPathMetrics} 处`);
      }

      if (!(await clickByText(client, '[role="tab"]', '服务参数'))) {
        throw new Error('设置页找不到“服务参数”分区');
      }
      await expectText(client, '服务参数', '服务参数分区');
      await expectText(client, '数据库路径', '服务参数里的数据库路径');
      // 只统计真正的设置标签（dt），不把说明文字里的提及算成重复展示。
      const pathLabels = await client.evaluate(
        "[...document.querySelectorAll('.settings-group dt')].filter((node) => (node.innerText || '').trim() === '数据库路径').length",
      );
      if (pathLabels !== 1) {
        throw new Error(`数据库路径设置项应只出现一次，实际 ${pathLabels} 次`);
      }

      if (!(await clickByText(client, '[role="tab"]', 'Harness'))) {
        throw new Error('设置页找不到 Harness 分区');
      }
      await expectText(client, 'Harness 注册表', 'Harness 注册表');
      await expectText(client, 'e2e-harness', 'E2E harness 出现在注册表');

      if (!(await clickByText(client, '[role="tab"]', '审计日志'))) {
        throw new Error('设置页找不到审计日志分区');
      }
      await expectText(client, '审计日志', '审计日志分区');
    },
  },

  {
    name: '卡片抽屉：深链直接打开指定卡片',
    async run({ client, baseUrl, data }) {
      // 抽屉由 URL 上的 ?card= 驱动，直接深链验证，不经过点击。
      await client.navigate(`${baseUrl}/#/?card=${encodeURIComponent(data.infoCardId)}`);
      await expectText(client, data.infoCardTitle, '抽屉里的卡片标题');
      await expectText(client, '这张卡用来验证决策台列表与卡片抽屉能否正确渲染。', '抽屉里的正文');
    },
  },

  {
    name: '鉴权：清掉令牌后回到令牌输入页',
    async run({ client, baseUrl }) {
      await client.navigate(`${baseUrl}/#/`);
      // 清掉令牌再整页刷新：模拟“令牌过期/换机器打开”的真实场景。
      await client.evaluate("window.localStorage.removeItem('aidash.token')");
      // 必须 reload 而不是再 navigate 一次：地址没变，navigate 只会空转。
      await client.reload();
      await expectText(client, '连接你的决策面板', '令牌输入页');
      // 负向断言：没有令牌时，业务数据一个字都不该出现。
      await expectNoText(client, '决策台', '未登录时不应渲染决策台');
    },
  },
];
