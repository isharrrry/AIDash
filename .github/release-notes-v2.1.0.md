# AIDash v2.1.0

本版加入独立的 **管理台**，把「多个 AIDash 实例 + 多个 runner」的创建、配参、启停、看日志收进一个入口；同时新增讨论任务与事项矩阵两处协作能力。运行时要求从 Node 24 放宽到 **Node 20.19**。

## 新增：aidash-manager 管理台

- 独立 CLI + React Web（默认 `http://127.0.0.1:4280`），**不与 AIDash Web 合并**
- 多实例登记：创建、起名、配参、切换配置文件模式、启动/停止、日志与异常摘要
- 内置 runner 模板：Claude Code / OpenAI Codex / DeepSeek `dsh` / Narnat / 自定义 argv
- 会生成 `aidash-runner.json` 并调用 runner 自己的 daemon 控制面完成启停
- 访问令牌走 URL 一次性交换为 HttpOnly Cookie，避免令牌留在浏览器历史与 Referer

## 新增：讨论任务与事项矩阵

- 任务新增 `kind=discussion`：`complete` 可带 `answer_md`（迁移 018 保存 `discussion_answer_md` / `answered_at`）
- 认领与详情返回父链上下文 `ancestors`；新增 MCP `task.get`
- Web 详情支持批量拆分子讨论（默认讨论类型、待认领）
- 事项矩阵页：子通道按周/月聚合任务与汇报，支持阶段、负责人、优先级、标签、分组与 AI 下一步建议（迁移 020）
- 任务树「全部通道」列表空白修复；卡片信息流支持内联展开

## harness 与 runner

- harness 心跳新增 `busy` 状态（迁移 019），注册表区分「运行中」与「空闲在线」
- runner 新增前台终端 Markdown 渲染，`--no-md` 可关
- 结果文件路径支持 `{task_file_dir}` / `{task_id}` 占位并按执行隔离，增加 mtime / task_id 归属校验
- 讨论任务缺少有效结果时按 `blocked` 回报，不再假装成功

## 运行环境与构建

- 运行时与构建目标由 Node 24 降到 **Node 20.19**：`engines`、CI、esbuild target、部署脚本版本校验同步调整
- 依赖降级：vitest 4.1.12、better-sqlite3 12.6.0、jsdom 29.1.1、`@types/node` 20
- 迁移 checksum 按 LF 归一，修复 Windows CRLF 检出导致的启动失败

## 质量

- 新增 `listenOnFetchSafePort`：避开 Fetch 规范禁止端口引起的偶发 `bad port`
- 新增 `50-verify/测试与质量约束.md`
- 修复管理台测试依赖被 gitignore 的 `web-dist` 产物（CI 干净检出必然失败），静态目录改为可注入
- 测试规模：67 文件 / 596 用例

## 升级提示

- **迁移** 018 / 019 / 020 会在启动时自动执行；从 v2.0.0 升级前请照常备份数据库
- 管理台是新增组件，需要单独安装（`npm i -g @isharrrry/aidash-manager`），不随服务端一起部署
- 本版放宽 Node 下限，**不强制**升级 Node；仍在 Node 24 上运行无需改动
- Web 轮询统一到 10 秒（`DEFAULT_POLL_MS`），管理台保持总览 4 秒 / 日志 2 秒 / 异常 5 秒

## 已知未验证

- Linux/macOS 完整运行（当前 Windows 实测）
- 10,000 卡 / 1,000 任务性能压测
- 跨机 TLS/反代、真实库恢复 RTO、Firefox/Safari
