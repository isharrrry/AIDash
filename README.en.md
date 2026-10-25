# AIDash — An Interaction and Decision Layer for Multi-Agent Collaboration

**English** | [中文](README.md)

> AIDash is not another agent framework, and it does not do the harness's job. It turns "how humans, agents, and agents exchange judgments and evidence" into a self-hosted interaction protocol: harnesses keep focusing on models, tools, and execution environments, while AIDash connects decisions, tasks, evidence, memory, and the watch runner.

**Platform & dependencies**: Windows / Linux / macOS (cross-platform code; see the measured environment below); Node.js ≥ 24, pnpm 12.4.1; storage is embedded SQLite — no separate database to install.

---

## What problem it solves

When several AI coding tasks run at once, the real pain is not "it's slow":

- three terminals wait on the same question and you keep switching;
- an agent finishes a paragraph, and you copy it, adjust the tone, and forward it yourself;
- tasks are scattered across chat windows, so you cannot rank them;
- you want a harness on another machine to continue the work, but there is no shared "work order".

AIDash collapses this into five shared objects: **cards**, a **task tree**, **channels**, **memory**, and the **watch runner**. It does not schedule, dispatch, or execute; it provides a collaboration surface that both humans and agents can read and write.

### A paradigm repository for AI software engineering in China

This repository aims to offer a **collaboration paradigm that can keep evolving through Agent Coding**, not just a finished tool:

- **Division of labor**: agents focus on harness-level capabilities (models, tools, execution environments, context); AIDash focuses on the interaction model that connects human judgment, agent execution, and agent-to-agent task flow.
- **Three links**: human-to-human (decision cards, handoff scripts, suggestion tasks), human-to-agent (task tree, four-part decisions, primary/backup options, long-term memory), and agent-to-agent (shared channels, task claims/leases, evidence cards, watch-runner write-back).
- **Practice in China**: runs on a single machine or LAN, SQLite with no external database, Chinese-first, append-only audit, MCP as the only agent surface; suitable for private and intranet deployments.
- **Evolvable**: agent software engineering is already capable enough; use it to iterate this repository directly and grow your own collaboration rules, card types, watch modes, and UI.
- **Multiple Release branches**: different organizations have different software-engineering requirements, languages, and features; open dedicated Release branches while the mainline keeps only the minimal shared contract.

### Product definition

**In one sentence**: AIDash is an **information-interconnection and decision layer for multi-agent scenarios** — agents turn what needs a human decision, forwarding, or awareness into cards; humans turn planned work into a task tree; harnesses or the watch runner claim it, execute it, and write evidence back.

**Who it is for**: individual developers running several AI coding sessions, small teams that want several machines to share one work order, and teams that want to turn "how human judgment enters the agent execution chain" into an organizational practice. The current version is **single-user deployment**; multi-user accounts and permissions are out of scope for V2 — multi-person collaboration is handled through handoff cards and separate Release branches for now.

**Core loop**:

```text
human plans a task → harness claims it → local execution → status / question card
      ↑                                                          ↓
      └──────────── human decides / forwards / adjusts ←──────────┘
```

All four steps must land: **plan** (task tree), **claim** (lease-based), **do** (local to the harness), **prove** (an evidence card before completion).

**What it does not do**: it does not schedule, dispatch, or decide when an executor should run. Task state and evidence are shared; executors poll/claim and make progress at their own configured pace (the current implementation polls, and the scheduling method can later be replaced by push or other mechanisms). When you add a task manually in the Web UI or REST API, an executor claims and runs it at the configured cadence. AIDash stores no code, workspaces, or artifacts; it holds no third-party credentials; it does not do multi-user or permissions. Full definition: [requirements §1.4](20-spec/需求与验收判据文档.md#14-产品定义).

### Highlights

- **Six card types**: info, handoff, question, suggestion, status, artifact. Question cards support four body sections (background / goal / research / decision) plus primary and backup options.
- **Bounded waiting**: `card.ask` returns `pending` + `card_id` after at most 25 seconds, so a question is never lost to an MCP client timeout.
- **Task tree**: drag-and-drop moves, parent/child hierarchy, priority, category, lease-based claiming, evidence checks, deferral and risk flags.
- **External watch CLI**: a cross-platform CLI that polls for tasks, claims them, spawns a local harness, and writes back status and evidence. AIDash never pushes tasks.
- **Read-only knowledge base**: an OKF Markdown directory indexed with SQLite FTS5; the service never writes to it.
- **Optional LLM enrichment**: any OpenAI-compatible endpoint; without a key it is silently skipped and never blocks the main flow.
- **Append-only audit**: database triggers forbid UPDATE/DELETE; there is no delete API.
- **MCP is the only agent-facing surface**: REST and MCP share one service layer, and the watch CLI speaks MCP only.

### Screenshots

![Decision board](30-design/assets/readme/01-decision-board.png)

*Decision board: all questions awaiting your call in one place.*

![Task tree](30-design/assets/readme/02-task-tree.png)

*Task tree: parent/child structure, status, claims, and evidence.*

![Settings](30-design/assets/readme/03-settings.png)

*Settings and operations: health, access credentials, rate limits, and retention.*

![Question card details](30-design/assets/readme/04-card-drawer.png)

*Question card: four background sections, primary/backup options, and decisions.*

> Screenshots use synthetic demo data; no real tasks, paths, or credentials.

---

## Quick start

```bash
# Requirements: Node >= 24, pnpm 12.4.1
pnpm -C 40-build install

# Build the server and the web app
pnpm -C 40-build build
pnpm -C 40-build web:build

# Set the access credential (single variable: AIDASH_TOKEN; a short passphrase is fine)
# Windows:
set AIDASH_TOKEN=replace-with-a-passphrase-or-long-random-string
# macOS / Linux:
export AIDASH_TOKEN=replace-with-a-passphrase-or-long-random-string
# LAN access: start the script with -BindHost 0.0.0.0 (always pair with TLS / a reverse proxy)

# Start (either one)
pnpm -C 40-build start        # generic: the script returns to the repo root first, so default paths do not drift with cwd
pnpm -C 40-build start:win    # recommended on Windows: pins DB / backups / static dir to absolute paths and prints them
```

Open `http://127.0.0.1:8787/` and enter the `AIDASH_TOKEN` value on the login page.

To connect Claude Code to AIDash:

```bash
claude --mcp-config 40-build/00-platform/config/mcp.json
```

---

## Repository layout

```text
AIDash/
├─ README.md / README.en.md / CONTRIBUTING.md / LICENSE / .gitignore / .gitattributes
├─ 00-admin/          Management records: contracts, licenses, meeting notes (.gitkeep when empty)
├─ 10-input/          Read-only input: references and samples
├─ 20-spec/           What to build: requirements and acceptance criteria (single source of truth)
├─ 30-design/         How to build it: overview design, ADRs, design package 01-07, three self-check scripts
├─ 40-build/          The only place for code + the pnpm workspace root
│  ├─ package.json / pnpm-lock.yaml / pnpm-workspace.yaml
│  ├─ 00-platform/    Build config and tools: tsconfig / vitest / mcp.json / packaging scripts
│  └─ 10-aidash/      Server + web + watch CLI sources; AGENTS.md and SKILL.md; tests
├─ 50-verify/         Verification records
├─ 60-deliver/        Deliverables
├─ 70-operate/        Operations records
├─ 80-derived/        Derived data and statistics
└─ 90-archive/        Archive (read-only, excluded from checks)
```

**Run every command from the repository root with `pnpm -C 40-build ...`**. Runtime data (SQLite, backups, build output) lives under `40-build/10-aidash/` and is git-ignored.

---

## Core concepts

1. **Card** — the one-way carrier between an agent and a human. Each of the six types has its own purpose; only `question` cards enter the "awaiting decision" queue. See [AGENTS.md §3](40-build/10-aidash/AGENTS.md).
2. **Channel** — a namespace keyed by `host/project/topic`. Multiple harnesses on the same project share one "main conversation memory". See [02 §8.3.1](30-design/设计文档包/02-系统-子系统设计说明.md#831-卡片agent-问人答).
3. **Task tree** — the human-planned work order. State machine, claim lease, evidence card, deferral, and risk flags are first-class task attributes. See [04 §4.8](30-design/设计文档包/04-接口设计说明.md).
4. **Runner CLI (`aidash-runner`, alias `aidash-watch`)** — an external execution agent. It polls, claims, and spawns the harness itself; the panel never pretends "someone is running". See [02 §8.1](30-design/设计文档包/02-系统-子系统设计说明.md#81-三个交付物如何分工).
5. **Contract package (AGENTS.md + SKILL.md)** — teaches agents when to post cards, how to claim tasks, and how to prove completion. It is part of the product, not just documentation. See [04 §6.3](30-design/设计文档包/04-接口设计说明.md).

---

## Safety boundaries

- Listens on `127.0.0.1` by default; cross-machine access requires explicit configuration (`AIDASH_HOST` or the start script's `-BindHost`) plus your own TLS / reverse proxy. `AIDASH_TOKEN` can be a short passphrase or a long random string; it is read from the environment only. `AIDASH_PASSPHRASE` is a deprecated alias.
- The token is read from the environment or local encrypted storage only; it is never written to the database, echoed back, logged, or exported.
- The audit log is append-only: triggers forbid UPDATE/DELETE, and no delete API exists.
- The knowledge base directory is **read-only**; the service never writes, modifies, or deletes anything there.
- AIDash holds no credentials for any third-party system; operations that need them use the harness's own environment variables.
- LLM keys saved from the settings page are stored under `~/.aidash` (encrypted files), deliberately separate from the database and backups.

---

## Documentation

| To learn about | Read |
|---|---|
| Architecture, layering, the two data flows, design trade-offs | [02 §8](30-design/设计文档包/02-系统-子系统设计说明.md#8-架构总览面向使用者的补充) |
| Environment variables, config file, startup, backups | [60-deliver/配置模板.md](60-deliver/配置模板.md) |
| MCP access, the 23 tools, runner interface | [04 §4, §7](30-design/设计文档包/04-接口设计说明.md) |
| Runner install, config fields, subcommands | [40-build/20-aidash-runner/README.md](40-build/20-aidash-runner/README.md) |
| Development environment, tests, contribution flow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Agent behavior contract | [40-build/10-aidash/AGENTS.md](40-build/10-aidash/AGENTS.md) |
| Per-tool manual | [40-build/10-aidash/skills/aidash-mcp/SKILL.md](40-build/10-aidash/skills/aidash-mcp/SKILL.md) |
| Requirements and acceptance criteria (single source of truth) | [20-spec/需求与验收判据文档.md](20-spec/需求与验收判据文档.md) |
| High-level design and ADRs (single source of truth) | [30-design/概要设计.md](30-design/概要设计.md) |
| Design document package (01–07 + UI + security) | [30-design/设计文档包/README-核心包.md](30-design/设计文档包/README-核心包.md) |

The `20-spec/` and `30-design/` documents are written in Chinese. When documents conflict, the precedence order is: requirements → high-level design → interface design → database design → security → UI → other design documents.

---

## Development

```bash
pnpm -C 40-build typecheck      # type-check server + web
pnpm -C 40-build test           # 38 test files / 471 passed + 1 skipped
pnpm -C 40-build coverage       # coverage report
pnpm -C 40-build build          # server  → 40-build/10-aidash/dist/server
pnpm -C 40-build web:build      # web     → 40-build/10-aidash/dist/web
pnpm -C 40-build cli:build      # legacy watch CLI (deprecated) → dist/cli/aidash-watch.mjs
pnpm -C 40-build test:runner    # runner CLI self-test (node --test, 97 tests)
```

**Measured environment**: Windows 11 (10.0.26100), Node 24, pnpm 12.4.1, Edge 155 (Chromium).

---

## Measured verification

Every number below was measured in this repository on 2026-10-25. **None of them is an estimate**; each command can be re-run.

| Verification | Command | Result |
|---|---|---|
| Type check | `pnpm -C 40-build typecheck` | exit code 0 |
| Unit / integration tests | `pnpm -C 40-build test` | **38 files / 471 passed + 1 skipped** |
| Coverage | `pnpm -C 40-build coverage` | statements **83.94%** / branches 73.51% / functions 90.57% / lines 86.39% |
| Server build | `pnpm -C 40-build build` | succeeded; **18** migration SQL files copied to `dist` |
| Web build | `pnpm -C 40-build web:build` | succeeded; Vite build in 5.5 s (cold cache) |
| Watch CLI build | `pnpm -C 40-build cli:build` | single file, **729.0 KiB** |
| Document self-checks | three check scripts | **24 / 15 / 6** checks passed, exit code 0 |
| Startup smoke (empty DB, temporary port 8795) | `node 40-build/10-aidash/dist/server/main.js` + HTTP probes | `/healthz` 200 (`version=2.0.0`), `/` 200, `/mcp` without token **401**, `initialize` 200, `tools/list` returns **23** tools, empty DB migrated to `schema_version=17` |

Browser end-to-end verification during development (decision inbox, task tree, decision modal, memory panel, Markdown/Mermaid rendering) was performed on Windows with a headless Edge browser over CDP. Per-round details are not published with the repository; the evidence policy is described in [07-质量记录包 §0](30-design/设计文档包/07-质量记录包.md).

---

## Known limitations

- **Linux / macOS are not tested**: the code is written to be cross-platform, but only Windows 11 was verified.
- **No large-scale load test**: the P95 targets at 10,000 cards / 1,000 tasks are unverified.
- **Cross-machine access is untested**: the service listens on loopback by default; TLS / reverse proxy setups must be validated by the deployer.
- **No timed restore drill**: backups and pre-migration backups exist, but no formal RTO drill has been recorded.
- **Only Chromium was verified**: Firefox / Safari styling and keyboard interaction are untested.
- **Only OpenAI-compatible LLM endpoints were verified**: field differences across vendors are uncovered.
- **An SBOM exists (`80-derived/sbom.cyclonedx.json`), but dependency vulnerability and license scans have not been run**.

For the full list and risk notes, see [CONTRIBUTING.md §8](CONTRIBUTING.md).

---

## License

[MIT](LICENSE)
