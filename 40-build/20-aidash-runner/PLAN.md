# aidash-runner 实现计划（交付顺序第 1 步）

> 本文件先落计划，再写代码。包内运行时零第三方依赖，ESM，Node >= 24。
> 不 import 服务端源码、不读数据库、不启动/停止真实 8787 服务。

## 1. 目标与边界

- 一个配置文件 = 一个 harness = 一个实例；不做中心 daemon。
- 每个实例自己写 registry、自己起控制面（仅 127.0.0.1）。
- 前台/后台都可见、可查询、可控制；后台父进程等待子进程 `/health` 就绪后退出。
- 子进程环境默认白名单，绝不继承 `AIDASH_TOKEN` / `AIDASH_LLM_API_KEY`。
- MCP 只走 `initialize` / `notifications/initialized` / `harness.register` /
  `harness.heartbeat` / `task.list` / `task.get(可选)` / `task.claim` /
  `task.update` / `task.release` / `card.post`，可选 `digest.get`。

### 规格冲突与取舍

1. 规格的 MCP 最小接口写了 `task.get`，但服务端 23 个工具里没有这个工具
   （`40-build/10-aidash/src/server/mcp/tools.ts` 只有 task.create/update/list/tree/
   claim/release/move/copy）。实现策略：
   - 连接后尝试 `tools/list`；只有它确实声明了 `task.get` 才调用；
   - 否则用 `task.claim` 返回的任务视图（服务端 `toView` 含完整描述）；
   - 仍缺 `description_md` 时再用 `task.list({status:"claimed", assignee, include_description:true})`
     兜底。绝不因为一个不存在的工具让整个任务失败。
2. 规格要求 `AIDASH_TOKEN` 优先于 `--token/--key`。按规格实现，但在两者同时存在时
   明确警告“环境变量优先、命令行令牌已忽略”，避免用户以为传了就生效。
3. 规格要求 registry 字段含 `control_token`，同时硬约束“不许把 token 写进 registry”。
   这里区分两类令牌：`control_token` 是本机控制面的随机 32 字节令牌，必须落 registry
   才能让 CLI 访问控制面；**MCP 的 `AIDASH_TOKEN` 绝不落盘、绝不进日志/配置/卡片**。
4. `--json` 下 `start` 只输出一行就绪 JSON，harness 实时输出不再写 stdout（仍写日志），
   保证 stdout 可被脚本直接 `JSON.parse`。人工模式仍实时转发。

## 2. 文件结构

```text
40-build/20-aidash-runner/
  package.json              # bin / files / engines / type / scripts.test
  aidash-runner.example.json
  README.md
  PLAN.md
  bin/aidash-runner.mjs     # 唯一入口；bin 暴露 aidash-runner + aidash-watch
  src/
    version.js              # 从 package.json 读版本
    constants.js            # 默认值、限制、敏感键、环境白名单
    errors.js               # Config/Auth/Transport/Business/Control 错误分层
    util.js                 # 类型守卫、sleep、sha256、绝对路径、实例 id
    redact.js               # 脱敏 + ANSI 去除 + 截断
    args.js                 # 全命令参数解析
    config-parse.js         # 配置 schema 校验（含 match/run）
    config.js               # 配置查找顺序、CLI 覆盖、默认值、token 解析
    config-keys.js          # config set 白名单、原子持久化、reload 应用
    match.js                # 规则匹配、defer 判定、候选排序
    ring-buffer.js          # 首 8KB + 尾 8KB
    logger.js               # stderr + 文件，统一脱敏
    mcp-client.js           # 零依赖 Streamable HTTP JSON-RPC 客户端
    task-file.js            # {task_file} JSON/MD 临时文件 + 清理
    exec.js                 # spawn / 输出回调 / 超时 / 进程树终止
    registry.js             # instances/<id>.json 原子写 0600 + 存活验证
    control-server.js       # 回环控制面 + Bearer
    control-client.js       # CLI 调控制面
    report.js               # status 卡、失败原因、幂等键
    failure-policy.js       # 纯函数：什么情况 release/fail/block/complete
    task-runner.js          # 单任务：claim 后 start→spawn→续租→卡→终结
    runner.js               # 注册、心跳、轮询、退避、任务级错误隔离
    instance.js             # 实例解析、list/status/stop/kill 共用逻辑
    daemon.js               # detached 子进程 + 等待 /health
    cli/
      main.js               # 命令分发
      output.js             # --json / 人类可读输出
      commands-start.js     # start / __run / once / dry-run
      commands-query.js     # list / status / pull / logs
      commands-control.js   # stop / kill / config get|set|reload
      commands-init.js      # init / check
  tests/
    helpers/fake-mcp.js     # 真正的 node:http fake MCP（内存任务/卡/状态机）
    helpers/harness.js      # 临时目录、CLI 调用、runner 启停、等待器
    unit-*.test.js
    integration-*.test.js
```

每个文件 < 400 行、单函数 < 50 行为目标；按职责拆，不做一个“上帝模块”。

## 3. 命令面

```text
start [--config] [--daemon] [--harness-id] [--name] [--url]
      [--token|--key|--token-file] [--poll] [--lease] [--heartbeat] [--gap]
      [--channel] [--command] [--cwd] [--log-file] [--data-dir]
      [--no-prefix] [--json]
once        （同 start 的非守护参数；跑一轮最多一个任务，不注册/不起控制面）
dry-run     （只读：列出将认领/跳过的任务及原因）
list [--json] [--all]
status [id] [--json]
stop [id] [--all] [--force]
kill [id] [--all]
pull [id] [--wait] [--json]
config get [id] [--json]
config set [id] <key> <value> [--persist]
config reload [id]
logs [id] [-f] [--lines <n>] [--json]
init [--config] [--force] [--json]
check [--config] [--json]
--version / --help
```

- 所有命令接受 `--json`；`--data-dir` 在所有需要 registry 的命令上都可用。
- 单实例可省略 id；多实例时报错并列出候选；`stop/kill` 支持 `--all`。
- 默认值：URL `http://127.0.0.1:8787/mcp`、poll 5、lease 900、heartbeat 60、
  gap 2、command timeout 1800；harness_id `watch-<hostname>`、name `<hostname>`。
- 配置顺序：`--config` > `AIDASH_RUNNER_CONFIG` > `./aidash-runner.json` >
  `~/.aidash/runner.json`。
- token 顺序：`AIDASH_TOKEN` > `--token/--key` > `--token-file`。
- 无配置且无 `--command`：明确提示 `init` 或 `--command`，退出码 2。
- 退出码：0 正常；1 业务/任务失败；2 配置、认证、传输等“本次不该继续”。

## 4. 配置 schema

```json
{
  "aidash_url": "http://127.0.0.1:8787/mcp",
  "token_env": "AIDASH_TOKEN",
  "harness_id": "watch-01",
  "name": "本机值守壳",
  "host": "win-dev-01",
  "capabilities": [],
  "channels": [],
  "poll_interval_seconds": 5,
  "lease_seconds": 900,
  "heartbeat_interval_seconds": 60,
  "gap_seconds": 2,
  "command_timeout_seconds": 1800,
  "data_dir": "",
  "log_file": "",
  "env_passthrough": ["PATH", "HOME", "TMPDIR", "SystemRoot", "ComSpec"],
  "commands": [{
    "name": "claude-auto",
    "match": {
      "tags": ["auto"], "title_prefix": "[自动]", "channel_key": "myhost/*",
      "priority": ["P0", "P1", "P2"], "kind": ["task"], "match_all": false
    },
    "run": {
      "argv": ["node", "C:/tools/run-claude.mjs", "{task_file}"],
      "cwd": "F:/work/myproj",
      "input": "file",
      "stdin": "task_json",
      "timeout_seconds": 1800,
      "env": {},
      "env_passthrough": [],
      "result_file": "",
      "shell": false
    }
  }]
}
```

校验规则：
- 无条件（tags/title_prefix/channel_key/priority/kind 都为空）必须 `match_all=true`。
- `argv` 非空字符串数组；默认不走 shell；`shell:true` 时按 shell 字符串执行并警告。
- `{task_file}` 指向临时 JSON；同时提供 `{task_md_file}`；命令结束清理。
- `input`: `file`(默认)/`stdin`/`none`；`stdin`: `task_json`(默认)/`task_md`。
- `result_file` 读 `{summary, detail_md, result}`；缺失/非法时回退退出码+首尾输出。
- `env` 中出现 `*_TOKEN|*_SECRET|*_KEY|*_PASSWORD` 直接报配置错。
- 未知字段给 warning，不静默改语义；敏感键（token/api_key 等）直接拒绝。

## 5. 进程注册与控制协议

- 数据目录：`--data-dir` > `AIDASH_RUNNER_HOME` > `~/.aidash/runner`。
- 实例文件：`<data>/instances/<instance_id>.json`，字段：
  `instance_id, pid, mode, harness_id, config_path, control_url, control_token,
  log_file, started_at, version`；目录 0700、文件 0600、temp+rename。
- 存活判定：PID 存活 + `/health` 可达 + `health.started_at/harness_id/pid`
  与 registry 一致（三者一起防 PID 复用）。stale 只展示，不自动删除；
  `list --all` 展示 stale 并给原因。
- 控制面：`http.createServer`，`listen(0,"127.0.0.1")`，token 为
  `crypto.randomBytes(32)`；所有端点校验 `Authorization: Bearer <control_token>`。
- 端点与方法：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 存活指纹：instance/pid/started_at/harness/version/mode/busy/current_task/queued |
| GET | `/status` | health + 配置（脱敏）+ 上次拉取/心跳/错误 |
| POST | `/pull` | 忙时 `{queued:true}`；空闲时触发一次迭代 |
| POST | `/stop` | `{force?}`；优雅停止/强杀，收尾后删 registry |
| POST | `/config` | `{key,value,persist?}`；白名单、需重启键 409 |
| POST | `/reload` | 重读配置文件，返回 applied / requires_restart |

- 请求体上限 64KB；非法 JSON 400；未授权 401；未知路由 404。
- `config set` 运行时可改：poll/gap/lease/heartbeat/command_timeout/channels；
  需重启：url/harness_id/name/host/data_dir/log_file/env_passthrough/commands。
- `--persist` 先校验合并后的配置，再同目录 temp + rename 原子写回。
- `stop`：停止拉取 → abort 当前进程树 → 收尾 → 删除 registry；
  `kill`：优先控制面 force；控制面不可达且 PID 存活时，因无法完成三重指纹校验，
  不盲目按 PID 杀进程（避免 PID 复用误杀），报告 stale 并提示人工确认。

## 6. 数据流与失败策略

```text
task.list(pending)
  → 过滤 assignee / channels / defer / 规则匹配
  → 排序（P0..P3，due_at，id）
  → task.claim（ALREADY_CLAIMED 换下一个）
  → 取任务详情（claim 结果 / 可选 task.get / task.list 兜底）
  → 写 task_file
  → task.update(start)
  → spawn（ignore/pipe/pipe；前台转发 + 日志 + 首尾 8KB 环）
  → 周期 task.claim 续租
  → card.post(status, idempotency_key = claim_token 派生)
  → complete / fail / block
```

逐条落实：

| 情况 | 行为 |
|---|---|
| defer_reason 非空且 deferred_until 未到（或无期限） | 跳过；dry-run 也打印原因 |
| 命令未启动就失败（spawn error） | `task.release` |
| 命令已启动后发卡/complete 失败 | **绝不 release**；尝试 `block` 并写“命令已执行但证据回报失败”；再失败只记录 |
| 证据卡幂等键 | `runner-<task>-<sha256(claim_token) 前 24 位>`，不用 Date.now() |
| 租约丢失 | 杀进程树，不 release，记录后继续下一任务 |
| 401 | 立即停：杀命令、停心跳、不再发任何 MCP 请求、退出码 2 |
| 传输错误 | 指数退避（1s 起、x2、上限 60s）+ ±20% jitter，不退出 |
| 任务级 BusinessError | 记录并继续下一个任务，不打死常驻进程 |
| 连续 5 次不可恢复的循环级错误 | 退出码 1（配置/认证仍立即退出 2） |
| 用户 stop/kill 时命令已启动 | 杀树、**不 release**（命令已执行，避免重复执行） |

## 7. 输出与脱敏

- spawn `['ignore','pipe','pipe']`，绝不 `stdio:'inherit'`。
- 每块输出：前台实时转发 / 后台写日志 / 同时进首尾各 8KB 环形缓冲。
- 写终端与日志前脱敏：当前 `AIDASH_TOKEN`、`AIDASH_LLM_API_KEY`、形如
  `*_TOKEN|*_SECRET|*_KEY|*_PASSWORD` 的 `KEY=VALUE`、`Bearer <长串>`。
- 卡片正文去 ANSI；summary ≤ 2000 字符，detail_md ≤ 64KB。
- 前缀 `[task_id] ` 默认开，`--no-prefix` 关；日志默认
  `<data>/logs/<instance_id>.log`，前台实例也写同一文件。

## 8. 测试清单

单元（`node --test`）：
1. 配置查找顺序/默认值/CLI 覆盖/token 顺序/非法配置/敏感 env。
2. match：tags AND、title_prefix 大小写、channel `前缀/*`、priority/kind、
   match_all 强制、defer 跳过、优先级排序。
3. 脱敏与 ANSI、截断、环形缓冲首尾 8KB。
4. task_file JSON/MD 内容与清理。
5. exec：成功/失败/超时/abort/未启动，输出回调。
6. registry：原子写、0600（非 Windows 断言）、读写、stale 判定。
7. 控制协议：无 token 401、健康指纹、pull/stop/config/reload、仅回环。
8. 失败策略纯函数：未启动 release、已执行不 release、租约丢失不 release、
   卡失败 block、成功 complete。
9. 幂等键稳定性（同一 claim_token 不变、不同 token 变化）。

集成（真正的 `node:http` fake MCP，内核分配端口）：
1. 前台 start → list 可见 mode=foreground。
2. 后台 start --daemon → list 可见 mode=background。
3. pull 强制触发（首次轮询后再加任务）。
4. config set 修改 poll/channels 并 --persist 写回文件。
5. stop 优雅退出 + registry 删除 + 命令已启动不 release。
6. kill --force 结束长命令与进程树。
7. defer 任务不被认领。
8. 命令执行后 complete 失败 → 不 release，任务进入 block 且理由含“证据回报失败”。
9. 401 → 停止、退出码 2、不再请求。
10. 输出写日志并脱敏，卡片正文无 ANSI。
11. 子进程环境不含 AIDASH_TOKEN / AIDASH_LLM_API_KEY（脚本自检）。

npm 验收：`npm pack` 含 bin/src/README/example；`npm i -g --prefix <临时目录>`
后从临时 prefix 跑 `--help` 与 `list --json`（不污染真实全局）。

回归：`pnpm -C 40-build typecheck`、`pnpm -C 40-build test`。

## 9. 实施顺序

1. 本计划（已完成）。
2. 基础层：constants/errors/util/redact/args/config/match/ring/logger。
3. 执行层：mcp-client/task-file/exec/failure-policy/report/task-runner/runner。
4. 实例层：registry/control-server/control-client/instance/daemon。
5. CLI 命令层与 README/example。
6. 单元测试 → fake MCP + 集成测试 → npm pack/install 验收。
7. 回归与报告（含未验证项）。
