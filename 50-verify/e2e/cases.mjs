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
    name: '设置页：健康检查与服务参数可见',
    async run({ client, baseUrl }) {
      await client.navigate(`${baseUrl}/#/settings`);
      await expectText(client, '设置与运维', '设置页标题');
      await expectText(client, '健康检查', '健康检查区块');
      await expectText(client, '服务参数', '服务参数区块');
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
