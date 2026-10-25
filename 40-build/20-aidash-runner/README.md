# aidash-runner

AIDash 的本地值守壳：轮询 `pending` 任务 → 认领 → 在本地执行 harness 命令 → 发证据卡 → `complete/fail/block`。

- **零第三方运行时依赖**，只用 Node 内置模块；ESM；Node >= 24。
- 适合挂在开发机/构建机上，让本地 CLI（claude、codex、脚本）自动接 AIDash 任务。
- MCP 令牌只从环境变量/令牌文件读取，不写配置、不写 registry、不写日志。

一个工作区接入 AIDash 有两条路，二选一（也可以都留着，但同一批任务只会被一方领走）：

| 方式 | 谁驱动 | 适合 |
|---|---|---|
| 直接用 harness 接 MCP | 人盯着，agent 自己认领 | 交互式开发、需要人拍板的活 |
| 用 `aidash-runner` 值守 | runner 轮询并**拉起** harness | 无人值守：夜里跑、另一台机器跑 |

本包是第二条路的客户端。它不装进服务端，**服务端 `start` 不会顺手把它带起来**；接口契约层面的两条路线说明见 `../../30-design/设计文档包/04-接口设计说明.md` §7.0。

## 安装

```bash
# 全局安装（发布后）
npm install -g aidash-runner

# 从本仓 npm pack 出来的包安装（当前可用的全局安装方式）
npm install -g ./aidash-runner-*.tgz

# 不安装，直接跑
npx aidash-runner --help

# 从本仓源码运行
node ./bin/aidash-runner.mjs --help
```

包同时提供 `aidash-watch` 别名，指向同一入口。

## 快速开始

```bash
cd ~/work/my-agent
aidash-runner init                    # 生成 aidash-runner.json（示例规则只匹配 aidash-runner-demo 标签）
# 按需修改 commands；不要把令牌写进配置
export AIDASH_TOKEN='...'             # 可以是一句短口令；也可用 --token-file
aidash-runner check                   # 校验配置、令牌、目录、规则
aidash-runner start --daemon          # 后台常驻
aidash-runner list                    # 看实例
aidash-runner status                  # 看当前任务/最近拉取/配置
aidash-runner logs -f                 # 跟随日志
aidash-runner stop                    # 优雅停止
```

前台调试：

```bash
aidash-runner start --config ./aidash-runner.json
```

只跑一个任务 / 只看不动：

```bash
aidash-runner once --config ./aidash-runner.json
aidash-runner dry-run --config ./aidash-runner.json
```

不写配置文件的最短路径：

```bash
aidash-runner start --command "claude -p '处理任务'" --url http://127.0.0.1:8787/mcp
```

> `--command` 会创建一条 `match_all=true` 的 **shell** 规则，并替换配置里的 commands。
> 它会把**所有**可认领的 pending 任务都交给这条命令；只建议在明确知道队列内容时使用。
>
> **执行前确认**：只要当前有匹配的 pending 任务，`start` / `once` 会先打印任务清单并
> 退出 0，**不注册、不认领、不执行**；核对后加 `--yes` 重新运行才会继续。
> `dry-run` 不需要 `--yes`，行为不变。
>
> **`--command` 按 shell 命令逐字执行，不是自然语言提示词**：自然语言不会被 AI 解释；
> 要跑 AI harness，请把 harness 命令写进 command 并让它读取 `{task_file}`。

## 最短接入：建通道 → 首条任务 → 回到通道

不需要额外的 .bat / .sh 包装器，下面五步就是完整流程：

```bash
# 0) 生成配置；--preset claude 直接生成 argv 数组，不需要处理 shell 引号
aidash-runner init --preset claude --cwd .

# 1) 令牌只从环境变量或文件来
export AIDASH_TOKEN='...'                 # Windows: set AIDASH_TOKEN=...
# 或：--token-file ./aidash-token.txt

# 2) 自检（不联网）
aidash-runner check

# 3) 首次接入：建/复用通道 + 建首条任务 + 后台常驻
aidash-runner start --daemon --resume claude \
  --ensure-channel devhost/myproj/topic \
  --channel-title "我的话题" \
  --create-task "首条任务"

# 4) 之后回到同一通道：只复用通道，不再重复建任务
aidash-runner start --daemon --resume claude --ensure-channel devhost/myproj/topic

# 5) 看状态 / 跟随日志 / 停止
aidash-runner status
aidash-runner logs -f
aidash-runner stop
```

要点：

- `--ensure-channel` 是**精确通道**：启动时调一次 `channel.upsert`，第一次创建、之后复用；
  `--channel <pattern>` 是**任务过滤**，两者不要混用。
- `--create-task` 用“通道 + 标题”幂等：同通道同标题重复启动复用的还是同一条任务，换标题才是新任务。
- 不写 `--command` 时，配置里的规则生效；`--command` 会替换配置里的 `commands`，且是
  `match_all`，首次 `start` 会先打印任务清单要求 `--yes`。
- 重启 = 先 `stop`，再用同一组参数 `start --daemon`。
- 默认空闲轮询 5 秒、任务间隔 2 秒；命令无法启动（ENOENT/EACCES）只释放一次并退出，
  不会每 2 秒重认领同一任务；服务端限流时按 `retry_after` 退避。
- 换目录部署只需要 `aidash-runner.json`（`cwd: "."` 按配置所在目录解析）+ 令牌来源，
  不需要复制启动脚本；`clitest/start-aidash-runner.bat` 只是这组命令的旧封装。

## 配置查找顺序

1. `--config <path>`
2. `AIDASH_RUNNER_CONFIG=<path>`
3. `./aidash-runner.json`
4. `~/.aidash/runner.json`

显式给出（1/2）但文件不存在会直接报错，不会静默退回默认配置。
两者都没有、也没给 `--command` 时，`start/once/dry-run` 会提示 `init` 或 `--command` 并以退出码 2 结束。

数据目录查找：`--data-dir` > `AIDASH_RUNNER_HOME` > 配置里的 `data_dir` > `~/.aidash/runner`。

**一个配置文件 = 一个 harness = 一个实例。** 要给两台机器/两种 harness 值守，就起两个实例（各带各的 `--config`）。

## 凭据查找顺序

1. `AIDASH_TOKEN`（环境变量优先；若同时给了 CLI 令牌会警告“CLI 令牌被忽略”）
2. `--token` / `--key`（两者是同一参数的别名，只能给一个）
3. `--token-file <path>`（读取后 trim）
4. `AIDASH_PASSPHRASE`（弃用别名，仅兼容旧配置；新配置请直接用 `AIDASH_TOKEN`）

凭据只保存在进程内存；不会进入配置文件、实例 registry、日志或卡片正文。
`AIDASH_TOKEN` 可以直接填一句短口令；自动化/多代理场景建议用长随机串。
建议用环境变量或权限受控的令牌文件，避免出现在 shell 历史与进程列表。

## 命令

| 命令 | 说明 |
| --- | --- |
| `start [--daemon]` | 前台/后台常驻。后台模式等控制面就绪后打印实例 id、pid、日志路径并退出父进程 |
| `once` | 连接一次、注册 harness、最多执行一个任务后退出；不写 registry、不开控制面 |
| `dry-run` | 只读列出 pending、命中规则与跳过原因；不注册、不认领、不执行 |
| `list [--all]` | 列出实例；默认显示 stale 及原因，`--all` 额外显示损坏的 registry |
| `status [id] [--all]` | 查看实例状态、当前任务、最近拉取、配置与统计 |
| `pull [id] [--wait]` | 立即触发一次拉取；忙时合并到下一轮；`--wait` 等这一轮结束 |
| `stop [id] [--all] [--force]` | 优雅停止（15s）；`--force` 只等 3s 后强杀进程树 |
| `kill [id] [--all]` | 直接强杀实例与 harness 进程树 |
| `logs [id] [-f] [--lines <n>]` | 查看日志尾部；`-f` 跟随（不能与 `--json` 同用） |
| `config get [id]` | 查看可安全展示的运行时配置 |
| `config set [id] <key> <value> [--persist]` | 修改白名单运行时键；`--persist` 原子写回配置文件 |
| `config reload [id]` | 重读配置文件；运行时键立即生效，需重启的键会列出 |
| `init [--config <path>] [--force]` | 生成示例配置；默认不覆盖已有文件 |
| `check [--config <path>]` | 离线自检；有问题退出码 2，仅警告退出码 0 |
| `--version` / `--help` | 版本/帮助 |

所有命令都支持 `--json`；此时 stdout 只有一个 JSON 信封（`{ok:true,data}` 或 `{ok:false,error}`），
日志和子进程输出不会混进来。只有一个存活实例时可省略 id；多个实例必须显式指定。

### start 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--config <path>` | 见查找顺序 | 配置文件 |
| `--daemon` | 前台 | 后台常驻；父进程就绪后退出 |
| `--harness-id <id>` | `watch-<hostname>` | 服务端唯一执行者标识，也用作本地实例 id |
| `--name <name>` | hostname | 展示名 |
| `--url <url>` | `http://127.0.0.1:8787/mcp` | MCP 地址；自动补 `/mcp` |
| `--token` / `--key` / `--token-file` | 见令牌顺序 | 令牌来源 |
| `--poll <sec>` | 5 | 空闲轮询间隔 |
| `--lease <sec>` | 900 | 任务租约；执行期间按 1/3 周期续租 |
| `--heartbeat <sec>` | 60 | harness 心跳间隔 |
| `--gap <sec>` | 2 | 两个任务之间的间隔 |
| `--channel <pattern>` | 全部 | 可重复；支持 `*` 与 `prefix/*`；会覆盖配置里的 channels |
| `--command <cmd>` | 无 | 按 shell 命令逐字执行（不是自然语言提示词）；创建 match_all 规则并替换配置文件里的 commands。要跑 AI harness，请让命令读取 `{task_file}` |
| `--yes` | 关 | 配合 `--command`：确认预览出的匹配任务后继续。没有它时，有匹配任务就只打印清单并退出 0 |
| `--ensure-channel <key>` | 无 | 精确创建/复用通道（调 `channel.upsert`）；**不是** `--channel` 的匹配过滤 |
| `--channel-title <title>` | 无 | 配合 `--ensure-channel` 的通道标题；可省 |
| `--create-task <title>` | 无 | 在 `--ensure-channel` 通道创建并提交任务；同通道同标题幂等 |
| `--task-description <md>` | 无 | 配合 `--create-task` 的任务描述 |
| `--resume <engine>` | 无 | 仅支持 `claude`；按任务通道持久化并续接 Claude 会话 |
| `--cwd <dir>` | 继承 | 单条规则或 `--command` 时设置工作目录；也作为通道 workdir 优先值 |
| `--log-file <path>` | `<data-dir>/logs/<id>.log` | 日志文件 |
| `--data-dir <path>` | `~/.aidash/runner` | 实例 registry、临时任务文件、默认日志 |
| `--no-prefix` | 关闭 | 子进程输出不加 `[task_id]` 前缀 |
| `--json` | 关闭 | 机器可读输出 |

### 精确通道与初始化任务（`--ensure-channel` / `--create-task`）

`--channel` 与 `--ensure-channel` 不是一回事：

| 参数 | 作用 | 是否产生副作用 |
| --- | --- | --- |
| `--channel <pattern>` | 认领过滤器，支持 `*` / `prefix/*`，可重复 | 否 |
| `--ensure-channel <key>` | 精确 `channel_key`，start/once 成功后调一次 `channel.upsert` | 是（建/复用通道） |

```bash
aidash-runner start --config ./aidash-runner.json \
  --ensure-channel "devhost/myproj/topic" \
  --channel-title "示例通道" \
  --create-task "处理首条任务" \
  --task-description "任务说明" \
  --resume claude
```

- 第一次调用创建通道，第二次用同一 key 调用会复用并更新非空 title/workdir；不会新建第二个通道。
- `--create-task` 必须配合 `--ensure-channel`；内部用 `submit:true` 创建并提交，不需要再手动 submit。
- 幂等键由“通道 + 标题”哈希得到。同一通道同一标题重复启动会拿回同一任务，包括已完成/失败/取消的任务；要建新任务请换标题。
- workdir 优先级：`--cwd` > 配置里唯一/一致的 `run.cwd` > runner 当前 cwd。超过 500 字符会本地报错。
- 带任务参数后仍进入正常轮询：`start` 完成任务后继续休眠并认领新任务；`once` 最多执行一个任务后退出。
- **没有可认领任务时不会启动 harness 子进程**；空队列只会轮询 MCP。
- `--ensure-channel` 不会自动把该通道加入 `--channel` 过滤。如果同时传了不包含它的 `--channel`/`channels`，任务会被创建但本实例不会认领；启动时会 WARN。
- `dry-run` 永远不执行 `channel.upsert` / `task.create`，只预览现有 pending。
- 如果同时用 `--command`，执行前确认清单只包含“现有 pending”；`--create-task` 的任务是在确认（加 `--yes`）之后才创建。

### Claude 续会话（`--resume claude`）

本机实测依据（2026-10-25）：

- `claude --version` → `2.1.218 (Claude Code)`；
- `claude --help` 明确支持 `-c/--continue`、`-r/--resume [value]`、`--session-id <uuid>`、
  `--output-format text|json|stream-json`、`--no-session-persistence`；
- 本机 Claude 可执行文件里存在错误文案 `No conversation found with session ID: ` 与
  `No conversation found to continue`。

实现选择 `--session-id` + `--resume`，不用 `--continue`（它只续当前目录最近一次，多个通道会串）：

1. 每个任务通道在 `<data-dir>/sessions/` 下有一份会话状态；首次生成合法 UUID，
   **先原子落盘（POSIX 上文件 0600、目录 0700；Windows 由 ACL 控制）再启动进程**，
   所以进程异常中断后下一次仍可续。
2. 首次追加 `--session-id <uuid>`，后续追加 `--resume <uuid>`。
3. 如果 `--resume` 的进程以非零退出，且 stdout/stderr 首部命中“会话不存在”文案，
   runner 会清除旧 id，生成新 id 落盘，并**只回退一次**不带 `--resume` 的执行；
   回退仍失败则按普通任务失败处理，不无限重试。
4. 会话文件只有 `{version,engine,channel_key,session_id,updated_at}`，不含任何令牌。

限制与边界：

- 只对被识别为 Claude 的 harness 生效：直接执行 `claude`、`node`/`python` 启动 `claude-*` 脚本、`npx claude`，或 shell 命令开头/分隔符后直接写 `claude`；其他命令不会加旗标。
- 命令本身已经带 `--resume` / `--continue` / `--session-id` / `--no-session-persistence`
  时，runner 跳过自动管理并 WARN，避免相互覆盖。
- 会话文件写入失败时自动降级为本次不带会话参数执行，并 WARN；不会因此让任务失败。
- 本仓没有用真实 Claude 会话做端到端验证（任务约束要求不消耗真实会话/令牌）。
  上述能力依据本机 help 与可执行文件错误文案；换 Claude 版本后请先用一次性任务自验。
- 如果某个版本不支持这些参数，runner 不会自动改喂“上一任务日志”；任务仍可用
  `{task_md_file}` 读取当前任务 Markdown。此时建议关闭 `--resume`，由 harness 自己带上下文。

## 配置文件字段

示例见 [`aidash-runner.example.json`](./aidash-runner.example.json)。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `aidash_url` | string | `http://127.0.0.1:8787/mcp` | 只支持 http/https；不能内嵌账号密码 |
| `token_env` | string | `AIDASH_TOKEN` | 仅作说明；runner 仍按固定顺序读令牌 |
| `harness_id` | string | `watch-<hostname>` | 字母/数字/`.`/`_`/`:`/`-`，1..64 |
| `name` | string | hostname | 展示名 |
| `host` | string | null | 上报给服务端的主机名 |
| `capabilities` | string[] | `[]` | 上报给服务端 |
| `channels` | string[] | `[]`（全部） | 通道白名单；支持 `*`、`prefix/*` |
| `poll_interval_seconds` | number | 5 | 1..86400 |
| `lease_seconds` | integer | 900 | 1..86400 |
| `heartbeat_interval_seconds` | integer | 60 | 1..3600 |
| `gap_seconds` | number | 2 | 0..3600 |
| `command_timeout_seconds` | integer | 1800 | 规则未写 `timeout_seconds` 时的默认值 |
| `data_dir` | string | `~/.aidash/runner` | 相对路径按配置文件所在目录解析 |
| `log_file` | string | `<data_dir>/logs/<id>.log` | 同上 |
| `env_passthrough` | string[] | 见下 | 传给 harness 的环境变量白名单 |
| `commands` | array | 必填（否则不会认领） | 规则列表，按顺序取第一条命中 |
| `concurrency` | number | 1 | 目前只支持 1 |

默认环境变量白名单：`PATH`、`HOME`、`TMPDIR`、`SystemRoot`、`ComSpec`、`PATHEXT`、`WINDIR`、`TEMP`、`TMP`。
`AIDASH_TOKEN`、`AIDASH_LLM_API_KEY` 以及任何从父进程继承、以 `_TOKEN/_SECRET/_KEY/_PASSWORD`
结尾的变量永不传给子进程，即使被写进 `env_passthrough` 也会被过滤/警告。
runner 自己注入的 `AIDASH_TASK_ID`、`AIDASH_TASK_TITLE`、`AIDASH_CHANNEL_KEY` 等是任务元数据
（`CHANNEL_KEY` 是通道标识而非凭据），不受这条后缀过滤影响。

### commands[].match

| 字段 | 说明 |
| --- | --- |
| `tags` | 字符串数组；**AND** 语义，忽略大小写 |
| `title_prefix` | 标题前缀，忽略大小写 |
| `channel_key` | 精确匹配，支持 `*` 与 `prefix/*` |
| `priority` | `P0/P1/P2/P3` 子集 |
| `kind` | `task` / `suggestion` |
| `match_all` | 没有任何选择条件时必须显式写 `true`，防止误跑全队列 |

### commands[].run

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `argv` | 必填 | 非空字符串数组；默认**不经过 shell** |
| `shell` | false | 显式 `true` 才按 shell 字符串执行（注入面更大） |
| `cwd` | 继承 runner | 相对路径按配置文件目录解析 |
| `input` | `file` | `file`（写 `{task_file}`/`{task_md_file}`）、`stdin`、`none` |
| `stdin` | `task_json` | `task_json` / `task_md` |
| `timeout_seconds` | 继承 `command_timeout_seconds` | 1..86400；超时后杀整棵进程树 |
| `env` | `{}` | 额外环境变量；敏感变量名会被拒绝 |
| `env_passthrough` | `[]` | 追加到全局白名单 |
| `result_file` | 无 | 命令写出的 JSON：`{summary,detail_md,result}`；`result` ∈ `success/failed/blocked/partial` |

`{task_file}` 是权限 0600 的临时 JSON（不含 claim_token/租约等控制字段），任务结束即删除。
`{task_md_file}` 是同目录的 Markdown 版本。`input=none` 时不允许使用占位符。

## 匹配、排序与安全边界

1. 先排除：显式指派给别人的任务、不在 `channels` 内的任务、仍在暂缓期内的任务。
2. 按 `commands` 顺序选择第一条命中的规则；都没命中则跳过。
3. 候选按 `优先级 → due_at（无截止时间排后）→ id` 排序，一轮只执行一个任务。
4. 暂缓是覆盖层：`defer_reason` 非空且 `deferred_until` 未到（或为空）就跳过；过期后自然恢复。

## 执行与回报

- 命令输出用 `pipe` 捕获，**不继承终端**，否则无法脱敏、写日志和进环形缓冲。
- 输出同时写：前台终端、日志文件、首尾各 8KB 环形缓冲（用于卡片正文）。
- 写终端/日志前脱敏 Bearer、`*_TOKEN/SECRET/KEY/PASSWORD=...`；卡片正文额外清除 ANSI。
- 先发 `status` 证据卡，再 `task.update complete`（服务端强制要求证据）。
- 幂等键由 `claim_token` 派生（`sha256` 截断），客户端重试不会产生重复卡。

### 失败语义（重点：不重复执行）

| 场景 | 动作 |
| --- | --- |
| 命令根本没启动（cwd 不存在、可执行文件缺失、启动前停止） | `release` 回 pending |
| 命令已执行、证据卡发送失败 | 成功 → `block`；失败 → `fail`；理由含“命令已执行但证据回报失败”；**绝不 release** |
| 命令已执行、`complete`/`fail` 回报失败 | `block`，理由写明未 release |
| 租约丢失/被他人接管 | 立即终止命令；不 release、不回报 |
| 401 | 立即停止整个实例；不重试 |
| 传输错误/断线 | 指数退避 + ±20% 抖动（上限 60s），不退出 |
| 单条任务业务错误 | 跳过该任务，循环继续 |
| 连续 2 个任务同因快速失败 | WARN 并停实例（退出码 1），不再认领后续任务 |

### 连续同因失败熔断

常驻 `start` 实例（`once` 最多跑一个任务，不涉及）在**连续 2 个任务**都满足下面
全部条件时，会打印 WARN、停止认领并退出（错误码 `CIRCUIT_BREAKER`，退出码 1）：

1. 任务已被服务端记为 `failed`（证据卡/complete/fail 回报失败不算）；
2. 命令确实启动过，且不是超时、不是被中止、不是 spawn 失败；
3. 退出码是整数，且两次完全相同（允许 0：harness 可用 result_file 自报 failed）；
4. 命令耗时严格小于 **2000ms**；
5. `stderr` 的**首个非空行**（去首尾空白、ANSI 并脱敏后）非空且两次完全相同。

成功、阻塞、慢失败、无 stderr、退出码不同或首行 stderr 不同都会清空连续计数。
空 stderr 不参与熔断：没有可比较的失败证据时，宁可继续跑，也不把两个恰好都没输出
stderr 的不同故障误判成同因。这样做的目标不是“猜根因”，而是阻止一个明显坏掉的
命令在无人值守时把整队列任务连续跑成 failed。

## 实例 registry 与控制面

- 每个实例写 `<data-dir>/instances/<harness_id>.json`，权限 0600、临时文件 + rename 原子写。
- 控制面只监听 `127.0.0.1` 随机端口，要求 Bearer 随机会话令牌；令牌只存在 registry 中（0600），
  与 MCP 令牌完全分离。
- 端点：`GET /health`、`GET /status`、`POST /pull`、`POST /stop`、`POST /config`、`POST /reload`。
- 存活判定 = PID 存活 + `/health` 可达 + `instance_id/pid/harness_id/started_at` 指纹一致，
  避免 PID 复用后误停无关进程。

### 可热改的配置键

`poll_interval_seconds`、`lease_seconds`、`heartbeat_interval_seconds`、`gap_seconds`、`channels`、`env_passthrough`。

其余键（`aidash_url`、`harness_id`、`name`、`commands`、`data_dir`、`log_file` 等）需要重启；
`config set` 会直接拒绝，`config reload` 会列在 `restart_required` 里。

## 安全说明

- 令牌不落盘：配置、registry、Claude 会话文件、日志、卡片、测试夹具里都不出现真实令牌。
- 子进程默认白名单继承环境；令牌/密钥类变量双重过滤。
- `argv` 默认不过 shell；只有显式 `shell:true` 或 `--command` 才会拼 shell 字符串。
- 控制面只绑回环地址；registry 被篡改成非回环地址时拒绝连接。
- `kill`/`stop --force` 会终止整棵进程树（Windows `taskkill /T /F`；POSIX 进程组 SIGTERM→SIGKILL）。
- 本包不安装系统服务、不做跨机调度；账号权限就是 harness 的权限。

## 已知限制

- 不支持并发执行（`concurrency` 只允许 1）。
- `--command` 的确认清单是“预览时”的快照；从预览到加 `--yes` 重跑之间任务队列可能变化。
  这是人工确认模型的固有窗口，不是原子锁。
- 确认只在启动时做一次：如果启动时队列为空，后续新进入的 pending 任务不会再要求
  `--yes`；需要严格人工放行时，应先确认队列为空再启动，或使用带匹配条件的配置文件。
- 连续同因失败是启发式熔断，不分析语义根因；stderr 首行带时间戳/任务 ID 等动态内容
  时不会触发，需看日志人工判断。
- 后台模式下父进程在实例就绪时已经返回 0；之后发生熔断时，子进程的退出码 1 只体现在
  日志/registry 消失上。守护系统要监控日志或实例存活，不能只看 `start --daemon` 的返回码。
- `--create-task` 的幂等键是“通道 + 标题”的长期键：任务完成后用同一标题再启动不会新建任务。要建新任务请换标题。
- `--ensure-channel` 不平滑“通道参数”和“认领过滤器”：创建/复用通道不等于只处理该通道，过滤仍由 `--channel`/`channels` 决定。
- 后台 `start --daemon` 的 `channel.upsert` / `task.create` 在子进程内执行；父进程只等实例就绪就返回 0，因此初始化失败要去日志里看，不能只看父进程返回码。
- Claude 会话续接未在真实 Claude 会话上做端到端验证；不同版本的实际参数解析与错误文案可能变化。回退检测依赖已知文案，识别不到时会按普通失败处理。
- resume 失败回退会**再次执行同一条命令**。如果命令在报“会话不存在”之前已经产生外部副作用，可能重复；只对会话错误做一次重试是为了避免留下坏任务，但不等于幂等保证。
- Claude 识别是保守启发式：shell 形式要求命令开头或分隔符后**直接**是 `claude`（`cmd /c`、`sudo` 等包装不识别）；argv 形式支持直接 `claude`、`node`/`python` 启动 `claude-*` 脚本、`npx claude`。需要续会话时请按这些形式调用。
- `--create-task` 不会自动补 `tags`。如果 `commands.match` 只接受特定 tags，任务会创建但不会被认领；启动日志会 WARN，请同时用 `--command`（match_all）或调整匹配规则。
- 当前服务端没有 `task.get` 工具：runner 先用 claim 返回的任务视图，缺失时按
  `channel_key + status=claimed + include_description` 翻页查找；都没有则退回 claim 字段。
- `logs -f` 在 Windows 上依赖轮询文件大小，不是文件系统事件。
- 没有 Windows 服务/launchd/systemd 集成；需要开机自启请自行用系统计划任务包裹 `start --daemon`。

## 开发与测试

```bash
npm test                 # node --test "tests/*.test.js"（单元 + 真实 HTTP fake MCP 集成）
```

测试不访问真实 8787 服务；所有实例数据目录都指向临时目录，不读写 `~/.aidash`。
