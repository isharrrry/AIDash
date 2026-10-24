# AIDash — 单用户 AI 决策面板

**中文** | [English](README.en.md)

> 给“一个人 + 多个 AI harness”用的决策面板：agent 把需要你拍板的事写成卡片推上来，你在网页上集中处理；你排好的任务，机器自己来认领执行。

**平台与依赖**：Windows / Linux / macOS（代码跨平台，实测环境见下文）；Node.js ≥ 24、pnpm 12.4.1；存储用内置 SQLite，不需要额外安装数据库。

---

## 它解决什么问题

同时跑几个 AI 编码任务时，真正难受的不是“跑得慢”，而是：

- 三个终端在等你回答同一个问题，你切来切去；
- agent 写完一段话，你得自己复制、改语气、发给同事；
- 任务散在各自的聊天窗口里，排不了优先级；
- 想让另一台机器上的 harness 接着干，却没有一张共同的“活单”。

AIDash 把这些收敛成三样东西：**卡片**、**任务树**、**通道**。它不调度、不派活、不管别的机器，只做一件事：**让你在正确的时间看到正确的那一条**。

### 核心特性

- **六类卡片**：信息、交接话术、待澄清问题、建议、状态、产物。问题卡支持四段正文（背景 / 目标 / 调研 / 决策）与主备推荐选项。
- **有界等待**：`card.ask` 最多等 25 秒就返回 `pending` + `card_id`，不会因为 MCP 客户端超时而丢掉问题。
- **任务树**：拖拽移动、父子层级、优先级、分类、租约认领、证据校验、暂缓与隐患标记。
- **外部值守壳**：跨平台 CLI 轮询认领任务、拉起本地 harness、回写状态与证据；AIDash 从不主动推送任务。
- **只读知识库**：OKF Markdown 目录 + SQLite FTS5 检索，不写用户目录。
- **可选 LLM 增强**：任意 OpenAI 兼容端点；没配置 key 时静默跳过，不阻塞主流程。
- **审计只追加**：数据库触发器禁止 UPDATE/DELETE，没有删除 API。
- **MCP 是唯一 agent 面**：REST 与 MCP 共用同一层业务逻辑，值守壳也只走 MCP。

---

## 快速上手

```bash
# 依赖：Node ≥ 24、pnpm 12.4.1
pnpm install

# 构建服务端 + 前端
pnpm build
pnpm web:build

# 设置令牌（只从环境变量读，不要写进仓库）
# Windows:
set AIDASH_TOKEN=请换成一个足够长的随机串
# macOS / Linux:
export AIDASH_TOKEN=请换成一个足够长的随机串

# 启动
pnpm start
```

打开 `http://127.0.0.1:8787/`，在设置页填入同一个令牌。

想让 Claude Code 接上 AIDash：

```bash
claude --mcp-config 00-platform/config/mcp.json
```

---

## 核心概念

1. **卡片（Card）**——agent 与人之间的单向信息载体。六种类型各有用途；`question` 卡才会进入“待拍板”队列。详见 [AGENTS.md §3](10-aidash/AGENTS.md)。
2. **通道（Channel）**——按 `host/project/topic` 分会话的命名空间。同一项目的多个 harness 共享一份“主对话记忆”。详见 [架构 §3.1](docs/architecture.md#31-卡片agent-问人答)。
3. **任务树（Task Tree）**——人排的“活单”。状态机、认领租约、证据卡、暂缓与隐患都是任务的一等属性。详见 [MCP 与值守壳 §4](docs/mcp-and-cli.md#4-值守壳-aidash-watch)。
4. **值守壳（`aidash-watch`）**——外部执行代理。自己轮询、自己认领、自己拉起 harness；面板不假装“有人正在跑”。详见 [架构 §1](docs/architecture.md#1-三个交付物)。
5. **契约包（AGENTS.md + SKILL.md）**——教 agent 什么时候发卡、怎么认领、完成怎么举证。它是产品的一部分，不是说明文档。详见 [MCP 与值守壳 §5](docs/mcp-and-cli.md#5-契约文件教-agent-做什么)。

---

## 安全边界

- 默认只监听 `127.0.0.1`；跨机访问必须显式配置，并自行加 TLS / 反向代理。
- 令牌只从环境变量或本机加密存储读取；不写数据库、不回显、不进日志与导出。
- 审计表只追加：触发器禁止 UPDATE/DELETE，没有删除接口。
- 知识库目录**只读**，服务不写、不改、不删。
- 不持有任何第三方系统的账号或令牌；需要外部凭据的操作交给 harness 自己的环境变量。
- 页面保存的 LLM 密钥落在 `~/.aidash`（加密文件），刻意与数据库、备份目录分开。

---

## 文档

| 想了解 | 读 |
|---|---|
| 架构、分层、两条数据流、设计取舍 | [docs/architecture.md](docs/architecture.md) |
| 环境变量、配置文件、启动与备份 | [docs/configuration.md](docs/configuration.md) |
| MCP 接入、23 个工具、值守壳用法 | [docs/mcp-and-cli.md](docs/mcp-and-cli.md) |
| 开发环境、测试、贡献流程 | [docs/contributing.md](docs/contributing.md) |
| Agent 行为契约 | [10-aidash/AGENTS.md](10-aidash/AGENTS.md) |
| 逐工具手册 | [10-aidash/skills/aidash-mcp/SKILL.md](10-aidash/skills/aidash-mcp/SKILL.md) |
| 需求与验收判据（唯一需求事实源） | [20-spec/需求与验收判据文档.md](20-spec/需求与验收判据文档.md) |
| 概要设计与 ADR（唯一 ADR 事实源） | [30-design/概要设计.md](30-design/概要设计.md) |
| 设计文档包（01~07 + 界面 + 安全） | [30-design/设计文档包/README-核心包.md](30-design/设计文档包/README-核心包.md) |

冲突时的权威顺序：需求文档 → 概要设计 → 接口设计 → 数据库设计 → 安全 → 界面 → 其他设计文档。

---

## 开发

```bash
pnpm typecheck      # 服务端 + Web 类型检查
pnpm test           # 29 个测试文件 / 255 个用例
pnpm coverage       # 覆盖率
pnpm build          # 服务端 → 10-aidash/dist/server
pnpm web:build      # 前端   → 10-aidash/dist/web
pnpm cli:build      # 值守壳 → 10-aidash/dist/cli/aidash-watch.mjs
```

**实测环境**：Windows 11（10.0.26100）、Node 24、pnpm 12.4.1、Edge 155（Chromium）。

---

## 实测验证

以下数字均为 2026-10-25 在本仓库实测，**没有一行是估计**；命令都可复算。

| 验证项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 退出码 0 |
| 单元 / 集成测试 | `pnpm test` | **29 个文件 / 255 个用例全部通过** |
| 覆盖率 | `pnpm coverage` | 语句 **84.22%** / 分支 73.87% / 函数 90.81% / 行 86.64% |
| 服务端构建 | `pnpm build` | 成功，复制 **17** 个迁移 SQL 到 `dist` |
| 前端构建 | `pnpm web:build` | 成功，Vite 构建 630 ms |
| 值守壳构建 | `pnpm cli:build` | 单文件 **727.3 KiB** |
| 文档自检 | 三个检查脚本 | **24 / 15 / 6** 项全部通过，退出码 0 |
| 启动冒烟（空库、临时端口 8795） | `node 10-aidash/dist/server/main.js` + HTTP 探测 | `/healthz` 200（`version=2.0.0`）、`/` 200、无令牌 `/mcp` **401**、`initialize` 200、`tools/list` 返回 **23** 个工具、空库迁移到 `schema_version=16` |

开发过程中的浏览器端到端验证（决策台、任务树、拍板模态框、记忆面板、Markdown/Mermaid 渲染）在 Windows + Edge 无头浏览器 + CDP 上完成；逐轮明细不随仓库发布，口径说明见 [07-质量记录包 §0](30-design/设计文档包/07-质量记录包.md)。

---

## 已知限制（如实列出）

- **Linux / macOS 未实测**：代码按跨平台写，但只在 Windows 11 验证过。
- **未做大容量压测**：10,000 卡 / 1,000 任务下的 P95 目标未验证。
- **跨机访问未实测**：默认只监听回环；TLS / 反向代理需要部署方自行验证。
- **备份恢复未按 RTO 计时演练**：有备份与迁移前自动备份，但没有正式的恢复演练记录。
- **只验证了 Chromium 内核**：Firefox / Safari 的样式与键盘交互未测。
- **LLM 只验证 OpenAI 兼容端点**：其他厂商的字段差异未覆盖。
- **没有 SBOM 与依赖许可证扫描**。

完整清单与风险说明见 [docs/contributing.md §7](docs/contributing.md#7-已知未验证项)。

---

## License

[MIT](LICENSE)
