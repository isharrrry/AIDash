# AIDash — A Single-User Decision Panel for AI Harnesses

**English** | [中文](README.md)

> A decision panel for "one person + many AI harnesses": agents turn anything that needs your call into cards and push them up; you handle them in one web page. Tasks you plan are claimed and executed by machines on their own.

**Platform & dependencies**: Windows / Linux / macOS (cross-platform code; see the measured environment below); Node.js ≥ 24, pnpm 12.4.1; storage is embedded SQLite — no separate database to install.

---

## What problem it solves

When several AI coding tasks run at once, the real pain is not "it's slow":

- three terminals wait on the same question and you keep switching;
- an agent finishes a paragraph, and you copy it, adjust the tone, and forward it yourself;
- tasks are scattered across chat windows, so you cannot rank them;
- you want a harness on another machine to continue the work, but there is no shared "work order".

AIDash collapses all of this into three things: **cards**, a **task tree**, and **channels**. It does not schedule, dispatch, or manage other machines. It does one thing: **show you the right item at the right time**.

### Highlights

- **Six card types**: info, handoff, question, suggestion, status, artifact. Question cards support four body sections (background / goal / research / decision) plus primary and backup options.
- **Bounded waiting**: `card.ask` returns `pending` + `card_id` after at most 25 seconds, so a question is never lost to an MCP client timeout.
- **Task tree**: drag-and-drop moves, parent/child hierarchy, priority, category, lease-based claiming, evidence checks, deferral and risk flags.
- **External watch CLI**: a cross-platform CLI that polls for tasks, claims them, spawns a local harness, and writes back status and evidence. AIDash never pushes tasks.
- **Read-only knowledge base**: an OKF Markdown directory indexed with SQLite FTS5; the service never writes to it.
- **Optional LLM enrichment**: any OpenAI-compatible endpoint; without a key it is silently skipped and never blocks the main flow.
- **Append-only audit**: database triggers forbid UPDATE/DELETE; there is no delete API.
- **MCP is the only agent-facing surface**: REST and MCP share one service layer, and the watch CLI speaks MCP only.

---

## Quick start

```bash
# Requirements: Node >= 24, pnpm 12.4.1
pnpm install

# Build the server and the web app
pnpm build
pnpm web:build

# Set the token (read from the environment only; never commit it)
# Windows:
set AIDASH_TOKEN=replace-with-a-long-random-string
# macOS / Linux:
export AIDASH_TOKEN=replace-with-a-long-random-string

# Start
pnpm start
```

Open `http://127.0.0.1:8787/` and enter the same token on the settings page.

To connect Claude Code to AIDash:

```bash
claude --mcp-config 00-platform/config/mcp.json
```

---

## Core concepts

1. **Card** — the one-way carrier between an agent and a human. Each of the six types has its own purpose; only `question` cards enter the "awaiting decision" queue. See [AGENTS.md §3](10-aidash/AGENTS.md).
2. **Channel** — a namespace keyed by `host/project/topic`. Multiple harnesses on the same project share one "main conversation memory". See [Architecture §3.1](docs/architecture.md).
3. **Task tree** — the human-planned work order. State machine, claim lease, evidence card, deferral, and risk flags are first-class task attributes. See [MCP & watch CLI §4](docs/mcp-and-cli.md).
4. **Watch CLI (`aidash-watch`)** — an external execution agent. It polls, claims, and spawns the harness itself; the panel never pretends "someone is running". See [Architecture §1](docs/architecture.md).
5. **Contract package (AGENTS.md + SKILL.md)** — teaches agents when to post cards, how to claim tasks, and how to prove completion. It is part of the product, not just documentation. See [MCP & watch CLI §5](docs/mcp-and-cli.md).

---

## Safety boundaries

- Listens on `127.0.0.1` by default; cross-machine access requires explicit configuration plus your own TLS / reverse proxy.
- The token is read from the environment or local encrypted storage only; it is never written to the database, echoed back, logged, or exported.
- The audit log is append-only: triggers forbid UPDATE/DELETE, and no delete API exists.
- The knowledge base directory is **read-only**; the service never writes, modifies, or deletes anything there.
- AIDash holds no credentials for any third-party system; operations that need them use the harness's own environment variables.
- LLM keys saved from the settings page are stored under `~/.aidash` (encrypted files), deliberately separate from the database and backups.

---

## Documentation

| To learn about | Read |
|---|---|
| Architecture, layering, the two data flows, design trade-offs | [docs/architecture.md](docs/architecture.md) |
| Environment variables, config file, startup, backups | [docs/configuration.md](docs/configuration.md) |
| MCP access, the 23 tools, watch CLI usage | [docs/mcp-and-cli.md](docs/mcp-and-cli.md) |
| Development environment, tests, contribution flow | [docs/contributing.md](docs/contributing.md) |
| Agent behavior contract | [10-aidash/AGENTS.md](10-aidash/AGENTS.md) |
| Per-tool manual | [10-aidash/skills/aidash-mcp/SKILL.md](10-aidash/skills/aidash-mcp/SKILL.md) |
| Requirements and acceptance criteria (single source of truth) | [20-spec/需求与验收判据文档.md](20-spec/需求与验收判据文档.md) |
| High-level design and ADRs (single source of truth) | [30-design/概要设计.md](30-design/概要设计.md) |
| Design document package (01–07 + UI + security) | [30-design/设计文档包/README-核心包.md](30-design/设计文档包/README-核心包.md) |

The `20-spec/` and `30-design/` documents are written in Chinese. When documents conflict, the precedence order is: requirements → high-level design → interface design → database design → security → UI → other design documents.

---

## Development

```bash
pnpm typecheck      # type-check server + web
pnpm test           # 29 test files / 255 cases
pnpm coverage       # coverage report
pnpm build          # server  → 10-aidash/dist/server
pnpm web:build      # web     → 10-aidash/dist/web
pnpm cli:build      # watch CLI → 10-aidash/dist/cli/aidash-watch.mjs
```

**Measured environment**: Windows 11 (10.0.26100), Node 24, pnpm 12.4.1, Edge 155 (Chromium).

---

## Measured verification

Every number below was measured in this repository on 2026-10-25. **None of them is an estimate**; each command can be re-run.

| Verification | Command | Result |
|---|---|---|
| Type check | `pnpm typecheck` | exit code 0 |
| Unit / integration tests | `pnpm test` | **29 files / 255 cases, all passing** |
| Coverage | `pnpm coverage` | statements **84.22%** / branches 73.87% / functions 90.81% / lines 86.64% |
| Server build | `pnpm build` | succeeded; **17** migration SQL files copied to `dist` |
| Web build | `pnpm web:build` | succeeded; Vite build in 630 ms |
| Watch CLI build | `pnpm cli:build` | single file, **727.3 KiB** |
| Document self-checks | three check scripts | **24 / 15 / 6** checks passed, exit code 0 |
| Startup smoke (empty DB, temporary port 8795) | `node 10-aidash/dist/server/main.js` + HTTP probes | `/healthz` 200 (`version=2.0.0`), `/` 200, `/mcp` without token **401**, `initialize` 200, `tools/list` returns **23** tools, empty DB migrated to `schema_version=16` |

Browser end-to-end verification during development (decision inbox, task tree, decision modal, memory panel, Markdown/Mermaid rendering) was performed on Windows with a headless Edge browser over CDP. Per-round details are not published with the repository; the evidence policy is described in [07-质量记录包 §0](30-design/设计文档包/07-质量记录包.md).

---

## Known limitations

- **Linux / macOS are not tested**: the code is written to be cross-platform, but only Windows 11 was verified.
- **No large-scale load test**: the P95 targets at 10,000 cards / 1,000 tasks are unverified.
- **Cross-machine access is untested**: the service listens on loopback by default; TLS / reverse proxy setups must be validated by the deployer.
- **No timed restore drill**: backups and pre-migration backups exist, but no formal RTO drill has been recorded.
- **Only Chromium was verified**: Firefox / Safari styling and keyboard interaction are untested.
- **Only OpenAI-compatible LLM endpoints were verified**: field differences across vendors are uncovered.
- **No SBOM or dependency license scan**.

For the full list and risk notes, see [docs/contributing.md §7](docs/contributing.md).

---

## License

[MIT](LICENSE)
