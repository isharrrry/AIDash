# aidash-manager

AIDash 的本地管理台：一个可执行文件（CLI）+ 一个独立 Web 页面，用来管理**多个 AIDash 服务端**与**多个 runner 值守壳**。

- **零第三方运行时依赖**：只用 Node 内置模块；Web 用 React 19 + Vite 构建，产物随包发布。
- **无参启动即用**：`node bin/aidash-manager.mjs` 会自动起 Web、打印带令牌的访问链接并打开浏览器。
- **与 AIDash Web 分离**：管理台有自己的页面与端口（默认 `4280`），技术栈与 AIDash Web 相同（React 19 + Vite 8 + TypeScript）。
- **多实例**：同一台机器上可以登记多个 AIDash（为后续级联准备）和多个 runner，各自使用独立的配置、数据目录与端口。
- **配置友好**：必填项与就地错误提示、目录与端口探测、服务重名检查、AIDash 环境变量/配置文件双模式、runner 配置校验，以及“常用字段 / 原始 JSON”双向同步编辑。
- **日志与异常**：实时跟随日志，并按错误签名归并出“异常简要”。

> 本包不替代 `aidash-runner`，也不替代 AIDash 服务端；它只是把二者的启动、配置和排障收拢到一个本地入口。
> `aidash-runner` 与 AIDash 的安装、配置字段、安全边界仍以各自 README 为准。

---

## 快速开始

```bash
# 1) 本仓源码：先装工作区依赖并构建一次 Web 产物（web-dist 不入库）
pnpm -C 40-build install
pnpm -C 40-build manager:build

# 2) 启动（CLI 运行时零第三方依赖，构建完成后不依赖 node_modules）
node 40-build/30-aidash-manager/bin/aidash-manager.mjs

# 或者从仓库根执行
pnpm -C 40-build manager:start

# 3) 从 GitHub Packages 安装（需要 read:packages 权限的令牌）
npm config set @isharrrry:registry https://npm.pkg.github.com
npm login --registry=https://npm.pkg.github.com --scope=@isharrrry
npm install -g @isharrrry/aidash-manager
aidash-manager

# 或直接安装 Release 附件里的 tgz
npm install -g ./aidash-manager-*.tgz
```

启动后会打印：

```text
AIDash Manager v0.1.0 已启动
  管理台: http://127.0.0.1:4280/?token=...
  数据目录: C:\Users\<你>\.aidash\manager
```

浏览器会自动打开该链接。首次用 `?token=` 鉴权后，管理台会把它换成 HttpOnly Cookie，地址栏不再保留令牌。

常用参数：

```bash
aidash-manager web --port 4280 --web-host 127.0.0.1   # 指定端口/监听地址
aidash-manager web --no-open                          # 不自动打开浏览器
aidash-manager --help                                 # 完整 CLI 帮助
```

默认端口被占用时会自动向后找空闲端口；显式传 `--port` 则严格使用该端口，冲突直接报错。
想让默认端口也“失败即报错”，加 `--strict-port`。
`--web-host` 支持 `0.0.0.0` 等通配地址：监听所有网卡，但提示与自动打开的地址仍用 `127.0.0.1`。

---

## 它管理什么

### AIDash 服务端

每个服务记录包含：数据目录（工作目录）、程序目录、服务端入口、监听地址/端口、数据库路径、备份目录、静态资源目录、配置文件路径与配置模式。

- **程序与数据分离**：工作目录（`--cwd`）只承担数据——SQLite 库、备份、配置文件都在这里；服务端程序由管理台解析，不会再去工作目录里找。
  程序探测顺序：服务配置的「程序目录」/「服务端入口」→ `AIDASH_APP_DIR` / `AIDASH_SERVER_ENTRY` → 管理台同装/同仓的 AIDash（`<manager>/../10-aidash`、仓库或部署根）→ 已登记 AIDash 服务正在使用的程序。
  找不到程序时，启动错误会列出已检查的位置，并提示到「程序目录」里指定 AIDash 安装目录（含 `server/dist` 或 `dist`）。
- **旧记录自动修复**：旧版本在数据目录里找不到程序时会猜成 `40-build/10-aidash/...`。这类猜测路径在服务启动/保存时会按数据布局重算，并回写服务定义；文件模式下还会同步修正配置文件里的 `db_path` / `backup_dir` / `static_dir`。
- **环境变量模式**（默认）：启动时注入 `AIDASH_HOST` / `AIDASH_PORT` / `AIDASH_DB_PATH` / `AIDASH_BACKUP_DIR` / `AIDASH_STATIC_DIR` / `AIDASH_LOG_LEVEL`。
- **配置文件模式**：写入 `aidash.config.json`，启动时只设 `AIDASH_CONFIG`，不再注入上述同名环境变量（否则环境变量会覆盖文件，模式名就名不副实）。
  该模式要求 AIDash 的 `dist` 旁边能按相对路径找到 `00-platform/config/schema/aidash-config.schema.json`（源码构建默认满足）。如果目标机只拷贝了 `server/dist`，请改用环境变量模式，或把 `00-platform/config/schema` 一并复制到部署目录。
- 令牌永远只通过 `AIDASH_TOKEN` 传入，不写配置文件、不回显、不进入日志。
- 启动前会做端口占用检查；启动后以 `GET /healthz` 判定是否真正可用。
- 停止时结束整个进程树（Windows 用 `taskkill /T`，POSIX 用进程组），避免留下 SQLite WAL 或 worker 子进程。
- 端口上已有、但不是管理台拉起的 AIDash 会显示为 `external`：可以查看地址、健康与日志，但不能停止；删除这种登记只移除管理台记录，不会触碰外部进程。

多个 AIDash 实例只需要使用不同端口与不同的 `db_path` / `backup_dir`；在管理台里各自建一条服务即可。后续做 AIDash 级联时，runner 的 MCP 地址可以指向其中任意一个实例。

### Runner 值守壳

每个 runner 记录包含：`aidash-runner.json` 路径、`harness_id`、AIDash MCP 地址、通道过滤、任务匹配规则、轮询/租约/心跳/超时、数据目录与日志文件。

- 创建时可以选择 harness 模板，管理台直接生成符合 `aidash-runner` 规则的配置文件。
- 启动走 runner 自己的 `start --daemon`；状态读 runner 的 registry 与控制面，而不是仅看 PID。
- 停止优先请求控制面优雅退出，失败再结束进程树。
- 每个 runner 默认拥有独立的 `data_dir`（`~/.aidash/manager/services/<id>/runner-data`），不会与同机的其它 runner 抢 registry。
- **通道过滤不等于创建通道**：`通道过滤`（runner 配置里的 `channels`）只决定认领哪些任务，不会在 AIDash 中建通道。要创建/复用通道，在新建向导或配置页的“创建/复用通道”里填精确 `channel_key`（可配“通道标题”）；管理台启动 runner 时把它转成 `--ensure-channel` / `--channel-title`，由 runner 调 `channel.upsert` 创建。若两者都填，建议保持同一个 key。
- **轮询可见**：runner 在 INFO 级别记录“轮询配置”和“轮询抓取：第 N 次，pending/计划/跳过（通道过滤）”；首轮、结果变化和每 5 分钟至少各一条，管理台日志页无需开 debug 就能确认 runner 在抓任务。服务概览还会显示控制面的轮询次数、已认领/已完成计数。

#### 内置 harness 模板

| key | CLI | 非交互用法 | 凭据提示 |
|---|---|---|---|
| `claude` | Claude Code CLI | `claude --dangerously-skip-permissions -p "<prompt>"` | 先 `claude` 登录，或使用 CLI 自己的配置 |
| `codex` | OpenAI Codex CLI | `codex exec --full-auto --skip-git-repo-check "<prompt>"` | 先 `codex login`，或配置 `~/.codex` |
| `dsh` | DeepSeek Harness | `dsh --profile headless "<prompt>"`（等价的简写为 `dsh headless "<prompt>"`） | 先在 `dsh web` 的 Models 页写入 `$DSH_HOME/.credentials.yaml`，或在 runner 工作目录放 `.env` 写 `DEEPSEEK_API_KEY` |
| `narnat` | NarnatAgent | `narnat -p "<prompt>"` | 编辑 Narnat 程序目录下 `.narnat/config/narnat.json` 的“接口密钥”（也可用 `NARNAT_HOME` 指定 `.narnat` 目录） |
| `custom` | 自定义 | 自行填写 argv 数组 | 由自定义命令自行处理 |

说明：

- 模板只负责把 `{task_file}` 交给 CLI，并要求它把结果写到 `{result_file}`；不会自动安装任何 CLI。
- 命令以 **argv 数组**保存，不经过 shell，Windows 引号问题不会影响模板。
- `dsh` 的 headless profile 会按“继承环境 → `$DSH_HOME/.credentials.yaml` → 项目/用户 `.env`”读取密钥。runner 的子进程环境白名单**刻意不放行** `*_KEY`/`*_TOKEN`，所以请用 `$DSH_HOME/.credentials.yaml` 或工作目录 `.env`。
- `narnat` 的 `-p/--prompt` 是单轮 headless（不读 stdin、不保存会话）。需要完成验证与自动续跑时追加 `-g N`（`--goal-rounds N`，审核模式，N 为续跑预算，`0` 等同不开启）；不带 `-g` 时末行 `reason=done` 只表示执行结束，不保证任务达成。headless 退出码：`0` 正常收尾（含 `round_limit`）、`1` 参数/启动错误、`2` 任务级失败。
- Narnat 发行包以 Windows 为主；Linux 可按其 README 从源码构建（glibc ≥ 2.35）。
- 模板参数会随 CLI 版本变化；页面里可直接改 argv，或切换到“原始 JSON”编辑完整配置。

---

## Web 页面

- **总览**：每个服务一张卡片，显示运行状态、地址、PID、运行时长与最近错误；支持启动/停止/重启/打开网页。
- **新建向导**：选择 AIDash 或 Runner → 填名称/数据目录（AIDash 可另填程序目录）→ 自动探测程序与数据默认路径 → 选择模板/配置项 → 填令牌。
- **配置页**：
  - AIDash：环境变量/配置文件模式一键切换；常用字段表单；完整 JSON 编辑；保存前按 AIDash 官方 Schema 校验。
  - Runner：模板选择与“重新应用模板”；连接/节奏表单；任务匹配编辑；命令预览；JSON 编辑；保存前按 runner 约束校验。
- **日志页**：选择日志来源、行数、自动刷新、只看异常/警告、文本过滤、下载。
- **异常摘要**：按错误签名归并最近 2000 行，显示次数与样例行号。
- **令牌管理**：在服务概览页更新 `AIDASH_TOKEN`，只写本机 `secrets.json`。
- **自动刷新**：服务状态/总览每 4 秒刷新一次，日志页每 2 秒、异常摘要每 5 秒（均可在页面上关掉日志自动刷新）；页面不可见时暂停请求，切回前台自动恢复，不需要手动点「刷新」。

页面默认只监听 `127.0.0.1`。管理台访问令牌在数据目录的 `web-token`（默认 `~/.aidash/manager/web-token`），可用 `--web-host` 改监听地址（跨机访问请自行加 TLS/反向代理）。

---

## CLI

```bash
aidash-manager                          # 启动管理台 Web + 打开浏览器（默认命令）
aidash-manager web [--port 4280] [--web-host 127.0.0.1] [--no-open] [--strict-port]
aidash-manager list                     # 服务与运行状态
aidash-manager status <id|name>         # 单个服务详情
aidash-manager start <id|name>
aidash-manager stop <id|name>
aidash-manager restart <id|name>
aidash-manager remove <id|name> [--force]   # 只移除记录，不删配置文件/数据库/日志
aidash-manager logs <id|name> [--lines 200] [--follow|-f] [--source auto|manager|runner]
aidash-manager config get <id|name>
aidash-manager config set <id|name> <key> <value>
aidash-manager templates
aidash-manager open [id|name]
```

创建服务（也可以只用 Web）：

```bash
# AIDash：cwd 是数据目录；程序由管理台自动提供（也可用 --app-dir 显式指定）
aidash-manager add aidash --name "本机 AIDash" --cwd "D:/data/aidash" --port 8787 \
  --token "至少8位口令"

# 显式指定程序目录与文件模式
aidash-manager add aidash --name "AIDash B" --cwd "D:/data/aidash-b" --app-dir "D:/app/AIDash" \
  --port 8788 --config-mode file --config-path "D:/data/aidash-b/aidash.config.json" --token "..."

# Runner：使用 Claude 模板；不把令牌放进命令行时可用 --token-source env
aidash-manager add runner --name "Claude 值守" --cwd "D:/work/project" \
  --template claude --url "http://127.0.0.1:8787/mcp" --harness-id claude-app \
  --channels "devhost/myproj/topic" \
  --ensure-channel "devhost/myproj/topic" --channel-title "我的话题" \
  --token-source env
```

`--channels` 只是认领过滤；`--ensure-channel` 才会在 runner 启动时创建/复用 AIDash 通道（可加 `--channel-title`）。

`add runner` 的 `--data-dir` 是该 runner 的数据目录（默认 `~/.aidash/manager/services/<id>/runner-data`，每个服务独立）；管理台自己的数据目录用全局参数 `--home` 指定，两者不要混用。

除流式输出的 `logs --follow` 外，所有命令都支持 `--json`（`--version` / `--help` 也输出同一信封）；成功信封是 `{ok:true,data}`，失败是 `{ok:false,error:{code,message,details}}`。

---

## 数据与安全

管理台数据目录默认 `~/.aidash/manager`，可用 `--home` 或 `AIDASH_MANAGER_HOME` 覆盖：

| 路径 | 内容 | 权限 |
|---|---|---|
| `manager.json` | 服务清单（不含令牌） | 0600 |
| `secrets.json` | 按服务 id 保存的 `AIDASH_TOKEN` | 0600 |
| `web-token` | 管理台网页访问令牌 | 0600 |
| `web-runtime.json` | 当前管理台 Web 的地址与 PID（供 `open` 使用） | 0600 |
| `logs/<id>.log` | 管理台拉起的进程 stdout/stderr | 0600 |
| `run/<id>.json` | PID、启动时间、最近退出码 | 0600 |
| `services/<id>/` | runner 默认 data_dir / 日志 / 会话状态 | 0700 |

安全边界：

- 管理台默认只监听 `127.0.0.1`；跨机访问是显式选择，需自行配置 TLS/反向代理。
- API 需要访问令牌；写请求同时校验 `Origin` 与 `Content-Type`，配合 `SameSite=Strict` Cookie 防止本机其它网页的 CSRF。
- 令牌不会出现在 `manager.json`、配置页面响应、日志或错误信息里；接口只返回 `hasToken`。
- 删除服务只删除管理台记录，不删除用户的配置文件、数据库、备份或日志——这是刻意的，避免误删证据。
- 管理台退出不会停止由它拉起的服务；服务继续按自己的配置运行。

---

## 与 npm 发布

本仓一次 Release 产出三类发布物，彼此独立、互不替代：

| 发布物 | 形态 | 作用 |
|---|---|---|
| `aidash-dist.tar.gz` | Release 附件 | AIDash 服务端 + Web，是被管理的目标 |
| `aidash-runner-<version>.tgz` | Release 附件；GitHub Packages `@isharrrry/aidash-runner` | 值守壳：向 AIDash 认领任务并拉起本地 harness |
| `aidash-manager-<version>.tgz` | Release 附件；GitHub Packages `@isharrrry/aidash-manager` | 本管理台：登记、启停、配置、看日志，不执行任务 |

管理台与 runner 的关系：manager 只负责把服务端与 runner 跑起来、配好、看清日志，**不替代** runner 的任务轮询与 harness 执行；runner 也不依赖 manager，可以单独安装运行。三者可以在同一台机器共存，也可以分开部署。

`aidash-manager` 是独立 npm 包，包内包含：

```text
bin/         CLI 入口
src/         零依赖服务端与 CLI
web-dist/    Vite 构建后的 Web 产物
README.md
```

构建与打包：

```bash
# 在仓库根：
pnpm -C 40-build install
pnpm -C 40-build manager:build     # 同步 Schema + 构建 web-dist
pnpm -C 40-build manager:test

# 打包检查（先看清单，再真正打包）
cd 40-build/30-aidash-manager
npm pack --dry-run
npm pack
```

发布流水线与 `aidash-runner` 的打包/发布步骤放在同一个 Release workflow 中；`aidash` 服务端仍以 release 附件（`aidash-dist.tar.gz`）形式发布。

---

## 开发

```bash
pnpm -C 40-build install
pnpm -C 40-build manager:dev       # Vite 开发服务器（默认 4281，/api 代理到 4280）
pnpm -C 40-build manager:start     # 另开终端，启动管理台 API 与静态托管
pnpm -C 40-build manager:build
pnpm -C 40-build manager:test      # node --test
pnpm --filter aidash-manager-web exec tsc --noEmit
```

布局：

```text
30-aidash-manager/
├─ bin/aidash-manager.mjs   唯一 CLI 入口
├─ src/
│  ├─ cli/main.js           参数解析与命令分发
│  ├─ api.js                HTTP API：服务、配置、日志、异常
│  ├─ server.js             静态托管 + 令牌鉴权 + 端口回退
│  ├─ process.js            AIDash / runner 生命周期
│  ├─ service.js            服务模型、字段校验、路径探测
│  ├─ aidash-config.js      AIDash 配置 Schema 校验与读写
│  ├─ runner-config.js      runner 配置校验与模板生成
│  ├─ templates.js          Claude/Codex/dsh/Narnat 模板
│  ├─ logs.js               日志尾读与异常归并
│  └─ schema/               随包发布的 AIDash 配置 Schema
├─ web/                     React + Vite 前端源码
├─ web-dist/                构建产物（npm 包内）
└─ tests/                   node --test 用例
```

---

## 已知限制

- 管理台只管理**本机**进程；跨机部署请各自运行一个管理台，或后续做远端代理。
- AIDash 服务端没有远程停止 API；管理台通过进程树结束它。在 Windows 上这是强制终止，SQLite WAL 恢复由数据库自身负责。
- 配置 Schema 是随包副本；如果目标 AIDash 版本升级后新增配置键，管理台可能先报“未知键”。此时请升级管理台，或暂时用原始 JSON 编辑并确认服务端版本。
- 日志异常摘要是启发式的：结构化日志按 `level` 判定，非结构化文本按关键词兜底；它用于快速扫一眼，不替代完整日志。
- 尚未做 Electron/桌面封装；浏览器标签页就是 GUI。
