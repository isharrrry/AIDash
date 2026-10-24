# 开发与贡献

## 1. 环境

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 24 | `package.json` 的 `engines` 会检查 |
| pnpm | 12.4.1 | `packageManager` 字段固定版本 |
| SQLite | 内置 | 由 `better-sqlite3` 提供，无需单独安装 |

Windows 注意：`10-aidash/scripts/start-aidash.ps1` 必须保持 **UTF-8 with BOM**。无 BOM 时 PowerShell 会按本地代码页解析，中文直接乱码甚至语法错误。

## 2. 常用命令

```bash
pnpm install        # 安装依赖
pnpm dev            # 开发模式（tsx watch，改服务端代码自动重启）
pnpm typecheck      # 服务端 + Web 类型检查
pnpm test           # 单元/集成测试（vitest）
pnpm coverage       # 测试 + 覆盖率
pnpm build          # 服务端 → 10-aidash/dist/server（含迁移 SQL 复制）
pnpm web:build      # 前端   → 10-aidash/dist/web
pnpm cli:build      # 值守壳 → 10-aidash/dist/cli/aidash-watch.mjs
pnpm check          # typecheck + test（提交前最小检查）
```

## 3. 测试与覆盖率

```bash
pnpm test
# 29 个测试文件 / 255 个用例，全部通过

pnpm coverage
# Statements 84.22% | Branches 73.87% | Functions 90.81% | Lines 86.64%
```

测试分三类：

| 类型 | 位置 | 例子 |
|---|---|---|
| 单元 | `10-aidash/tests/*.test.ts` | 状态机、纯函数、schema 校验、脱敏 |
| 集成 | 同上，走真实 HTTP / MCP | REST 路由、MCP 工具全链路、迁移升级 |
| 手动/浏览器 | `10-aidash/tests/manual/*.mjs` | 无头浏览器 + CDP 断言（不随 CI 跑） |

测试用临时 SQLite 文件，不碰 `10-aidash/data/` 下的真实库。

## 4. 目录与命名约定

| 约定 | 规则 |
|---|---|
| 代码位置 | 只在 `10-aidash/src/`；`00-platform/` 只放构建配置 |
| 分层 | `http/`、`mcp/` 只做校验与映射；业务在 `services/`；SQL 只在 `repos/` |
| 迁移 | `10-aidash/src/server/db/migrations/NNN_name.sql`，只增不改；新迁移必须同时补测试 |
| 命名 | 变量/函数 `camelCase`；类型/组件 `PascalCase`；常量 `UPPER_SNAKE_CASE` |
| 类型 | 共享类型与 zod schema 放 `src/shared/`，前后端都从这里取 |
| 错误 | 统一 `AppError(code, message, details)`；HTTP 与 MCP 各自映射，不抛裸字符串 |

## 5. 改动流程

1. **先确认事实源**：需求看 `20-spec/`，设计看 `30-design/`。文档与代码冲突时，先判断哪边错了，不要默默改代码。
2. **改代码**：小步提交；行为变更必须带测试。
3. **跑检查**：

   ```bash
   pnpm typecheck && pnpm test
   pnpm build && pnpm web:build
   ```

4. **改设计文档**（如果行为或接口变了）：按 `30-design/设计文档包/README-核心包.md` 的权威顺序更新，并跑三个自检：

   ```bash
   node 30-design/设计文档包/checks/文档包自检.mjs
   node 30-design/设计文档包/checks/结构计数交叉核对.mjs
   node 30-design/checks/三边一致.mjs
   ```

   三个都退出码 0 才算文档自洽。如果改了数量（需求、表、风险等），同步改 `30-design/model/model.json`。

5. **提交**：遵循 Conventional Commits（`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:`），一次提交只做一件事。

## 6. 面向 agent 的契约

如果改动涉及 MCP 工具、发卡规则或任务状态机，除了代码与设计文档，还要同步：

- `10-aidash/AGENTS.md`（harness 行为契约）
- `10-aidash/skills/aidash-mcp/SKILL.md`（逐工具示例）

这两份是产品的一部分，不是说明文档。

## 7. 已知未验证项

以下项目**没有在本仓实测**，不要在 README 或发布说明里写成“已支持”：

| 项目 | 现状 | 风险 |
|---|---|---|
| Linux / macOS 运行 | 代码按跨平台写，但只在 Windows 11 上实测过 | 路径分隔符、进程树终止、PowerShell 脚本之外的差异 |
| 10,000 卡 / 1,000 任务性能（NF-002、NF-007） | 未压测 | P95 目标未验证 |
| 跨机访问 + TLS / 反向代理（NF-001） | 未实测 | 默认只监听回环，跨机配置需自行验证 |
| 值守壳跨网络与三平台进程树（NF-009） | 只在单机 Windows 实测 | 租约续期、孤儿进程 |
| 备份恢复演练（NF-011，RPO/RTO） | 有备份机制，未按 RTO 计时演练 | 恢复耗时未知 |
| 真实 LLM 端点多样性 | 只验证过 OpenAI 兼容端点 | 其他厂商的字段差异 |
| 依赖漏洞与许可证扫描（SBOM） | 未做 | 供应链合规 |
| Firefox / Safari | 只在 Chromium 内核（Edge）验证 | 样式与键盘交互差异 |

## 8. 安全约定

- 令牌只从环境变量读，**不要**写进代码、测试夹具、提交信息或日志。
- 新增日志字段前先想一遍：这个字段会不会把令牌、知识库正文或用户隐私带出去。
- 审计表只追加；不要加 UPDATE/DELETE 接口，也不要绕过触发器。
- 知识库目录只读；任何“顺手写回知识库”的功能都不要加。
