# ai_dump_2 — MCP Controller Development Scaffold

This repo is the **development environment** for building and testing the `.ai/` MCP controller. The `.ai/` folder is the deliverable — it gets dropped into a target Angular 14 repo. Everything outside `.ai/` is scaffolding, tests, and design specs.

```
ai_dump_2/
├── .ai/                        ← THE DELIVERABLE (drop into target repo)
│   ├── config/                 #   Layered config + schema
│   ├── graph/                  #   Neo4j seed data, constraints, exports
│   ├── how-to/                 #   User-facing guides
│   ├── memory/                 #   Runtime memory records + overrides
│   ├── mcp-controller/         #   MCP controller source (TypeScript)
│   └── README.md               #   User-facing setup & usage guide
│
├── specs/                      ← DESIGN DOCS (not shipped)
│   ├── graph_gateway_reference_points.md      # Architectural reference (228 REF IDs)
│   └── graph_gateway_reference_points.index.json  # REF ID line index
│
├── test-mcp-harness.mjs        ← PRIMARY TEST SUITE (62 tests)
├── e2e/                        ← E2E validation (clones ng-conduit as test-app)
├── test-app/                   ← Cloned Angular app target (gitignored)
│
├── .github/copilot-instructions.md  # Agent behavior instructions
├── .vscode/mcp.json            # Dev workspace MCP config
└── README.md                   ← you are here (dev scaffold docs)
```

> **If you're a user dropping `.ai/` into your repo**, read [.ai/README.md](.ai/README.md) instead.

---

## Dev Setup

### Prerequisites

| Dependency | Version | Notes |
|------------|---------|-------|
| Node.js | ≥ 25 | Via nvm. WSL: `source ~/.nvm/nvm.sh && nvm use 25` |
| Neo4j | 5.x | Database `piopex` must exist |
| WSL 2 | — | Required on Windows |

### Clone & install

```bash
git clone https://github.com/alujs/ai_dump_2.git
cd ai_dump_2
npm install
npm --prefix .ai/mcp-controller install
```

### Neo4j

Default: `bolt://127.0.0.1:7687`, user `neo4j`, password `123456789`, database `piopex`.

Override via env vars or `.ai/config/env.local.json`. See [.ai/README.md](.ai/README.md#2-configure-neo4j).

```bash
npm --prefix .ai/mcp-controller run graphops:check   # verify connectivity
npm --prefix .ai/mcp-controller run graphops:sync     # seed database
```

---

## Testing

### Test harness (primary — 62 tests)

```bash
node test-mcp-harness.mjs
```

Spawns the MCP server as a child process, communicates via JSON-RPC over NDJSON stdio, covers 8 sections:

1. Transport Layer — protocol compliance
2. Pre-Plan Verbs — all 14 verbs
3. Plan Lifecycle — submit/validate/accept
4. Post-Plan Mutations — patch/code_run/side_effect/recipe
5. Session & Response — envelope, budget, strategy
6. Mutation Deny Paths — actionable error messages
7. Verb Descriptions — self-describing API
8. Memory System — signal_task_complete, retrospective, friction

Current: 58 PASS, 0 FAIL, 4 SKIP.

### Unit tests

```bash
npm --prefix .ai/mcp-controller test
```

### E2E validation (with test-app)

```bash
node e2e/run-validation.mjs
```

This:
1. Shallow-clones [nartc/ng-conduit](https://github.com/nartc/ng-conduit) into `test-app/` (override: `E2E_TEST_APP_REPO`)
2. SHA-256 digests all seed files before and after — fails if any byte changes
3. Runs all e2e smoke suites with `MCP_TARGET_REPO_ROOT=test-app/`
4. Verifies `test-app/` has no unexpected git changes
5. Cleans up `test-app/.ai/` artifacts

### Seed integrity

The test infrastructure guarantees seed files are never mutated:
- **Digest guard** — `e2e/run-validation.mjs` computes SHA-256 of `.ai/graph/seed/` before/after
- **Path isolation** — `GraphOpsService` constructor asserts `seedRoot ≠ outRoot ≠ cypherRoot`
- **In-memory indexing** — `IndexingService` never writes to the target repo
- **Git porcelain check** — test-app must have clean working tree after e2e

---

## Specs & Design Docs

These are the architectural design documents that drive the `.ai/` implementation. They are **not shipped** with the drop-in folder.

| Document | Path | Purpose |
|----------|------|---------|
| Controller spec (v2.0) | `.ai/mcp-controller/specs/mcp_controller_full_spec.md` | Full implementation spec |
| Reference manual | `specs/graph_gateway_reference_points.md` | Architectural reference with 228 `[REF:...]` citation IDs |
| REF index | `specs/graph_gateway_reference_points.index.json` | Line-number index for REF IDs |

PlanGraph evidence should cite REF IDs from the reference manual (e.g. `[REF:PROOF-CHAINS]`, `[REF:MEMORY-SYSTEM]`).

---

## Architecture Summary

- **18 verbs** (14 pre-plan, 4 post-plan) via single `controller_turn` tool
- **NDJSON over stdio** transport, JSON-RPC 2.0, protocol `2025-11-25`
- **6 run states**: PLAN_REQUIRED → PLAN_ACCEPTED → EXECUTION_ENABLED → COMPLETED (+ BLOCKED_BUDGET, FAILED)
- **Dimensional memory**: friction-driven learning, domain anchors, 3 enforcement mechanisms
- **Plan validation**: evidence-linked PlanGraph, 17 rejection codes, memory rule enforcement
- **AST tooling**: 4 built-in codemods + extensible custom registry
- **Neo4j graph**: bolt, lazy dynamic import (Node ≥25)
- **No build step**: runs from TypeScript source via `tsx`

---

## Graph Operations

| Command | What it does |
|---------|-------------|
| `graphops:check` | Verify Neo4j connectivity |
| `graphops:sync` | Drop all → rebuild indexes → upsert seed data |
| `graphops:export` | Export current graph to `.ai/graph/out/` as JSONL |

All prefixed with `npm --prefix .ai/mcp-controller run`.

### Seed data layout

```
.ai/graph/seed/
├── fact/
│   ├── nodes.jsonl
│   └── rels.jsonl
├── policy/
│   ├── policies.jsonl
│   └── lexeme_aliases.jsonl
└── recipe/
    └── manifest.jsonl
```

`sync` is idempotent — always drops everything and reloads from seed. Seed files are the immutable source of truth.

---

## Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEO4J_URI` | `bolt://127.0.0.1:7687` | Neo4j connection |
| `NEO4J_USERNAME` | `neo4j` | Neo4j auth |
| `NEO4J_PASSWORD` | `123456789` | Neo4j auth |
| `NEO4J_DATABASE` | `piopex` | Neo4j database |
| `MCP_REPO_ROOT` | auto-detected | Override repo root |
| `MCP_TARGET_REPO_ROOT` | same as repo root | Point indexer at different app |
| `E2E_TEST_APP_REPO` | `https://github.com/nartc/ng-conduit.git` | Override test-app clone URL |

---

## All Documentation

| Document | Audience | Path |
|----------|----------|------|
| **Drop-in user guide** | Target repo devs | `.ai/README.md` |
| Controller spec | MCP devs | `.ai/mcp-controller/specs/mcp_controller_full_spec.md` |
| Reference manual | MCP devs / agents | `specs/graph_gateway_reference_points.md` |
| Memory system guide | Target repo devs | `.ai/how-to/memory-system.md` |
| Custom codemods guide | Target repo devs | `.ai/how-to/extending-codemods.md` |
| Config reference | Both | `.ai/config/README.md` |
| Agent instructions | Agents | `.github/copilot-instructions.md` |
