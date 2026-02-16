# MCP Controller Implementation Progress

Last updated: 2026-02-16

## Crash-Recovery Notes

- This file is intentionally updated after each major phase.
- If a session crashes, resume from the first unchecked item in the checklist below.

## Checklist

- [x] Phase 0: Repo hygiene fix (`.gitignore`) and progress tracking file created.
- [x] Phase 1: Missing domain and infrastructure modules scaffolded.
- [x] Phase 2: Config schema + startup fail-fast validation.
- [x] Phase 3: Retrieval lanes and lexical index baseline.
- [x] Phase 4: PlanGraph validator hardening + evidence policy enforcement.
- [x] Phase 5: `patch_apply` and `code_run` execution layer with artifact bundles.
- [x] Phase 6: Memory promotion, recipes, and connector kernel hardening.
- [x] Phase 7: Dashboard/observability extensions and acceptance tests.
- [x] Final: Build and test suite green; summary aligned to full spec.

## Work Log

### 2026-02-16 - Phase 0

- Fixed ignore-file typo by replacing `.giitignore` with `.gitignore`.
- Added this progress tracker under `specs/implementation_progress.md`.
- Removed `dist/` and switched scripts to source-only `tsx` startup to match copy-into-repo workflow.

### 2026-02-16 - Phase 1

- Added missing domains with READMEs and service modules:
  `evidence-policy`, `worktree-scope`, `patch-exec`, `code-run`, `memory-promotion`, `recipes`.
- Added missing infrastructure modules:
  `lexical-index`, `fs`, `git`, `vm`, `http`.

### 2026-02-16 - Phase 2

- Added `.ai/config/schema.json` and `.ai/config/repo.json`.
- Expanded config model with repo roots, parser targets, hints, recipes, and feature flags.
- Added strict startup fail-fast config validation in `src/config/validateConfig.ts`.

### 2026-02-16 - Phase 3

- Added `IndexingService` with lexical + symbol indexing and Angular template parse checks.
- Added retrieval lane collector with required lanes:
  lexical, symbol, policy, artifact, episodic memory.
- Expanded ContextPack payload to include policy set, scope, validation plan, and lane summaries.

### 2026-02-16 - Phase 4

- Hardened PlanGraph validator with:
  envelope checks, strategy evidence checks, kind-specific node checks, and side-effect dependency checks.
- Added dedicated evidence-policy validation service for distinct-source and category-coverage enforcement.

### 2026-02-16 - Phase 5

- Implemented structured `patch_apply` flow with scope checks and collision guard.
- Implemented strict `code_run` preflight + async IIFE execution + placeholder rejection.
- Added per-node artifact bundle writing (`result.json`, `op.log`, `trace.refs.json`, `validation.json`, `diff.summary.json`).

### 2026-02-16 - Phase 6

- Added memory promotion service with pending/provisional/approved/rejected/expired states and auto-promotion lane.
- Added recipes registry and episodic recipe usage event emission.
- Added shared connector kernel (retry/backoff/cache/normalized errors) and integrated Jira/Swagger adapters.
- Enforced policy/recipe graph seed invariants and deterministic conflict tie-break in GraphOps.

### 2026-02-16 - Phase 7

- Extended observability with input/output envelopes, retrieval traces, rejection trends/signatures, and retrieval hotspots.
- Extended dashboard endpoints with trend/signature/hotspot metrics and memory promotion visibility.
- Expanded tests for acceptance-critical invariants (23 passing tests).

### 2026-02-16 - Final Verification

- Type checks pass: `npx tsc -p tsconfig.json --noEmit`.
- Test suite passes: `npm test`.

### 2026-02-16 - Packaging Alignment

- Relocated MCP runtime project into `.ai/mcp-controller`:
  `src`, `tests`, `scripts`, `specs`, `package.json`, `package-lock.json`, `tsconfig.json`, `node_modules`.
- Updated runtime path resolution so the MCP can run from inside `.ai/` while still targeting the host repo root.
- Root README now points to `.ai/mcp-controller` commands.

### 2026-02-16 - Post-Relocation Validation

- Type checks pass from relocated package:
  `./.ai/mcp-controller/node_modules/.bin/tsc -p .ai/mcp-controller/tsconfig.json --noEmit`.
- Unit/integration tests pass from relocated package:
  `npm --prefix .ai/mcp-controller test` (23 passing).
- E2E smoke passes from relocated package:
  `npm --prefix .ai/mcp-controller run e2e:smoke`.
- Graph pipeline checks pass from relocated package:
  `graphops:check`, `graphops:sync`, `graphops:export`.

### 2026-02-16 - MCP Registration + Runtime Bridge

- Added a real stdio MCP server entrypoint:
  `src/mcp/stdioServer.ts` with `initialize`, `tools/list`, and `tools/call` support.
- Added shared runtime bootstrap module:
  `src/runtime/bootstrapRuntime.ts` used by both `npm start` and stdio MCP startup.
- Added MCP launcher script:
  `scripts/run-mcp-stdio.mjs` for client registration via `node <repo>/.ai/mcp-controller/scripts/run-mcp-stdio.mjs`.
- Added MCP smoke test:
  `scripts/e2e-mcp-smoke.mjs`.
- Added MCP client config template:
  `.ai/config/mcp.client.template.json`.
- Removed legacy `.ai/graphs` folder in favor of canonical `.ai/graph`.

### 2026-02-16 - Workflow Hardening + Expanded E2E

- Implemented request token accounting and budget gating in `TurnController`:
  - `budgetStatus.usedTokens` now increments per turn.
  - non-safe verbs are blocked with `BLOCKED_BUDGET` + `BUDGET_THRESHOLD_EXCEEDED` once threshold is crossed.
- Added unit coverage for budget gate behavior:
  `tests/turnController.test.ts`.
- Expanded `scripts/e2e-smoke.mjs` to assert:
  - context-pack high-signal expectations and references,
  - sub-agent hint outputs,
  - budget gate behavior,
  - repeated-denial memory promotion path,
  - observability event presence (`input_envelope`, `retrieval_trace`, `output_envelope`, `pending_correction_created`).
- Added MCP method handler module `src/mcp/handler.ts` and refactored stdio server to use shared MCP method logic.
- Updated runtime scripts to use `node --import tsx ...` to avoid `tsx` IPC socket issues in constrained environments.

### 2026-02-16 - Validation Snapshot

- Typecheck passes:
  `./node_modules/.bin/tsc -p tsconfig.json --noEmit`.
- Unit/integration tests pass:
  `npm test` (24 passing).
- HTTP/dashboard end-to-end smoke passes:
  `npm run e2e:smoke`.
- MCP protocol-handler smoke passes:
  `npm run e2e:mcp-smoke`.
- Graph pipeline verified:
  - `npm run graphops:sync` passed.
  - `npm run graphops:check` passed (run with escalated permissions).
  - `npm run graphops:export` passed (run with escalated permissions).

### 2026-02-16 - Seed Safety + External App Isolation

- Updated e2e smoke scripts to run `graphops:sync` before and after each e2e run to seed/reset graph state.
- Added graph path-collision guards in `GraphOpsService` to prevent seed/output path overlap.
- Added isolation verifier script:
  `scripts/verify-isolation.mjs` (fails if non-`.ai` paths are changed).
- Added repo-level external harness:
  `e2e/run-validation.mjs` + `e2e/README.md`.
  - Clones/uses sibling `test-app/`,
  - keeps `.ai` at repo root (no `.ai` staging into test-app),
  - targets external app via `MCP_TARGET_REPO_ROOT`,
  - runs MCP e2e validations,
  - verifies test-app worktree stayed clean and seed digest stability.
- Harness run verified:
  `node e2e/run-validation.mjs` completed with clean `test-app` status and unchanged seed digest.

### 2026-02-16 - Glossary Alias Layer + Deterministic Reranking

- Added policy-backed glossary normalization:
  `src/domains/context-pack/glossaryNormalization.ts`.
  - sources: builtin aliases, seed policy aliases (`type=lexeme_alias`), approved/provisional memory aliases,
  - supports `negative_aliases` suppression for collision control.
- Added deterministic reranker with stable tie-breakers and reason traces:
  `src/domains/context-pack/retrievalReranker.ts`.
  - penalizes hub/utility/tailwind-noise candidates,
  - boosts route/nav, proof-chain coherence, test adjacency, and policy priors.
- Integrated normalization + reranking into retrieval lanes:
  `src/domains/context-pack/retrievalLanes.ts`.
- Context pack now records retrieval decisions and anchor fill source:
  `src/domains/context-pack/contextPackService.ts`.
- Added seed-backed alias policies:
  `.ai/graph/seed/policy/lexeme_aliases.jsonl`.
- Added tests for glossary + reranker behavior:
  `tests/retrievalReranker.test.ts`.
- Verification status:
  - `npm test` now passes with 27 tests.
  - `npm run e2e:smoke` passes.
  - `npm run e2e:mcp-smoke` passes (with escalated graph reset access).

### 2026-02-16 - Stability + Worktree Scope Alignment

- Repaired compile/runtime breaks introduced during prior edits:
  - added missing `node:path` import in `src/domains/controller/turnController.ts`,
  - fixed `read_range` assertion typing in `tests/turnController.test.ts`.
- Upgraded mutation targeting so approved plans can execute against real target repos:
  - `patch_apply` now writes under `planGraph.worktreeRoot` (not hardwired to `.ai/tmp/work/{workId}`),
  - `scopeAllowsFile` now supports explicit `worktreeRoot` and is used by `read_range` + `patch_apply`,
  - `list_allowed_files`/ContextPack now resolve against active worktree root.
- Added plan submission guardrail:
  - `submit_plan` now rejects `worktreeRoot` paths outside MCP target repo root or scoped `.ai/tmp/work/{workId}`.
- Improved multi-agent safety:
  - collision reservations are now scoped by `runSessionId:workId` (shared across agents on same work item).
- Hardened graph export determinism:
  - `graphops:sync` now clears export watermark so immediate `graphops:export` emits seeded deltas predictably.
- Verification rerun (latest snapshot):
  - `./node_modules/.bin/tsc -p tsconfig.json --noEmit` passes.
  - `npm test` passes (31 tests).
  - `npm run e2e:smoke` passes.
  - `npm run e2e:mcp-smoke` passes.
  - `node e2e/run-validation.mjs` passes (seed digest unchanged; `test-app` clean).
  - `npm run graphops:check && npm run graphops:sync && npm run graphops:export` passes (`nodeCount=6`, `relationshipCount=1`).

### 2026-02-16 - MCP Config + Docs Hardening

- Added ready-to-use MCP client registration:
  - `.ai/config/mcp.client.local.json` (absolute-path config for this workspace).
- Updated docs for operator clarity:
  - `.ai/README.md` now explicitly documents source-first runtime (no project build/dist required),
  - `.ai/README.md` calls out Swagger root/full-spec URL usage and local MCP config path,
  - `.ai/config/README.md` now references the local prefilled config file.
- Latest post-doc verification:
  - `./node_modules/.bin/tsc -p tsconfig.json --noEmit` passes.
  - `npm test` passes (31 tests).
  - `npm run e2e:mcp-smoke` passes.

### 2026-02-16 - MCP Full-Flow Smoke Upgrade

- Upgraded `scripts/e2e-mcp-smoke.mjs` from basic `list` validation to full MCP method flow:
  - `initialize` + `tools/list`,
  - `tools/call(controller.turn)` for `list`,
  - `submit_plan`,
  - `patch_apply`,
  - `code_run`,
  - `side_effect`.
- Added assertions for:
  - context-pack high-signal output and rerank algorithm id,
  - plan acceptance state transition,
  - on-disk patch mutation evidence,
  - code-run preflight acceptance,
  - gated side-effect acceptance.
- Verification after upgrade:
  - `npm run e2e:mcp-smoke` passes.
  - `npm test` passes (31 tests).
  - `node e2e/run-validation.mjs` passes with clean test-app status and unchanged seed digest.

### 2026-02-16 - MCP Stdio Transport Verification

- Verified framed JSON-RPC transport against stdio server (not only in-process handler):
  - sent `initialize`, `tools/list`, and `tools/call(controller.turn)` as `Content-Length` framed messages,
  - validated parsed responses include:
    - protocol init result,
    - `controller.turn` in tool list,
    - `PLAN_REQUIRED` state from `tools/call` list verb.
- Command-level smoke result:
  - `MCP stdio transport pipeline smoke passed. responses=3`.
- Added dedicated script + npm command:
  - `scripts/e2e-mcp-stdio-smoke.sh`
  - `npm run e2e:mcp-stdio-smoke`
- External harness now includes this transport lane:
  - `e2e/run-validation.mjs` runs `e2e:mcp-stdio-smoke` in addition to existing smokes.
- Latest verification chain:
  - `npm run e2e:smoke && npm run e2e:mcp-smoke && npm run e2e:mcp-stdio-smoke` passes.
  - `node e2e/run-validation.mjs` passes with all three smoke lanes.

### 2026-02-16 - Retrieval Root Coverage Expansion

- Extended index root discovery for mixed enterprise Angular layouts:
  - `IndexingService` now derives roots from `hints.angularRoots`, parser targets, and ingestion include patterns.
  - Removed hardcoded `src`-only assumption in index rebuild.
- Expanded default config roots and ingestion patterns for:
  - `src`, `apps`, `libs`, `projects`, `packages`.
- This improves retrieval coverage for dual component libraries and non-standard module layouts.
- Validation after expansion:
  - `./node_modules/.bin/tsc -p tsconfig.json --noEmit` passes.
  - `npm test` passes (31 tests).
  - `npm run e2e:smoke && npm run e2e:mcp-smoke && npm run e2e:mcp-stdio-smoke` passes.
  - `node e2e/run-validation.mjs` passes.

### 2026-02-16 - AST Codemod Allowlist + Citation Gating

- Added AST codemod catalog and policy surface:
  - `src/domains/patch-exec/astCodemodCatalog.ts`
  - allowlisted codemods only, each with required params and citation token.
- Expanded `patch_apply` execution model:
  - supports `operation=replace_text` and `operation=ast_codemod`,
  - rejects unknown/custom codemod IDs (`PLAN_POLICY_VIOLATION`),
  - enforces required params per codemod.
- Added PlanGraph citation gate for codemod execution:
  - `patch_apply` with `ast_codemod` now requires change-node citation `codemod:<codemodId>` (or versioned form).
- Added PlanGraph validator guard:
  - rejects unknown `codemod:*` citation tokens (`PLAN_POLICY_VIOLATION`).
- Added explicit agent-facing option disclosure:
  - turn responses now include `result.patchApplyOptions`,
  - ContextPack now includes `executionOptions.patchApply` and links codemod policy spec.
- Added codemod policy documentation:
  - `src/domains/patch-exec/README.md` expanded,
  - new spec `specs/ast_codemod_policy.md`,
  - `.ai/README.md` updated with codemod policy summary.
- Added test coverage:
  - `tests/turnController.test.ts`:
    - codemod without citation is rejected,
    - codemod with citation executes.
  - `tests/planGraphValidator.test.ts`:
    - unknown codemod citation rejected.
- Expanded E2E smokes to exercise AST codemod path:
  - `scripts/e2e-smoke.mjs`
  - `scripts/e2e-mcp-smoke.mjs`
- Verification snapshot after codemod changes:
  - `./node_modules/.bin/tsc -p tsconfig.json --noEmit` passes.
  - `npm test` passes (34 tests).
  - `npm run e2e:smoke && npm run e2e:mcp-smoke && npm run e2e:mcp-stdio-smoke` passes.
  - `node e2e/run-validation.mjs` passes with seed digest unchanged.
  - `npm run graphops:check && npm run graphops:sync && npm run graphops:export` passes.

### 2026-02-16 - Agent Options Contract Clarification

- Expanded `.ai/README.md` with an explicit agent runtime options contract for `patch_apply`.
- Documented expected `result.patchApplyOptions` shape and required flow:
  - call `list`,
  - consume options,
  - build PlanGraph + execution requests from allowlisted operations only.
- Added explicit guidance that custom codemods are blocked and unknown IDs must not be proposed.
- Reinforced citation linkage requirements for `ast_codemod`:
  - `change.citations` must include `codemod:<codemodId>` (version suffix optional).

### 2026-02-16 - VS Code Copilot MCP Workspace Config

- Added root workspace MCP config for GitHub Copilot in VS Code:
  - `.vscode/mcp.json`
- Config registers `mcp-controller-local` as `stdio` and launches:
  - `.ai/mcp-controller/scripts/run-mcp-stdio.mjs`
- Added secure password prompt input for Neo4j in MCP config:
  - `${input:neo4j-password}`
- Updated `.ai/README.md` with VS Code quick verification steps:
  - `MCP: List Servers`
  - `MCP: Start Server`
  - verify Copilot agent uses `controller.turn`.

### 2026-02-16 - VS Code MCP Startup Fix (`spawn node ENOENT`)

- Observed startup failure in VS Code MCP logs:
  - `Connection state: Error spawn node ENOENT`
- Cause:
  - extension host PATH did not resolve `node` when launching local MCP process.
- Fix:
  - updated `.vscode/mcp.json` server `command` from `node` to absolute Node executable path:
    - `/home/limz/.nvm/versions/node/v25.3.0/bin/node`
- Validation:
  - `.vscode/mcp.json` JSON parse check passes.
  - `npm run e2e:mcp-stdio-smoke` still passes after config update.

### 2026-02-16 - VS Code Placeholder Crash Fix (`reading 'replace'`)

- Observed new VS Code MCP startup error:
  - `Connection state: Error Cannot read properties of undefined (reading 'replace')`
- Cause:
  - MCP client-side placeholder interpolation in `.vscode/mcp.json` was brittle in this environment.
- Fix:
  - removed `${...}` placeholders and switched to explicit command+args only.
  - uses Windows launcher + WSL runtime bridge:
    - `command`: `C:\\Windows\\System32\\wsl.exe`
    - launches Node inside WSL with fixed paths.
- Result:
  - `.vscode/mcp.json` parses cleanly and no longer depends on extension-host PATH or placeholder expansion.

### 2026-02-16 - VS Code MCP Parse Crash Hotfix

- Found malformed `.vscode/mcp.json` in workspace state:
  - `args` present but `command` missing for `mcp-controller-local`.
- This matched runtime error:
  - `Cannot read properties of undefined (reading 'replace')`
- Hotfix applied:
  - rewrote `.vscode/mcp.json` to minimal valid `servers -> command + args` shape,
  - explicit Windows `wsl.exe` command and explicit WSL launch command for MCP runtime.

### 2026-02-16 - Replace Guard Instrumentation + AST Ingestion Hard Excludes

- Wrapped all `src/**` direct `.replace(...)` usages with a guarded helper that logs to `stderr` on failures:
  - new helper: `src/shared/replaceGuard.ts`
  - helper emits context tag + stack/message and rethrows.
- Updated call sites across:
  - `infrastructure/git/repoSnapshot.ts`
  - `infrastructure/neo4j/client.ts`
  - `domains/connectors/connectorRegistry.ts`
  - `domains/graph-ops/graphOpsService.ts`
  - `domains/patch-exec/patchExecService.ts`
  - `domains/evidence-policy/evidencePolicyService.ts`
  - `domains/context-pack/glossaryNormalization.ts`
  - `domains/indexing/indexingService.ts`
- Hardened first-pass AST/lexical ingestion traversal with non-configurable hard excludes:
  - directory segment blacklist includes `node_modules`, `dist`, `.angular`, `.git`, `.next`, `.cache`, `coverage`, `build`, `tmp`.
- Added explicit ingestion file extension allowlist:
  - `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.html`, `.json`, `.yaml`, `.yml`.
- Verification after hardening:
  - `./node_modules/.bin/tsc -p tsconfig.json --noEmit` passes.
  - `npm test` passes (34 tests).
  - `npm run e2e:smoke` passes.

### 2026-02-16 - MCP Transport Error Logging Hardening

- Added request-level stderr logging in stdio transport before JSON-RPC error responses:
  - logs `request_error method=<...> id=<...>` and stack/message.
  - file: `src/mcp/stdioServer.ts`
- Added process-level fatal handlers for visibility:
  - `uncaughtException`
  - `unhandledRejection`
  - both log to stderr and exit non-zero.
- Verification:
  - `./node_modules/.bin/tsc -p tsconfig.json --noEmit` passes.
  - `npm test` passes (34 tests).
  - `npm run e2e:mcp-stdio-smoke` passes.

### 2026-02-16 - VS Code Launch Simplification + Local Ignore Rules

- Removed wrapper launch dependency in VS Code MCP config:
  - `.vscode/mcp.json` now launches `src/mcp/stdioServer.ts` directly with `node --import tsx` inside WSL.
  - no `run-mcp-stdio.mjs` wrapper in MCP startup path.
- Added local ignore file for MCP subproject portability:
  - `.ai/mcp-controller/.gitignore`
  - ignores `node_modules/`, `dist/`, `coverage/`, `*.log`.
- Verification:
  - `.vscode/mcp.json` JSON parse check passes.
  - `npm run e2e:mcp-stdio-smoke` passes.

### 2026-02-16 - Initialize Handshake Reliability Fix

- Root issue addressed:
  - stdio server previously bootstrapped full runtime before serving handshake methods, so `initialize` could time out on large indexing/slow startup.
- Fix in `src/mcp/stdioServer.ts`:
  - lazy runtime bootstrap (`ensureRuntime`) for non-handshake methods only,
  - `initialize`, `notifications/initialized`, `tools/list`, and `ping` now return immediately,
  - background warm bootstrap retained (non-blocking).
- Fix in `src/mcp/handler.ts`:
  - `controller` is optional for handshake methods,
  - `tools/call` now throws explicit JSON-RPC error if runtime controller is unavailable.
- VS Code config hardening:
  - set `MCP_ENABLE_DASHBOARD=false` in `.vscode/mcp.json` to reduce startup contention.
- Verification:
  - `./node_modules/.bin/tsc -p tsconfig.json --noEmit` passes.
  - `npm test` passes (34 tests).
  - `npm run e2e:mcp-stdio-smoke` passes.

### 2026-02-16 - Initialize Wait Regression Follow-up

- Observed VS Code MCP state:
  - server process `Running`, but repeated `Waiting for server to respond to initialize request...`.
- Root cause:
  - eager background runtime warm-up could still consume event loop before handshake processing.
- Fix:
  - removed eager `ensureRuntime()` warm-up call in `src/mcp/stdioServer.ts`.
  - runtime now boots only when first non-handshake method is called.
- Result:
  - `initialize` path is strictly handshake-only and immediate.
  - `npm run e2e:mcp-stdio-smoke` passes after change.
