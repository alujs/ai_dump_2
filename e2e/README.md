# E2E Harness Layout

This repo keeps MCP runtime assets under `.ai/` and uses an isolated `test-app/` target for integration checks.

## Structure

- `.ai/`: MCP controller + graph/config/runtime data.
- `test-app/`: disposable Angular app clone target (gitignored).
- `e2e/`: orchestration scripts for staging, validation, and rollback checks.

## One-Command Validation

From repo root:

- `node e2e/run-validation.mjs`

What it does:

1. Clones an Angular starter into `test-app/` if missing.
2. Runs MCP tests/e2e from root `.ai/mcp-controller` with `MCP_TARGET_REPO_ROOT=test-app`.
3. Runs all smoke lanes: `e2e:smoke`, `e2e:mcp-smoke`, `e2e:mcp-stdio-smoke`.
4. Uses pre/post graph sync in stateful smoke scripts for DB seed/reset.
5. Verifies test-app git worktree stayed clean.
6. Verifies root `.ai/graph/seed` digest is unchanged.

Environment overrides:

- `E2E_TEST_APP_REPO`: alternate starter repo URL.
- `E2E_SKIP_GRAPH_RESET=1`: skip graph reset inside e2e scripts.
