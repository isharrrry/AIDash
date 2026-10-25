# 配置

> 配置优先级：**环境变量 > 配置文件 > 页面设置（setting 表）> 内置默认**。越靠前越优先，便于用环境变量临时覆盖而不改文件。

## 1. 快速启动

**依赖**：Node ≥ 24、pnpm 12.4.1。SQLite 由 `better-sqlite3` 内置，不需要单独安装数据库。

```bash
# 1) 安装依赖
pnpm -C 40-build install

# 2) 构建服务端 + 前端（CLI 可选）
pnpm -C 40-build build
pnpm -C 40-build web:build
pnpm -C 40-build cli:build

# 3) 设置令牌（只从环境变量读，不要写进仓库或脚本）
#    Windows（当前终端）：
set AIDASH_TOKEN=<你的令牌>
#    macOS / Linux：
export AIDASH_TOKEN=<你的令牌>

# 4) 启动
pnpm -C 40-build start          # 等价于 node 40-build/10-aidash/dist/server/main.js
```

打开 `http://127.0.0.1:8787/`，在设置页把同一个令牌填进页面即可。

**Windows 推荐用启动脚本**：

```powershell
pnpm -C 40-build start:win
```

它会先把数据库、备份、静态目录解析成绝对路径并打印，再启动服务；不会打印令牌。脚本必须保持 **UTF-8 with BOM** 编码，否则 PowerShell 会按本地代码页解析中文而报错。

## 2. 环境变量

### 2.1 必填

| 变量 | 说明 |
|---|---|
| `AIDASH_TOKEN` | 唯一访问令牌（Bearer）。缺失时进程 fail-fast 退出。只从环境变量或配置文件读取，页面回显只有“已配置/未配置” |

### 2.2 服务与路径

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AIDASH_HOST` | `127.0.0.1` | 监听地址。改成 `0.0.0.0` 前请先配好 TLS / 反向代理 |
| `AIDASH_PORT` | `8787` | 监听端口 |
| `AIDASH_DB_PATH` | `./10-aidash/data/aidash.db` | SQLite 文件路径（相对启动目录） |
| `AIDASH_BACKUP_DIR` | `./10-aidash/backups` | 备份目录；迁移前自动备份也落在这里 |
| `AIDASH_STATIC_DIR` | `./10-aidash/dist/web` | Web 静态资源目录 |
| `AIDASH_ALLOW_EMPTY_DB` | `false` | 库文件不存在但备份目录有 `*.db` 时，默认**拒绝启动**；设 `true` 才允许建空库 |
| `AIDASH_CONFIG` | `./aidash.config.json` | 配置文件路径 |

### 2.3 知识库与增强

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AIDASH_KB_ROOT` | 空 | OKF 知识库根目录；**只读**，服务不写该目录 |
| `AIDASH_KB_INDEX_INTERVAL` | `300`（秒） | 增量索引间隔，取值 30~86400 |
| `AIDASH_ENRICHMENT_ENABLED` | `true` | 关闭后不再调用 LLM；没有配置 key 时即使开启也只会 `skipped` |
| `AIDASH_LLM_ENDPOINT` | `https://api.deepseek.com/v1/chat/completions` | 任意 OpenAI 兼容端点 |
| `AIDASH_LLM_MODEL` | `deepseek-flash` | 模型名 |
| `AIDASH_LLM_MODE` | `max` | `fast` / `standard` / `max`，影响提示词与推理预算 |
| `AIDASH_LLM_API_KEY` | 空 | 也可以改在页面设置里保存（加密后存本机 `~/.aidash`，不进数据库与备份） |
| `AIDASH_LLM_TIMEOUT_MS` | `60000` | 单次调用超时，5~300 秒 |
| `AIDASH_SECRET_DIR` | `~/.aidash` | 页面保存的密钥落盘目录；刻意与数据库/备份分开 |

### 2.4 任务与限流

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AIDASH_LEASE_SECONDS` | `900` | 任务认领租约；到期未续租，任务回到 `pending` |
| `AIDASH_MAX_WAIT_SECONDS` | `300` | REST 侧卡片等待上限 |
| `AIDASH_MCP_WAIT_CAP_SECONDS` | `25` | MCP `card.ask` / `card.wait` 的等待上限，必须在客户端超时前返回 |
| `AIDASH_MAX_WAITING_REQUESTS` | `100` | 同时等待的连接上限；满了返回 `BUSY` |
| `AIDASH_RATE_LIMIT_PER_MINUTE` | `600` | 每令牌每分钟请求数 |
| `AIDASH_PAGE_SIZE_MAX` | `200` | 列表分页上限 |
| `AIDASH_HEARTBEAT_INTERVAL_SECONDS` | `60` | harness 心跳期望间隔 |
| `AIDASH_OFFLINE_THRESHOLD_SECONDS` | `180` | 超过这么久没有 MCP 活动，通道显示“已停止” |
| `AIDASH_CARD_RETENTION_DAYS` | `365` | 卡片保留天数 |
| `AIDASH_LOG_RETENTION_DAYS` | `30` | 日志保留天数 |
| `AIDASH_AUDIT_MIN_RETENTION_DAYS` | `730` | 审计最短保留天数（只增不删） |
| `AIDASH_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## 3. 配置文件

默认读 `./aidash.config.json`（可用 `AIDASH_CONFIG` 改）。键名与环境变量一一对应，只是小写、下划线：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "token": "<令牌>",
  "db_path": "./10-aidash/data/aidash.db",
  "backup_dir": "./10-aidash/backups",
  "kb_root": "F:/docs/knowledge",
  "llm": {
    "endpoint": "https://api.deepseek.com/v1/chat/completions",
    "model": "deepseek-flash",
    "mode": "max"
  }
}
```

文件不存在时按“只有环境变量 + 默认值”运行；JSON 语法错误会在启动时明确报错，而不是静默忽略。

> 安全建议：令牌优先用环境变量；如果确实要写进配置文件，请确保该文件已被 `.gitignore` 覆盖（仓库默认忽略 `aidash-watch.json`、`.env`，但不会忽略你自建的 `aidash.config.json`）。

## 4. 数据、备份与空库防护

| 内容 | 位置 | 说明 |
|---|---|---|
| 主数据库 | `40-build/10-aidash/data/aidash.db` | WAL 模式，伴生 `-wal` / `-shm` |
| 迁移前备份 | `40-build/10-aidash/backups/pre-migrate-*.db` | 每次升级 schema 前自动生成 |
| 手动备份 | `40-build/10-aidash/backups/` | 建议停服后连同 `-wal` / `-shm` 一起拷走 |

**空库防护**：启动时如果配置的库文件不存在，但备份目录里已经有 `*.db`，十有八九是路径漂移，此时默认拒绝启动并写日志 `db_missing_with_backups`。确认要新建空库时显式设 `AIDASH_ALLOW_EMPTY_DB=true`。

**恢复**：停服 → 用备份覆盖 `aidash.db`（连同 `-wal` / `-shm`）→ 启动 → 看 `/healthz` 的 `db_path` 与 `schema_version` 是否符合预期。

## 5. 知识库（OKF，只读）

知识库是一个 Markdown 目录，根目录含 `index.md`（`okf_version: "0.1"`），文章为 Markdown + YAML frontmatter。配置 `AIDASH_KB_ROOT` 后：

- 服务只**读**该目录，不写、不改、不删；
- 索引落在 SQLite 里（`kb_doc` / `kb_fts`），换机器只要重新索引；
- 路径无效时启动不阻塞，只是知识库状态显示不可用；
- 检索用 SQLite FTS5 + 标签/类型过滤，不依赖向量库。

## 6. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 启动即退出，日志 `CONFIG_MISSING` | 没设 `AIDASH_TOKEN` |
| 浏览器能开页面但 API 全 401 | 页面里填的令牌与进程环境变量不一致 |
| 启动报 `DB_MISSING_WITH_BACKUPS` | 库路径漂移；确认路径或显式 `AIDASH_ALLOW_EMPTY_DB=true` |
| 通道一直显示“已停止” | 超过 `AIDASH_OFFLINE_THRESHOLD_SECONDS` 没有 MCP 调用；agent 只要发心跳或调工具就会恢复 |
| 建议区一直“未生成” | 没配 LLM key，或 `AIDASH_ENRICHMENT_ENABLED=false`，或端点不可达 |
