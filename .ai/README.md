# .ai — MCP Controller (Drop-In)

This folder is a self-contained MCP controller designed to be dropped into an Angular 14+ repository. Once installed, it gives VS Code Copilot (or any MCP-compatible agent) policy-gated, evidence-linked control over code changes.

**What it does:** prompt → agent → MCP → PlanGraph → gated execution → finish.

---

## Setup (5 minutes)

### Prerequisites

| Dependency | Version | Notes |
|------------|---------|-------|
| Node.js | ≥ 25 | Via [nvm](https://github.com/nvm-sh/nvm). WSL: `source ~/.nvm/nvm.sh && nvm use 25` |
| Neo4j | 5.x | Community or Enterprise, running locally or remote |

### 1. Install dependencies

From your repo root (the parent of `.ai/`):

```bash
npm --prefix .ai/mcp-controller install
```

No build step — runs directly from TypeScript via `tsx`.

### 2. Configure Neo4j

Create a database called `piopex` in your Neo4j instance.

Default connection (works out of the box with local Neo4j):

| Setting | Default |
|---------|---------|
| URI | `bolt://127.0.0.1:7687` |
| Username | `neo4j` |
| Password | `12345678` |
| Database | `piopex` |

**To override**, create `.ai/config/env.local.json` (gitignored):

```json
{
  "neo4j": {
    "uri": "bolt://your-host:7687",
    "username": "neo4j",
    "password": "your-password",
    "database": "piopex"
  }
}
```

Or set env vars: `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`.

### 3. Verify connectivity

```bash
npm --prefix .ai/mcp-controller run graphops:check
# → "graphops connectivity check passed."
```

### 4. Seed the graph database

```bash
npm --prefix .ai/mcp-controller run graphops:sync
# → "graphops sync complete. appliedCypherStatements=1 seededRows=6"
```

This wipes the database, rebuilds indexes, and loads all seed data from `.ai/graph/seed/`. **Idempotent — safe to run anytime.**

### 5. Connect VS Code

Add to your `.vscode/mcp.json` (create if it doesn't exist):

```jsonc
{
  "servers": {
    "mcp-controller": {
      "command": "wsl",
      "args": [
        "bash", "-c",
        "source ~/.nvm/nvm.sh && cd \"$(wslpath '${workspaceFolder}')\" && exec node --import tsx .ai/mcp-controller/src/mcp/stdioServer.ts"
      ],
      "env": {
        "NEO4J_URI": "bolt://127.0.0.1:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "123456789",
        "NEO4J_DATABASE": "piopex"
      }
    }
  }
}
```

> **Not on Windows/WSL?** Use the template at `.ai/config/mcp.client.template.json` — replace `<ABSOLUTE_REPO_ROOT>` with your repo path and point your MCP client at it.

### 6. Verify in VS Code

1. Command palette → **MCP: List Servers** → confirm `mcp-controller` appears
2. Command palette → **MCP: Start Server** → start it
3. In Copilot Chat (agent mode), the `controller_turn` tool should be available

---

## Daily Use

### Resyncing the database after seed changes

If anyone updates files in `.ai/graph/seed/`, resync:

```bash
npm --prefix .ai/mcp-controller run graphops:sync
```

Sync is destructive-then-rebuild — it drops everything and reloads from seed. The seed files themselves are **never modified by the runtime** (path isolation enforced in code).

### Exporting current graph state

```bash
npm --prefix .ai/mcp-controller run graphops:export
# Writes JSONL to .ai/graph/out/{policy,recipe,memory,fact}/
```

### Running tests

```bash
npm --prefix .ai/mcp-controller test
```

---

## How It Works

### Single tool, 18 verbs

The MCP exposes one tool — `controller_turn` — with a `verb` parameter. Agents call verbs to explore code, build plans, and execute changes.

| Phase | Verbs (14 pre-plan) |
|-------|---------------------|
| Explore | `list_available_verbs`, `list_scoped_files`, `list_directory_contents`, `read_file_lines` |
| Analyze | `lookup_symbol_definition`, `trace_symbol_graph`, `search_codebase_text` |
| External | `fetch_jira_ticket`, `fetch_api_spec` |
| Plan | `submit_execution_plan`, `write_scratch_file`, `get_original_prompt`, `request_evidence_guidance`, `signal_task_complete` |

| Phase | Verbs (4 post-plan, after plan acceptance) |
|-------|---------------------------------------------|
| Execute | `apply_code_patch`, `run_sandboxed_code`, `execute_gated_side_effect`, `run_automation_recipe` |

### Run states

```
PLAN_REQUIRED → (submit_execution_plan) → PLAN_ACCEPTED → EXECUTION_ENABLED → COMPLETED
                                                                    ↓
                                                              BLOCKED_BUDGET / FAILED
```

Mutation verbs are only available after a PlanGraph is accepted.

### Memory system

The controller learns from friction (repeated rejections) and enforces that knowledge on future sessions:

- **Few-shot injection** — before/after examples injected into `trace_symbol_graph` results
- **Plan rules** — required steps / deny conditions checked during plan validation
- **Strategy signals** — domain-specific feature flag overrides

Memories are tied to **domain anchors** (auto-seeded from folder structure) and follow a lifecycle: `pending → provisional → approved`.

Three ways memories are created:
1. **Automatic** — same rejection code hits threshold (default: 3) → scaffolded candidate
2. **Human override** — drop JSON in `.ai/memory/overrides/`
3. **Retrospective** — agent calls `signal_task_complete` at end of session

See `.ai/how-to/memory-system.md` for the full guide.

---

## Seed Data

Seed files are the source of truth for the graph database.

```
.ai/graph/
├── cypher/                           # Neo4j constraint scripts
│   └── 001_constraints.cypher
├── seed/                             # JSONL seed data
│   ├── fact/                         # Workspace entities
│   │   ├── nodes.jsonl
│   │   └── rels.jsonl
│   ├── policy/                       # Policies + lexeme aliases
│   │   ├── policies.jsonl
│   │   └── lexeme_aliases.jsonl
│   └── recipe/                       # Codemod/recipe definitions
│       └── manifest.jsonl
└── out/                              # Export output (gitignored)
```

### Adding seed data

Add JSONL rows to the appropriate file. Each row must have `kind: "node"` or `kind: "rel"`.

Policy/recipe nodes require: `id`, `type`, `version`, `updated_at`, `updated_by`.

```json
{"kind":"node","id":"my_policy","labels":["PolicyRule"],"properties":{"type":"hard","rule":"no_foo","version":1,"updated_at":"2026-02-17","updated_by":"dev"}}
```

Then resync: `npm --prefix .ai/mcp-controller run graphops:sync`

---

## Configuration

Config is layered (later wins):

1. `.ai/config/base.json` — defaults (committed)
2. `.ai/config/repo.json` — repo-specific overrides (committed)
3. `.ai/config/env.local.json` — local overrides (gitignored)
4. Environment variables — final override
5. Validated against `.ai/config/schema.json`

See `.ai/config/README.md` for details.

### Key environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEO4J_URI` | `bolt://127.0.0.1:7687` | Neo4j connection |
| `NEO4J_USERNAME` | `neo4j` | Neo4j auth |
| `NEO4J_PASSWORD` | `12345678` | Neo4j auth |
| `NEO4J_DATABASE` | `piopex` | Neo4j database |
| `MCP_REPO_ROOT` | auto-detected | Override repo root |
| `MCP_TARGET_REPO_ROOT` | same as repo root | Point indexer at different app |
| `MCP_DASHBOARD_PORT` | `8722` | Dashboard HTTP port |

---

## Patch & Codemod Policy

`apply_code_patch` supports two operations:

| Operation | Purpose |
|-----------|---------|
| `replace_text` | Direct text replacement |
| `ast_codemod` | Allowlisted AST transform |

4 built-in codemods: `rename_identifier_in_file`, `update_import_specifier`, `update_route_path_literal`, `rewrite_template_tag`.

Custom codemods can be registered at runtime — see `.ai/how-to/extending-codemods.md`.

PlanGraph change nodes using `ast_codemod` must include a `codemod:<id>` citation. Unknown codemod IDs are rejected with `PLAN_POLICY_VIOLATION`.

---

## Folder Layout

```
.ai/
├── config/              # Layered config + schema
├── graph/               # Neo4j seed data, constraints, exports
├── how-to/              # Developer guides
│   ├── memory-system.md
│   └── extending-codemods.md
├── memory/              # Runtime memory records + override drop folder
├── mcp-controller/      # MCP controller source
│   ├── src/
│   │   ├── contracts/   # Type contracts
│   │   ├── domains/     # Domain services
│   │   ├── handlers/    # 18 verb handlers
│   │   ├── infrastructure/
│   │   ├── mcp/         # NDJSON stdio transport
│   │   ├── runtime/     # Bootstrap + turn controller
│   │   └── shared/
│   ├── specs/           # Controller specification
│   ├── tests/
│   └── package.json
├── tmp/                 # Scratch files, friction ledger (gitignored)
└── README.md            # ← you are here
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `spawn node ENOENT` in VS Code | MCP can't find `node`. Use absolute path to node binary in `mcp.json` |
| `Cannot read properties of undefined (reading 'replace')` | Remove `${...}` placeholders from `mcp.json`, use explicit paths |
| Neo4j hangs on startup | Ensure you're on Node ≥ 25 (driver uses lazy dynamic import to avoid hang) |
| `graphops:check` fails | Neo4j not running, wrong credentials, or `piopex` database doesn't exist |
| Stale graph after seed edits | Run `graphops:sync` — it always rebuilds from seed files |
