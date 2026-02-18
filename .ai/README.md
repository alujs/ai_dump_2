# .ai — MCP Controller

Policy-gated code execution controller backed by Neo4j.
Drop this folder into your Angular repo. VS Code Copilot (or any MCP client) gets a single tool — `controller_turn` — that enforces evidence-linked plans before any code changes.

---

## 1. Prerequisites

| What | Version | Install |
|------|---------|---------|
| Node.js | ≥ 25 | `brew install node` or [nvm](https://github.com/nvm-sh/nvm): `nvm install 25 && nvm use 25` |
| Neo4j | 5.x | `brew install neo4j` or [Neo4j Desktop](https://neo4j.com/download/) |
| VS Code | latest | With GitHub Copilot + Copilot Chat extensions |

---

## 2. Install Dependencies

From your repo root (the parent of `.ai/`):

```bash
npm install
```

No build step — runs directly from TypeScript via `tsx`.

---

## 3. Configure Neo4j

Start Neo4j and create a database called `piopex`.

**Default connection (works with local Neo4j out of the box):**

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

Or set environment variables: `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`.

Verify the connection:

```bash
npm run graphops:check
# → "graphops connectivity check passed."
```

---

## 4. Secrets & Tokens

### Jira Personal Access Token

Create the file `.ai/auth/jira.token` containing your PAT (one line, no newline):

```bash
echo -n "YOUR_JIRA_PAT_HERE" > .ai/auth/jira.token
```

Then set your Jira base URL in `.ai/config/env.local.json`:

```json
{
  "jira": {
    "baseUrl": "https://your-org.atlassian.net"
  }
}
```

The `.ai/auth/` directory is gitignored. Never commit tokens.

### Swagger / OpenAPI specs

If your project has Swagger roots, add them to `.ai/config/env.local.json`:

```json
{
  "swagger": {
    "roots": ["path/to/openapi.yaml"]
  }
}
```

---

## 5. Seed the Graph Database (Day-0 Setup)

The graph database stores policies, migration rules, lexeme aliases, recipes, and workspace facts.

```bash
npm run graphops:sync
# → "graphops sync complete. appliedCypherStatements=N seededRows=N"
```

This is destructive-then-rebuild — it drops everything and reloads from the JSONL files in `.ai/graph/seed/`. **Idempotent, safe to run anytime.**

Seed data lives here:

```
.ai/graph/seed/
├── fact/           # Workspace entity nodes + relationships
│   ├── nodes.jsonl
│   └── rels.jsonl
├── policy/         # Policy rules, migration rules, lexeme aliases
│   ├── policies.jsonl
│   ├── migration_rules.jsonl
│   ├── intent_and_constraints.jsonl
│   └── lexeme_aliases.jsonl
└── recipe/         # Codemod/recipe definitions
    └── manifest.jsonl
```

To add seed data: add JSONL rows to the appropriate file, then `npm run graphops:sync`.

---

## 6. Ingest ADP Usage & AST Symbols (Day-0 Repo Scan)

**This happens automatically when the MCP server starts.** No separate command needed.

On startup, `IndexingService.rebuild()` scans your target repo and builds an in-memory index of:

| What | How |
|------|-----|
| **AST symbols** | `ts-morph` parses every `.ts`/`.js` file → extracts classes, interfaces, functions, enums, types, variables |
| **ADP/SDF tag usage** | `@angular/compiler` parses every `.html` template → extracts `adp-*` and `sdf-*` component usage with file, line, attributes |
| **Lexical index** | Full-text content indexing for grep-like searches |

The scan targets are configured in `.ai/config/base.json` under `ingestion.includes` / `ingestion.excludes` and `parserTargets`.

**To point the indexer at a different repo** (e.g., during development), set:

```bash
export MCP_TARGET_REPO_ROOT=/path/to/your/angular/app
```

Or in your MCP config env block (see step 7).

### SDF Contract Ingestion (Waypoint)

The `sdfContractParser` can parse a Waypoint-style `components.d.ts` into Component + Prop graph node shapes. This parser exists (`src/domains/indexing/sdfContractParser.ts`) but is **not yet wired into a standalone CLI command** — it's available for programmatic use and spec'd for future CLI integration.

---

## 7. Connect to VS Code (MCP Setup)

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

> A template with all env vars is at `.ai/config/mcp.client.template.json`.

**Verify:**

1. Command Palette → **MCP: List Servers** → confirm `mcp-controller` appears
2. Command Palette → **MCP: Start Server** → start it
3. In Copilot Chat (agent mode), the `controller_turn` tool should appear

---

## 8. General Usage

### How a session works

```
initialize_work → read/search/escalate → submit_execution_plan → apply patches → signal_task_complete
```

Every interaction goes through `controller_turn` with a `verb` parameter:

| Phase | Verbs |
|-------|-------|
| **Bootstrap** | `initialize_work` — sends prompt, gets contextPack + strategy + planGraphSchema |
| **Explore** | `read_file_lines`, `lookup_symbol_definition`, `trace_symbol_graph`, `search_codebase_text` |
| **Expand context** | `escalate` — request additional files/symbols be added to the contextPack |
| **Plan** | `submit_execution_plan` — submit a PlanGraphDocument for validation |
| **Execute** | `apply_code_patch`, `run_sandboxed_code`, `execute_gated_side_effect` |
| **Finish** | `signal_task_complete` — triggers retrospective + memory candidates |

### Resyncing the database after seed changes

```bash
npm run graphops:sync
```

### Exporting current graph state

```bash
npm run graphops:export
# Writes JSONL to .ai/graph/out/
```

### Running tests

```bash
npm test
```

### Adding human override memories

Drop a JSON file in `.ai/memory/overrides/`:

```json
{
  "domainAnchorIds": ["anchor:src/app"],
  "enforcementType": "plan_rule",
  "planRule": {
    "condition": "migration changes must include a test node",
    "denyCode": "PLAN_MISSING_TEST_VALIDATION",
    "requiredSteps": [{ "kind": "validate", "targetPattern": "spec" }]
  },
  "note": "Require test coverage for all migration changes"
}
```

The controller ingests these on next `initialize_work` and renames them to `.processed`.

---

## 9. Environment Variables Reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEO4J_URI` | `bolt://127.0.0.1:7687` | Neo4j connection |
| `NEO4J_USERNAME` | `neo4j` | Neo4j auth |
| `NEO4J_PASSWORD` | `12345678` | Neo4j auth |
| `NEO4J_DATABASE` | `piopex` | Neo4j database name |
| `MCP_REPO_ROOT` | auto-detected | Root of the repo containing `.ai/` |
| `MCP_TARGET_REPO_ROOT` | same as `MCP_REPO_ROOT` | Root of the app to index (can differ for dev) |
| `MCP_DASHBOARD_PORT` | `8722` | Dashboard HTTP port |
| `MCP_ENABLE_DASHBOARD` | `false` | Enable dashboard HTTP server |

---

## 10. Folder Layout

```
.ai/
├── auth/                # Jira PAT + secrets (gitignored)
├── config/              # Layered config: base.json → repo.json → env.local.json
├── Docker/              # Docker env example
├── graph/
│   ├── cypher/          # Neo4j constraint scripts
│   ├── seed/            # JSONL seed data (policy, fact, recipe)
│   └── out/             # Export output (gitignored)
├── how-to/              # Guides: memory-system.md, extending-codemods.md
├── memory/
│   ├── overrides/       # Drop JSON files here for human override memories
│   └── records.json     # Runtime memory state
├── mcp-controller/
│   ├── scripts/         # MCP stdio launcher, e2e smoke tests
│   ├── specs/           # Architecture spec
│   ├── src/             # Controller source (TypeScript, runs via tsx)
│   └── tests/           # Unit tests
├── tmp/                 # Scratch files, friction ledger (gitignored)
└── README.md            # ← you are here
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `graphops:check` fails | Neo4j not running, wrong creds, or `piopex` database doesn't exist |
| MCP server won't start in VS Code | Check `node --version` is ≥ 25. Use absolute path to `node` in `mcp.json` if needed |
| Indexer finds no symbols | `MCP_TARGET_REPO_ROOT` is wrong or the target has no `.ts` files |
| Stale graph after seed edits | Run `npm run graphops:sync` |
| Jira fetch fails silently | Check `.ai/auth/jira.token` exists and `jira.baseUrl` is set in config |
