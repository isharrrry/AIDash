# MCP 与值守壳

> Agent 与 AIDash 之间只有一条协议：MCP Streamable HTTP。值守壳也用它——没有第二套 REST 客户端。

## 1. 接入

| 项 | 值 |
|---|---|
| 端点 | `http://127.0.0.1:8787/mcp` |
| 协议 | MCP Streamable HTTP（stateless，无会话保持） |
| 认证 | `Authorization: Bearer <AIDASH_TOKEN>` |
| 令牌来源 | 只从环境变量读；不要写进配置文件、卡片、日志 |

Claude Code 用项目内现成的配置模板：

```bash
claude --mcp-config 40-build/00-platform/config/mcp.json
```

模板内容（`${AIDASH_TOKEN}` 由客户端从环境变量展开，文件里没有明文令牌）：

```json
{
  "mcpServers": {
    "aidash": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer ${AIDASH_TOKEN}" }
    }
  }
}
```

其他 harness（Codex、Cursor 等）按同样的 HTTP + Bearer 方式接入即可。

## 2. 23 个工具

| 分组 | 工具 | 用途 |
|---|---|---|
| 通道与 harness | `channel.upsert` | 登记/更新通道（`host/project/topic`、别名、工作目录） |
| | `harness.register` / `harness.heartbeat` | 注册执行者、上报存活 |
| | `digest.get` | 开场摘要：当前 P0/P1 决策、最近状态、建议 |
| 卡片 | `card.post` | 发 `info` / `handoff` / `suggestion` / `status` / `artifact` |
| | `card.ask` | 发 `question` 并等待回答（有界） |
| | `card.get` / `card.list` | 按 ID 取详情；按通道/类型/状态检索（发卡前查重） |
| | `card.wait` | 对已有问题卡继续等待 |
| 任务 | `task.create` / `task.update` | 建任务、改状态/优先级/分类、认领续租、暂缓、隐患标记 |
| | `task.list` / `task.tree` | 列表与树查询；默认省略已结束任务 |
| | `task.claim` / `task.release` | 原子认领（带租约）、释放回 `pending` |
| | `task.move` / `task.copy` | 移动子树（环检测）、复制子树（副本一律 draft） |
| 知识库 | `kb.search` / `kb.get` | 只读检索与按路径读取（拒绝 `../` 越界） |
| 记忆 | `memory.get` / `memory.append` / `memory.search` / `memory.update` | 按项目维护长期记忆：整篇读取、追加去重、关键字检索、带版本锁的整体替换 |

工具入参的完整字段与错误码见 [04-接口设计说明](../30-design/设计文档包/04-接口设计说明.md) §4；逐工具示例见 [SKILL.md](../10-aidash/skills/aidash-mcp/SKILL.md)。

## 3. 有界等待：为什么 `card.ask` 会提前返回

MCP 客户端普遍在 30~60 秒判定工具调用超时。如果服务端硬等用户回答，会出现“客户端报超时、用户却看到一张新卡”的错位。

所以 `card.ask` 默认最多等 **25 秒**（`AIDASH_MCP_WAIT_CAP_SECONDS`）：

- 用户在这段时间内回答 → 直接返回答案；
- 没回答 → 返回 `pending` + `card_id`，调用方可以继续做别的；
- 稍后用 `card.get` 或 `card.wait` 取答案。

这不是失败，是设计。调用方应把 `pending` 当作“问题已送达，等人处理”，而不是“发卡失败”去重试——重试会造出重复卡。

## 4. 值守壳 `aidash-watch`

### 4.1 定位

值守壳是**外部执行代理**：自己轮询、自己认领、自己拉起 harness、自己回报。AIDash 不推送任务，也不管理它。

### 4.2 配置

默认读工作目录下的 `aidash-watch.json`（可用 `--config` 指定）：

```json
{
  "aidash_url": "http://127.0.0.1:8787",
  "harness_id": "watch-01",
  "name": "本机值守壳",
  "channels": ["myhost/*"],
  "poll_interval_seconds": 15,
  "lease_seconds": 900,
  "heartbeat_interval_seconds": 60,
  "command_timeout_seconds": 1800,
  "commands": [
    {
      "command": "claude -p \"$(cat task.md)\"",
      "tags": ["auto"],
      "title_prefix": "[自动]",
      "channel_key": "myhost/*",
      "cwd": "F:/work/myproj",
      "timeout_seconds": 900
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `aidash_url` | 根地址或完整 `/mcp` 地址均可；不接受 URL 内嵌账号密码 |
| `harness_id` | 执行者标识，只能含字母、数字、点、下划线、冒号、连字符 |
| `channels` | 只领这些通道的任务；空数组表示不限；支持 `前缀/*` |
| `commands[]` | 匹配规则：`tags`（全部满足）、`title_prefix`、`channel_key`；都不写时必须显式 `match_all: true` |
| `cwd` | 子进程工作目录（相对路径按配置文件目录解析） |
| `env` | 追加给子进程的环境变量；禁止覆盖 `AIDASH_TOKEN` / `AIDASH_LLM_API_KEY` |

令牌只从环境变量 `AIDASH_TOKEN` 读取；配置文件里写令牌会被拒绝。

### 4.3 子命令

| 命令 | 行为 |
|---|---|
| `aidash-watch run` | 主循环：注册/心跳 → 拉取 → 认领 → 执行 → 回报 → 睡眠 |
| `aidash-watch once` | 只跑一轮（最多执行一个任务） |
| `aidash-watch dry-run` | 只打印“将要做什么”，不认领、不启动子进程 |
| `aidash-watch status` | 显示配置、在线状态、当前任务、上次心跳 |
| `aidash-watch --version` | 版本号 |

第一次接入时先用 `dry-run` 确认匹配规则，再切 `once` 跑一个真实任务，最后才开 `run` 常驻。

### 4.4 失败与恢复

| 情况 | 行为 |
|---|---|
| AIDash 不可达 | 指数退避重试，日志告警 |
| 认领冲突 | 别人已认领，跳过，下一轮再看 |
| harness 超时 | 杀进程树，记失败，按配置重试 |
| 值守壳被杀 | 租约到期，任务回 `pending`，重启后可重新认领 |
| 网络分区导致重复执行 | 回报幂等，以最后一次 `task.update` 为准 |

## 5. 契约文件教 agent 做什么

接入 harness 时，把这两份复制到对方仓库根（或作为规则文件加载）：

| 文件 | 内容 |
|---|---|
| [`40-build/10-aidash/AGENTS.md`](../10-aidash/AGENTS.md) | 端点与认证、23 个工具的任务边界、六类卡片模板、任务生命周期与完成定义、安全约束、错误处理、会话恢复检查 |
| [`40-build/10-aidash/skills/aidash-mcp/SKILL.md`](../10-aidash/skills/aidash-mcp/SKILL.md) | 逐工具的入参示例与常见错误 |

最小可用流程（摘自 AGENTS.md 附录 B）：

1. 开场 `digest.get` 看有没有待办；
2. 遇到需要人拍板的事 → `card.ask`（带四段正文与选项）；
3. 干活前先 `task.create`/`task.claim`，不要“先做后补”；
4. 干完发 `status`/`artifact` 证据卡，再 `task.update(done)`；
5. 结束前查一遍自己名下未结束的任务，逐条处理或说明原因。
