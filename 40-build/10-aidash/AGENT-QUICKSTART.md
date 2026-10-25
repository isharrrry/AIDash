# AIDash Agent 快速接入

> 行为规则的真源是 `AGENTS.md`，工具示例是 `skills/aidash-mcp/SKILL.md`；本文只负责“怎么把 agent 接上并跑起第一条任务”。
>
> 凭据只从环境变量 `AIDASH_TOKEN` 读（可以是一句短口令）；不要写进提示词、卡片、日志或仓库。

## 1. 已配 MCP（Claude Code）

启动：

```bash
claude --mcp-config <AIDASH_ROOT>/40-build/00-platform/config/mcp.json
```

把下面这段发给 agent：

```text
读 <AIDASH_ROOT>/40-build/10-aidash/AGENTS.md 与
<AIDASH_ROOT>/40-build/10-aidash/skills/aidash-mcp/SKILL.md。

用 AIDash MCP 在通道 devhost/myproj/topic 建/复用通道（workdir 用当前目录），
创建并提交“首条任务”，然后 claim → start 执行；完成前发 status/artifact 证据卡，
再 complete。凭据只从 AIDASH_TOKEN 环境变量读，不要写进卡片或日志。
```

## 2. 不配 MCP（任意 agent，走 REST）

启动 `claude`（或其他 agent），把下面这段发给它：

```text
读 <AIDASH_ROOT>/40-build/10-aidash/AGENTS.md 与
<AIDASH_ROOT>/40-build/10-aidash/AGENT-QUICKSTART.md 的“无 MCP”段。

用 REST 接入 AIDash，所有请求带 Authorization: Bearer $AIDASH_TOKEN：
1. GET /api/digest 了解当前关注
2. POST /api/channels {"channel_key":"devhost/myproj/topic","title":"我的话题","workdir":"<当前目录>"}
3. POST /api/tasks {"channel_key":"devhost/myproj/topic","title":"首条任务","submit":true}
4. POST /api/tasks/{id}/claim {"harness_id":"claude-demo"}
5. PATCH /api/tasks/{id} {"event":"start","claim_token":"<上一步返回>"}
6. 完成后先发证据：POST /api/cards
   {"channel_key":"...","type":"status","task_id":"...","summary":"...","result":"success","detail_md":"..."}
7. 再结束任务：PATCH /api/tasks/{id}
   {"event":"complete","claim_token":"...","evidence_card_ids":["..."]}

凭据只从环境变量读，不要写进提示词、卡片或日志。
```

## 3. 连通性自检

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $AIDASH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

返回 23 个工具即表示凭据与 MCP 都通。Windows PowerShell 用 `$env:AIDASH_TOKEN`。

## 4. 初始任务的最小闭环

```text
channel.upsert（或 REST POST /api/channels）
  → task.create（submit=true）
  → task.claim
  → task.update(event=start)
  → 干活
  → card.post(type=status|artifact, task_id=...)
  → task.update(event=complete, claim_token=..., evidence_card_ids=[...])
```

没有证据卡的 `complete` 会被拒绝；这是刻意的，不是配置问题。
