# MCP Colocation Layout

Everything required for the MCP runtime is under this `.ai/` folder.

## What This MCP Is For

This MCP is a policy-gated controller for code changes in brittle Angular 14 repos.

- Single tool entrypoint: `controller.turn`.
- Flow target: `prompt -> agent -> MCP -> planGraph -> gated work units -> finish`.
- Strong-model planning with explicit PlanGraph validation.
- Weak-model implementation only after plan acceptance.
- Context packs are lexical-first, graph-backed, and high-signal.
- Mutation options are explicit and allowlisted; custom codemod engines are blocked by policy.

## Runtime Project

- `.ai/mcp-controller/` contains the executable MCP codebase:
  - `src/`
  - `tests/`
  - `scripts/`
  - `specs/`
  - `package.json`
- Runtime is source-first (`tsx`): no project build artifact directory is required.
  - `dist/` directories that exist under `.ai/mcp-controller/node_modules/` are dependency internals only.

## Runtime Data/Config

- `.ai/config/` layered config + schema.
- `.ai/auth/` local auth files (gitignored except docs).
- `.ai/graph/` graph seed/cypher/export artifacts.
- `.ai/tmp/` runtime temp artifacts/observability.

## Run Commands

From the host repo root:

- `npm --prefix .ai/mcp-controller test`
- `npm --prefix .ai/mcp-controller start`
- `npm --prefix .ai/mcp-controller run e2e:smoke`
- `npm --prefix .ai/mcp-controller run start:mcp`
- `npm --prefix .ai/mcp-controller run e2e:mcp-smoke`
- `npm --prefix .ai/mcp-controller run e2e:mcp-stdio-smoke`

Graph operations:

- `npm --prefix .ai/mcp-controller run graphops:check`
- `npm --prefix .ai/mcp-controller run graphops:sync`
- `npm --prefix .ai/mcp-controller run graphops:export`

## Seeding and Resetting the DB

Seed source-of-truth lives in:

- `.ai/graph/seed/`
- `.ai/graph/cypher/`

To rebuild Neo4j from seed:

- `npm --prefix .ai/mcp-controller run graphops:sync`

To verify connectivity:

- `npm --prefix .ai/mcp-controller run graphops:check`

To export snapshot deltas:

- `npm --prefix .ai/mcp-controller run graphops:export`

Graph reset behavior:

- `e2e:smoke` and `e2e:mcp-smoke` call `graphops:sync` before and after test flow.
- `e2e:mcp-stdio-smoke` is transport/read-path focused and does not mutate graph state.

## MCP Client Config

- Template: `.ai/config/mcp.client.template.json`
- Local ready-to-use example (this workspace): `.ai/config/mcp.client.local.json`
- Launcher: `.ai/mcp-controller/scripts/run-mcp-stdio.mjs`
- Optional target override: set `MCP_TARGET_REPO_ROOT` to point MCP indexing/snapshots at a sibling test app while keeping `.ai` in root.
- Swagger can be provided as a root URL (or full spec URL) through connector inputs/config roots.

## VS Code Copilot MCP Setup

Workspace config is provided at:

- `.vscode/mcp.json`

What it does:

- Registers `mcp-controller-local` as a stdio MCP server.
- Launches MCP through Windows `wsl.exe` into the WSL runtime.
- Runs `.ai/mcp-controller/scripts/run-mcp-stdio.mjs` from `/mnt/c/Users/WowSi/ai_dump_2`.

Quick verification in VS Code:

1. Open this repo root in VS Code.
2. Run command palette: `MCP: List Servers` and confirm `mcp-controller-local` is discovered.
3. Run `MCP: Start Server` for `mcp-controller-local`.
4. In Copilot Chat (agent mode), run a task that uses MCP and confirm tool calls resolve through `controller.turn`.

Troubleshooting:

- If VS Code logs `spawn node ENOENT`, MCP cannot find `node` on extension-host PATH.
- This workspace avoids PATH lookups by using:
  - Windows launcher: `C:\\Windows\\System32\\wsl.exe`
  - WSL Node: `/home/limz/.nvm/versions/node/v25.3.0/bin/node`
- If VS Code logs `Cannot read properties of undefined (reading 'replace')`, remove `${...}` placeholders from `.vscode/mcp.json` and use explicit command/args.

## Patch/Codemod Policy

- `patch_apply` supports:
  - `replace_text`
  - `ast_codemod` (allowlisted only)
- `ast_codemod` requires PlanGraph change-node citation `codemod:<codemodId>` (optionally versioned).
- Unknown/custom codemod IDs are rejected (`PLAN_POLICY_VIOLATION`).
- Full codemod policy spec: `.ai/mcp-controller/specs/ast_codemod_policy.md`

## Agent Runtime Options Contract

Agent must treat MCP-disclosed options as the source of truth, not assumptions:

1. Call `controller.turn` with `verb="list"` before planning.
2. Read `result.patchApplyOptions`.
3. Build PlanGraph + `patch_apply` calls only from those options.

Expected option shape:

```json
{
  "replaceText": {
    "operation": "replace_text",
    "requiredFields": ["nodeId", "targetFile", "targetSymbols", "find", "replace"]
  },
  "astCodemods": [
    {
      "id": "rename_identifier_in_file",
      "requiredParams": ["from", "to"],
      "citationToken": "codemod:rename_identifier_in_file"
    }
  ],
  "customCodemodsAllowed": false,
  "citationRule": "When operation=ast_codemod, change-node citations must include codemod:<codemodId>."
}
```

Notes:

- If `customCodemodsAllowed=false`, agent must not invent codemod IDs.
- If requested change needs a codemod that is not allowlisted, agent should choose a permitted operation or escalate.
- For `ast_codemod`, PlanGraph `change.citations` must include `codemod:<codemodId>` (or `codemod:<codemodId>@vN`) before execution.
- The same options are embedded in ContextPack as `executionOptions.patchApply`.

## External Test-App Harness

Use sibling test-app validation without copying `.ai` into the app:

- `node e2e/run-validation.mjs`

This harness:

- Uses root `.ai` only.
- Targets `test-app` via `MCP_TARGET_REPO_ROOT`.
- Verifies test-app git status remains clean.
- Verifies `.ai/graph/seed` digest remains unchanged.
