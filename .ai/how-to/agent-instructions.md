# Agent Instructions — Setup Guide

How to configure AI agents (Copilot, Claude, custom) to work with the MCP controller.

## Quick Start

Two things needed:

1. **`.github/copilot-instructions.md`** — tells Copilot how to call `controller_turn`
2. **`.vscode/mcp.json`** — tells VS Code where the MCP server is

---

## 1. copilot-instructions.md

Create `.github/copilot-instructions.md` in your repo root:

```markdown
## MCP Controller

This repo has a policy-gated MCP controller at `.ai/`. All code changes must go through the `controller_turn` tool.

### Session flow

1. Call `controller_turn` with `verb: "initialize_work"` and your `originalPrompt`
2. Read the returned `contextPack`, `strategy`, and `planGraphSchema`
3. Use read/search verbs to gather context: `read_file_lines`, `lookup_symbol_definition`, `search_codebase_text`
4. If you need files outside the contextPack scope, call `escalate`
5. Submit your plan via `submit_execution_plan` with a PlanGraphDocument
6. Apply patches via `apply_code_patch`
7. Call `signal_task_complete` when done — this triggers memory candidate scaffolding

### Rules

- Always pass your `agentId` in every `controller_turn` call
- Sub-agents spawned from a parent should use a unique `agentId`
- Never skip `initialize_work` — it sets up scope, strategy, and budget
- If the controller rejects your plan, read the `fixes[]` array and resubmit
- Do not fabricate proof chains — if data is missing, call `escalate`
- When migration strategy is active, change nodes MUST cite a `migration:` policyRef

### Environment

- Angular 14 / TypeScript / Node.js
- macOS / VS Code
- Two component libraries: ADP (legacy, Waypoint) and SDF (new, design system)
- Neo4j graph has routes, symbols, components, policies, migration rules
- Runtime AST index has line-precise symbol locations and full-text search

### Memory system

- The controller learns from friction (repeated rejections → auto-created memories)
- You can suggest memories via `signal_task_complete` summary
- Human overrides go in `.ai/memory/overrides/` — see `.ai/how-to/memory-system.md`
```

---

## 2. .vscode/mcp.json

Create `.vscode/mcp.json` in your repo root:

```jsonc
{
  "servers": {
    "mcp-controller": {
      "command": "node",
      "args": [
        "--import", "tsx",
        ".ai/mcp-controller/src/mcp/stdioServer.ts"
      ],
      "env": {
        "NEO4J_URI": "bolt://127.0.0.1:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "12345678",
        "NEO4J_DATABASE": "piopex"
      }
    }
  }
}
```

Verify: Command Palette → **MCP: List Servers** → `mcp-controller` should appear.

> A template with all env vars is at `.ai/config/mcp.client.template.json`.

---

## 3. Custom Agent Modes (VS Code Agent)

VS Code Copilot supports custom agent modes via `.github/copilot-agents.yml`. You can define a dedicated mode that always uses the MCP controller:

```yaml
# .github/copilot-agents.yml
modes:
  migration-agent:
    name: "Migration Agent"
    description: "ADP → SDF migration with policy enforcement"
    instructions: |
      You are a migration specialist. Always use the controller_turn tool.
      Follow the session flow: initialize_work → read → plan → execute → signal_task_complete.
      When the strategy is "ui_migration", every change node must cite a migration rule.
      Check proof chains before modifying any component that touches ag-Grid tables.
    tools:
      - controller_turn
```

---

## 4. Background Agents for Memory Mining

Background agents can mine the codebase for patterns and feed them into the memory system as override files. This is how you scale knowledge capture beyond friction-based learning.

### Pattern: Run a sub-agent that writes memory overrides

```markdown
## Task for background agent

Scan all files matching `src/**/*.component.ts`. For each component:
1. Check if it imports from both `@ADP` and `@SDF` 
2. If yes, create a memory override JSON file in `.ai/memory/overrides/`

Memory format:
{
  "enforcementType": "informational",
  "trigger": "human_override",
  "phase": "approved",
  "domainAnchorIds": ["anchor:<folder-of-component>"],
  "fewShot": {
    "instruction": "This component uses both ADP and SDF — migration candidate",
    "before": "<the current import pattern>",
    "after": "<what the cleaned-up imports should look like>",
    "antiPattern": "Mixing ADP and SDF imports in same component",
    "whyWrong": "Dual-library components are fragile and block ADP removal"
  },
  "note": "Auto-mined by background agent on <date>"
}
```

### Pattern: Route coverage audit

```markdown
## Task for background agent  

Query Neo4j for all AngularRoute nodes. For each route:
1. Check if it has a ROUTES_TO edge to a Component
2. Check if the component has a corresponding .spec.ts file
3. For routes missing test coverage, create a memory override:

{
  "enforcementType": "plan_rule",
  "trigger": "human_override", 
  "phase": "approved",
  "domainAnchorIds": ["anchor:<route-folder>"],
  "planRule": {
    "condition": "changes to this route's component must include spec updates",
    "denyCode": "PLAN_MISSING_TEST_COVERAGE",
    "requiredSteps": [{"kind": "validate", "targetPattern": "*.spec.ts"}]
  },
  "note": "Route <path> has no test coverage — auto-mined"
}
```

### How to run background agents

1. Open a Copilot Chat window in agent mode
2. Paste the task prompt above
3. The agent will create `.json` files in `.ai/memory/overrides/`
4. On the next `initialize_work` call, the controller picks them up, ingests them, and renames to `.processed`

Or use VS Code tasks to run them headlessly — see `.ai/how-to/memory-system.md` for the full memory lifecycle.

---

## 5. Verb Reference for Agent Authors

| Verb | Phase | Purpose |
|------|-------|---------|
| `initialize_work` | Bootstrap | Start a session — get contextPack + strategy |
| `read_file_lines` | Explore | Read file contents (scoped to contextPack) |
| `lookup_symbol_definition` | Explore | Find where a symbol is defined |
| `trace_symbol_graph` | Explore | Walk symbol relationships in the graph |
| `search_codebase_text` | Explore | Full-text search across indexed files |
| `escalate` | Expand | Request additional files/symbols added to scope |
| `submit_execution_plan` | Plan | Submit a PlanGraphDocument for validation |
| `apply_code_patch` | Execute | Apply a code change |
| `run_sandboxed_code` | Execute | Run code in a sandbox |
| `execute_gated_side_effect` | Execute | Run a side effect (e.g., file rename) |
| `signal_task_complete` | Finish | End session — triggers retrospective + memory scaffolding |

---

## 6. Tips

- **Start sessions with clear intent** — the `originalPrompt` in `initialize_work` drives strategy selection
- **Don't fight rejections** — read the `fixes[]` array, it tells you exactly what to change
- **Use `escalate` liberally** — it's cheaper than guessing about out-of-scope files
- **Memory overrides are powerful** — if you know something the controller doesn't, write an override
- **proof chains matter** — for ag-Grid/federation work, the controller traces Table → Route → Component chains. If the chain is broken (missing graph data), it will reject plans
