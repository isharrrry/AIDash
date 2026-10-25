# 贡献指南

感谢你愿意花时间改进 AIDash。这个项目优先保证“事实可核对、边界清晰”，所以对贡献的要求也围绕这两点。

## 开始之前

1. 读 [README](README.md) 了解它解决什么问题；
2. 读 [docs/contributing.md](docs/contributing.md) 了解环境、命令、目录约定与已知未验证项；
3. 如果改动涉及 MCP 工具、发卡规则或任务状态机，先读 [40-build/10-aidash/AGENTS.md](40-build/10-aidash/AGENTS.md)——它是产品契约，不是普通文档。

## 提交前检查

```bash
pnpm -C 40-build typecheck
pnpm -C 40-build test
pnpm -C 40-build build && pnpm -C 40-build web:build
```

如果改了设计文档，再跑三个自检：

```bash
node 30-design/设计文档包/checks/文档包自检.mjs
node 30-design/设计文档包/checks/结构计数交叉核对.mjs
node 30-design/checks/三边一致.mjs
```

## Pull Request

- 一次 PR 只做一件事；行为变更必须带测试。
- 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `docs:` / `test:` / `chore:`）。
- 描述里写清楚：**为什么改**、**怎么验证**、**有没有未覆盖的风险**。
- 不要提交令牌、真实数据库、日志、备份或任何个人/组织内部信息。

## 不接受的改动

- 把令牌、密钥或凭据写进代码、配置模板、测试夹具或提交信息；
- 给审计表加修改/删除能力；
- 让知识库目录变成可写；
- 在没有实测的情况下把“未验证项”写成“已支持”。
