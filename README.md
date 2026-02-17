# ai_dump_2

**Graph-Backed Agentic Gateway** — an MCP controller that mediates between planning agents and a codebase via evidence-linked plans, dimensional memory, and gated execution.

## Architecture

- **18 verbs** (14 pre-plan, 4 post-plan) exposed via single `controller_turn` tool
- **NDJSON over stdio** transport, JSON-RPC 2.0, protocol version `2025-11-25`
- **6 run states**: PLAN_REQUIRED → PLAN_ACCEPTED → EXECUTION_ENABLED → COMPLETED (+ BLOCKED_BUDGET, FAILED)
- **Dimensional memory system**: friction-driven learning with domain anchors, three enforcement mechanisms (few-shot injection, plan rules, strategy signals), and session retrospectives
- **Plan validation**: evidence-linked PlanGraph with 17 rejection codes, memory rule enforcement, and strategy compliance
- **AST tooling**: 4 built-in codemods + extensible custom codemod registry
- **Neo4j graph** (bolt, lazy dynamic import for Node ≥25 compatibility)

## Runtime

MCP runtime files are colocated under `.ai/mcp-controller`.
Executes directly from TypeScript source (`tsx`); no build step required.

## Commands

Run from repo root:

| Command | Purpose |
|---------|---------|
| `npm --prefix .ai/mcp-controller test` | Unit tests |
| `npm --prefix .ai/mcp-controller start` | Start controller |
| `npm --prefix .ai/mcp-controller run start:mcp` | Start MCP stdio server |
| `npm --prefix .ai/mcp-controller run e2e:smoke` | E2E smoke tests |
| `npm --prefix .ai/mcp-controller run e2e:mcp-smoke` | MCP protocol smoke |
| `npm --prefix .ai/mcp-controller run e2e:mcp-stdio-smoke` | MCP stdio smoke |
| `node test-mcp-harness.mjs` | Full test harness (62 tests) |
| `node e2e/run-validation.mjs` | External test-app validation |

## Test Harness

62 tests across 8 sections (58 PASS, 0 FAIL, 4 SKIP):
1. Transport Layer
2. Pre-Plan Verbs (14 verbs)
3. Plan Lifecycle
4. Post-Plan Mutations
5. Session & Response
6. Mutation Deny Paths
7. Verb Descriptions
8. Memory System

## Documentation

| Document | Path |
|----------|------|
| Controller specification | `.ai/mcp-controller/specs/mcp_controller_full_spec.md` |
| Reference manual (REF IDs) | `specs/graph_gateway_reference_points.md` |
| Memory system how-to | `.ai/how-to/memory-system.md` |
| Custom codemods how-to | `.ai/how-to/extending-codemods.md` |
| Agent instructions | `.github/copilot-instructions.md` |

## Memory System

The controller learns from friction (repeated rejections) and enforces knowledge via:
- **Few-shot injection** into `trace_symbol_graph` results
- **Plan rules** enforced during plan validation
- **Strategy signals** for domain-specific strategy tuning

Memories are tied to **domain anchors** (auto-seeded from folder structure) and follow a lifecycle: pending → provisional → approved.

Three entry points: automatic friction detection, human override file drops (`.ai/memory/overrides/`), and session retrospectives (`signal_task_complete`).
