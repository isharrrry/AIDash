# 参与 AIDash

AIDash 是一个**面向多 Agent 协作的交互与决策层**，也是一个可以继续生长的**中国地区 AI 软件工程范式仓库**。主干只保留最小共识；不同组织、语言和功能特性可以通过 Release 分支各自演进。

你可以用三种方式参与：

1. **直接使用**：部署、接自己的 harness、提问题和场景需求；
2. **用 Agent 软件工程迭代**：让 agent 读契约、改代码、跑验证，探索你自己的交联协作场景；
3. **开 Release 分支**：按组织规范、语言或功能特性分叉，主干保持参考实现。

---

## 1. 先读这几份

| 文件 | 作用 |
|---|---|
| [README](README.md) | 它解决什么问题、怎么启动、怎么接 agent / 值守壳 |
| [40-build/10-aidash/AGENTS.md](40-build/10-aidash/AGENTS.md) | harness 行为契约；改 MCP 工具、发卡或任务状态机前必读 |
| [40-build/10-aidash/skills/aidash-mcp/SKILL.md](40-build/10-aidash/skills/aidash-mcp/SKILL.md) | 23 个 MCP 工具的调用示例 |
| [30-design/设计文档包/README-核心包.md](30-design/设计文档包/README-核心包.md) | 设计文档的权威顺序 |

需求看 `20-spec/`，设计看 `30-design/`；文档与代码冲突时先判断哪边错了，不要默默改代码。

## 2. 环境与命令

```bash
pnpm -C 40-build install
pnpm -C 40-build dev            # 服务端热重载
pnpm -C 40-build typecheck
pnpm -C 40-build test
pnpm -C 40-build test:runner
pnpm -C 40-build test:deploy
pnpm -C 40-build build
pnpm -C 40-build web:build
pnpm -C 40-build check          # 以上最小检查的组合
```

Windows 上 `40-build/10-aidash/scripts/start-aidash.ps1` 必须保持 **UTF-8 with BOM**。

## 3. 主干的最小约定

主干不规定一套沉重的研发流程，只守住“别人能装上、能验证、不会被误导”：

- **契约要真**：改 MCP 工具、发卡规则、任务状态机时，同步 `AGENTS.md` 与 `SKILL.md`；破坏性变更升主版本并写变更记录。
- **行为要有验证**：新增或改变行为时补测试；至少跑过 `typecheck`、相关测试和 `check`。
- **文档要能复算**：README/设计文档里的命令、数字和路径要能对应到代码或实测结果；未验证的不要写成“已支持”。
- **安全边界不放松**：令牌、密钥、真实数据库、日志、备份、个人/组织内部信息不进代码、测试夹具、提交或截图。

除此之外，目录、命名、提交粒度和覆盖率阈值都可以按你的场景调整；这些不是主干要强加的约束。

## 4. 用 Agent 软件工程迭代

Agent 软件工程已经足够智能，可以直接参与这个仓的改造。建议把它当成一个可验证的协作者：

1. 让 agent 先读 `AGENTS.md`、`SKILL.md` 与相关设计文档；
2. 明确这次要改的“共享对象/契约/场景”，不要只给一句“优化一下”；
3. 小步改，边改边跑测试；测试失败先修实现或修测试前提，不要用放宽断言换绿；
4. 让 agent 记录“改了什么、为什么、怎么验证、有什么没覆盖”；
5. 凭据只从环境变量读，不交给 agent，也不写进提示词、卡片或日志。

## 5. Release 分支

`main` 是参考实现，不是唯一答案。不同组织可以按自己的软件工程要求开分支：

- 命名建议：`release/<org>-<purpose>`，例如 `release/acme-java`、`release/acme-offline`；
- 分支可以改语言、部署方式、卡片类型、值守策略和界面；
- 建议保留 `AGENTS.md` + `SKILL.md` 的契约边界，或在分支里明确版本化；
- 修复主干也存在的缺陷时，优先把最小修复回流 `main`，避免分叉越走越远；
- 发布分支的版本号、构建产物和依赖策略由分支维护者负责。

## 6. 提交与 Pull Request

- 提交信息建议用 Conventional Commits（`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:`），不是硬性要求；
- PR 描述写清 **为什么改、怎么验证、有没有未覆盖的风险**；
- 一次 PR 尽量聚焦一件事，方便 review；
- 不要提交令牌、真实数据库、日志、备份或任何个人/组织内部信息；
- 提交前至少跑 `pnpm -C 40-build check`；改了设计文档再跑 `30-design` 下的三个自检脚本。

## 7. 已知未验证项

以下项目没有在本仓完整实测，不要在 README 或发布说明里写成“已支持”：

| 项目 | 现状 |
|---|---|
| Linux / macOS 运行 | 代码按跨平台写，但只在 Windows 11 上实测过 |
| 10,000 卡 / 1,000 任务性能 | 未压测，P95 目标未验证 |
| 跨机访问 + TLS / 反向代理 | 未实测；默认只监听回环 |
| 值守壳跨网络与三平台进程树 | 只在 Windows 单机跑过自测与 fake MCP |
| 备份恢复 RPO/RTO | 有脚本级演练，未在真实库上做真恢复 |
| 真实 LLM 端点多样性 | 只验证过 OpenAI 兼容端点 |
| 依赖漏洞与许可证扫描 | 有 SBOM，未做漏洞扫描与许可证原文核对 |
| Firefox / Safari | 只在 Chromium 内核（Edge）验证 |

## 8. 安全底线

- 令牌只从环境变量读，不写进代码、测试夹具、提交信息、卡片或日志；
- 审计表只追加，不加修改/删除接口，不绕过触发器；
- 知识库目录只读，不加“顺手写回”的功能；
- 不代持第三方系统凭据；需要外部凭据的操作留在 harness 自己的环境里。
