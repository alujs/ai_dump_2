# Graph-Backed MCP Controller — Full Specification

**Version:** 2.0
**Date:** 2026-02-17
**Status:** Aligned with implementation (62 tests, 0 failures)

---

## Summary

Single-tool MCP controller over NDJSON stdio transport. Lexical-first graph retrieval, validator-gated planning, weak-model-safe execution, strict worktree scope, dimensional memory system with friction-driven learning, and observability-driven policy evolution.

---

## Core Model

- Strong models plan, weak models execute.
- MCP is the sole controller authority.
- NDJSON over stdio (JSON-RPC 2.0, protocol version `2025-11-25`).
- One external tool: `controller_turn`.
- No embeddings, local or external.

---

## Hard Constraints

| Constraint | Detail |
|-----------|--------|
| Single tool | `controller_turn` — all interactions through one tool |
| No embeddings | Lexical-first retrieval only |
| Local Neo4j | `bolt://127.0.0.1:7687`, lazy dynamic import (Node ≥25 workaround) |
| PlanGraph before writes | No repo mutations without validated plan |
| Scratch writes only pre-plan | `write_scratch_file` resolves under `.ai/tmp/work/{workId}/scratch/` |
| Work scoping | `workId` + worktree boundary enforced on every operation |
| Connectors | Jira and Swagger only in v1, PAT auth |
| Schema version | `1.0.0` |

---

## Architecture

### Source Tree

```
.ai/mcp-controller/src/
├── index.ts                          # Entry point (dashboard-enabled)
├── config/                           # Layered config loading + validation
│   ├── loadConfig.ts
│   ├── types.ts
│   └── validateConfig.ts
├── contracts/                        # Type contracts
│   ├── controller.ts                 # TurnRequest, TurnResponse, RunState
│   ├── memoryRecord.ts               # MemoryRecord, DomainAnchor, FrictionLedgerEntry
│   └── planGraph.ts                  # PlanGraphDocument, node kinds, evidence policy
├── domains/
│   ├── browser-automation/           # CDP plugin contracts (disabled in v1)
│   ├── capability-gating/            # State → verb matrix
│   ├── code-run/                     # Sandboxed IIFE execution
│   ├── connectors/                   # Jira + Swagger adapters, shared kernel
│   ├── context-pack/                 # Pack builder, retrieval lanes, reranking
│   ├── controller/                   # Turn dispatch, session, budget, handlers
│   │   └── handlers/                 # 7 handler files (read, plan, mutation, etc.)
│   ├── dashboard/                    # Express HTTP + SSE (port 8722)
│   ├── evaluation/                   # Golden tasks + metrics harness
│   ├── evidence-policy/              # Evidence category minima validation
│   ├── graph-ops/                    # Neo4j sync/export, JSONL seeds
│   ├── indexing/                     # ts-morph AST + lexical index
│   ├── memory/                       # Memory system (service, anchors, config)
│   ├── memory-promotion/             # Legacy promotion service (superseded)
│   ├── observability/                # EventStore, rejection heatmaps, SSE
│   ├── patch-exec/                   # Structured patches, AST codemods, collision guard
│   ├── plan-graph/                   # Plan validator + memory rule enforcement
│   ├── proof-chains/                 # ag-Grid + federation proof chain builder
│   ├── recipes/                      # Recipe registry (replace_lexeme, run_validation)
│   ├── strategy/                     # ContextSignature + deterministic strategy selection
│   └── worktree-scope/               # Path canonicalization, scope enforcement
├── infrastructure/
│   ├── fs/                           # Scoped file I/O
│   ├── git/                          # Repo snapshot IDs
│   ├── http/                         # HTTP client with retry/backoff/cache
│   ├── lexical-index/                # In-memory token-based search
│   ├── neo4j/                        # Lazy Neo4j driver (bolt)
│   └── vm/                           # vm.Script sandbox
├── mcp/
│   ├── handler.ts                    # Tool schema, request parsing, result formatting
│   └── stdioServer.ts                # NDJSON stdio transport, JSON-RPC 2.0
├── runtime/
│   └── bootstrapRuntime.ts           # Config → EventStore → Connectors → Indexing → Controller
└── shared/
    ├── artifacts.ts                  # Per-node artifact bundles
    ├── constants.ts                  # Tool name, capabilities, budget, schema version
    ├── fileStore.ts                  # ensureDir, writeText, readText, appendJsonl
    ├── fsPaths.ts                    # Path resolution (repo root, scratch, context, obs)
    ├── ids.ts                        # ID generation (ensureId, traceRef)
    ├── replaceGuard.ts               # Safe string replacement with error logging
    └── verbCatalog.ts                # Verb descriptors (description, whenToUse, args)
```

### Modularity Rules

- Soft target: 200–350 lines per file.
- Warning at 400 lines.
- 500+ requires justification.
- Every domain folder includes `README.md` with purpose, extension guide, gotchas, invariants.

---

## Protocol

### Transport

- NDJSON over stdio (newline-delimited JSON)
- JSON-RPC 2.0 with methods: `initialize`, `tools/list`, `tools/call`, `ping`
- Protocol version: `2025-11-25`
- Lazy runtime boot on first `tools/call`

### Request Envelope (`TurnRequest`)

| Field | Type | Required |
|-------|------|----------|
| `runSessionId` | string | optional (auto-generated) |
| `workId` | string | optional (auto-generated) |
| `agentId` | string | optional (auto-generated) |
| `originalPrompt` | string | optional |
| `verb` | string | **required** |
| `args` | Record | optional |
| `traceMeta` | Record | optional |

### Response Envelope (`TurnResponse`)

| Field | Type | Always |
|-------|------|--------|
| `runSessionId` | string | yes |
| `workId` | string | yes |
| `agentId` | string | yes |
| `state` | RunState | yes |
| `outcome` | `"ok" \| "pack_insufficient"` | optional |
| `capabilities` | string[] | yes |
| `verbDescriptions` | Record<verb, descriptor> | yes |
| `scope` | `{ worktreeRoot, scratchRoot }` | yes |
| `result` | Record | yes |
| `denyReasons` | string[] | yes |
| `suggestedAction` | `{ verb, reason, args? }` | on deny |
| `knowledgeStrategy` | `{ strategyId, contextSignature?, reasons[] }` | yes |
| `budgetStatus` | `{ maxTokens, usedTokens, thresholdTokens, blocked }` | yes |
| `traceRef` | string | yes |
| `schemaVersion` | string | yes |
| `subAgentHints` | `{ recommended, splits[] }` | yes |
| `packInsufficiency` | object | on pack_insufficient |

---

## Run States

```
PLAN_REQUIRED → PLAN_ACCEPTED → EXECUTION_ENABLED
     ↓                                    ↓
BLOCKED_BUDGET                        COMPLETED
     ↓                                    ↓
  FAILED ←──────────────────────────── FAILED
```

| State | Description |
|-------|-------------|
| `PLAN_REQUIRED` | Initial. Read-only verbs + plan submission. |
| `PLAN_ACCEPTED` | Plan validated. All verbs available. |
| `EXECUTION_ENABLED` | Execution in progress. All verbs available. |
| `BLOCKED_BUDGET` | Token budget exceeded. Only safe verbs. |
| `FAILED` | Terminal failure. Only safe verbs + retrospective. |
| `COMPLETED` | Task done. Only safe verbs + retrospective. |

---

## Verbs (18 total)

### Pre-Plan Verbs (14) — Available in `PLAN_REQUIRED`

| # | Verb | Purpose | Required Args |
|---|------|---------|---------------|
| 1 | `list_available_verbs` | List verbs available in current state | — |
| 2 | `list_scoped_files` | List all files in worktree scope | — |
| 3 | `list_directory_contents` | List entries in a directory | `targetDir` |
| 4 | `read_file_lines` | Read line range from scoped file | `targetFile` |
| 5 | `lookup_symbol_definition` | Look up symbol in AST index | `symbol` |
| 6 | `trace_symbol_graph` | Find related symbols via graph | `symbol \| targetFile \| query` |
| 7 | `search_codebase_text` | Grep text pattern across scope | `pattern` |
| 8 | `fetch_jira_ticket` | Fetch Jira ticket by key | `ticketKey` |
| 9 | `fetch_api_spec` | Fetch OpenAPI/Swagger spec | `specUrl` |
| 10 | `get_original_prompt` | Retrieve stored user prompt | — |
| 11 | `write_scratch_file` | Write temp file to scratch area | `relativePath`, `content` |
| 12 | `submit_execution_plan` | Submit PlanGraph for validation | `planGraph` |
| 13 | `request_evidence_guidance` | Signal stuck, get guidance | `blockingReasons` |
| 14 | `signal_task_complete` | Trigger session retrospective | — |

### Post-Plan Verbs (4) — Added in `PLAN_ACCEPTED` / `EXECUTION_ENABLED`

| # | Verb | Purpose | Required Args |
|---|------|---------|---------------|
| 15 | `apply_code_patch` | Structured code patch | `planNodeId`, `targetFile`, `edits` |
| 16 | `run_sandboxed_code` | Execute sandboxed IIFE | `planNodeId`, `code` |
| 17 | `execute_gated_side_effect` | Gated side-effect (git, etc.) | `planNodeId`, `sideEffectType` |
| 18 | `run_automation_recipe` | Run named recipe | `recipeId`, `planNodeId`, `artifactBundleRef`, `diffSummaryRef` |

### State-Specific Gating

| State | Available |
|-------|-----------|
| `PLAN_REQUIRED` | Verbs 1–14 |
| `PLAN_ACCEPTED` | Verbs 1–18 |
| `EXECUTION_ENABLED` | Verbs 1–18 |
| `BLOCKED_BUDGET` | `list_available_verbs`, `get_original_prompt`, `request_evidence_guidance` |
| `FAILED` | `list_available_verbs`, `get_original_prompt`, `signal_task_complete` |
| `COMPLETED` | `list_available_verbs`, `get_original_prompt`, `signal_task_complete` |

### Budget-Safe Verbs

These verbs execute even when token budget is exceeded:
- `list_available_verbs`
- `get_original_prompt`
- `request_evidence_guidance`
- `signal_task_complete`

### Verb Descriptions

Every response includes `verbDescriptions` — a record mapping each available verb to:
```typescript
{
  description: string;    // What the verb does
  whenToUse: string;      // When the agent should use it
  requiredArgs: string[]; // Mandatory arguments
  optionalArgs: string[]; // Optional arguments
}
```

### Suggested Action

When a verb is denied, the response includes `suggestedAction`:
```typescript
{
  verb: string;    // What verb to call instead
  reason: string;  // Why this is suggested
  args?: Record;   // Pre-filled arguments if applicable
}
```

---

## Handler Architecture

| Handler File | Verbs | Notes |
|-------------|-------|-------|
| `readHandlers.ts` | `read_file_lines`, `lookup_symbol_definition`, `search_codebase_text`, `list_directory_contents`, `trace_symbol_graph` | Few-shot injection on `trace_symbol_graph` |
| `planHandlers.ts` | `submit_execution_plan`, `write_scratch_file` | Memory rule enforcement on plan validation |
| `mutationHandlers.ts` | `apply_code_patch`, `run_sandboxed_code`, `execute_gated_side_effect` | Collision guard, artifact bundles |
| `connectorHandlers.ts` | `fetch_jira_ticket`, `fetch_api_spec` | External artifact connectors |
| `escalateHandler.ts` | `request_evidence_guidance` | Evidence escalation with guidance |
| `recipeHandler.ts` | `run_automation_recipe` | Recipe execution with episodic events |
| `retrospectiveHandler.ts` | `signal_task_complete` | Session retrospective + friction analysis |

---

## Context Pack

### Trigger

Context pack is assembled only on `submit_execution_plan` (not `write_scratch_file`).

### Required Sections

1. Header (IDs, hashes, `schemaVersion`)
2. Task constraints and conflicts
3. Active policy set
4. Active strategy with evidence-backed reasons
5. Anchors and proof chains
6. Allowed files and capabilities
7. Validation plan
8. Missingness and conflicts
9. Active memories (from dimensional memory system)

### Memory Injection

Active memories matching the plan's domain anchors are included in the context pack:
```typescript
{
  activeMemories: [{
    id, enforcementType, trigger, phase, state,
    domainAnchorIds, rejectionCodes,
    fewShot?, planRule?, strategySignal?, note?
  }]
}
```

### Pack Insufficiency

When context pack cannot be assembled (e.g., no indexing service), returns:
- `outcome: "pack_insufficient"`
- `missingAnchors[]` with `anchorType`, `requiredBy`, `whyRequired`, `attemptedSources[]`, `confidence`
- `escalationPlan[]` with typed actions
- `blockedCommands[]` that remain unavailable

---

## PlanGraph

### Envelope Required Fields

| Field | Type |
|-------|------|
| `workId` | string |
| `agentId` | string |
| `runSessionId` | string |
| `repoSnapshotId` | string |
| `worktreeRoot` | string |
| `contextPackRef` | string |
| `contextPackHash` | string |
| `policyVersionSet` | Record |
| `scopeAllowlistRef` | string |
| `knowledgeStrategyId` | string |
| `knowledgeStrategyReasons[]` | array with evidence refs |
| `evidencePolicy` | object (category minima) |
| `planFingerprint` | string |
| `sourceTraceRefs[]` | array |
| `schemaVersion` | string |

### Node Kinds

| Kind | Purpose | Key Required Fields |
|------|---------|-------------------|
| `change` | File mutation | `operation`, `targetFile`, `targetSymbols[]`, `whyThisFile`, `editIntent`, `citations[]`, `codeEvidence[]`, `verificationHooks[]` |
| `validate` | Verification step | `verificationHooks[]`, `mapsToNodeIds[]`, `successCriteria` |
| `escalate` | Evidence request | `requestedEvidence[]`, `blockingReasons[]` |
| `side_effect` | External action | `sideEffectType`, `sideEffectPayloadRef`, `commitGateId` |

### Common Node Fields

All nodes require: `nodeId`, `kind`, `dependsOn[]`, `atomicityBoundary`, `expectedFailureSignatures[]`, `correctionCandidateOnFail`.

### Validation

The plan validator checks:
1. Envelope completeness
2. Per-node required fields by kind
3. Scope and safety (path canonicalization, allowlist)
4. Evidence rules (category minima, distinct-source)
5. Strategy compliance
6. **Memory rules** (active `plan_rule` memories inject required steps and deny conditions)

Memory rule results are returned separately:
```typescript
{
  memoryRuleResults: [{
    memoryId: string;
    condition: string;
    satisfied: boolean;
    denyCode?: string;
  }]
}
```

---

## Memory System

### Overview

The memory system learns from friction (repeated rejections, human corrections) and enforces knowledge on future sessions through three mechanisms.

### Enforcement Types

| Type | Mechanism |
|------|-----------|
| `few_shot` | Injected into `trace_symbol_graph` results as before/after code examples |
| `plan_rule` | Added as required steps or deny conditions in plan validation |
| `strategy_signal` | Overrides strategy feature flags for specific domains |
| `informational` | Surfaced in context packs but not actively enforced |

### Memory Record (Dimensional Model)

```typescript
{
  // Identity
  id: string;

  // WHERE dimensions
  trigger: "rejection_pattern" | "human_override" | "retrospective" | "rule_violation" | "friction_signal";
  phase: "exploration" | "planning" | "execution" | "retrospective";
  domainAnchorIds: string[];      // Folder-based domain anchors
  graphNodeIds?: string[];        // Optional graph node references

  // WHAT dimension
  enforcementType: "few_shot" | "plan_rule" | "strategy_signal" | "informational";
  fewShot?: FewShotExample;       // instruction, before, after, antiPattern, whyWrong
  planRule?: PlanRule;             // condition, requiredSteps[], denyCode
  strategySignal?: StrategySignal; // featureFlag, value, reason

  // WHY dimension
  rejectionCodes: string[];
  originStrategyId?: string;
  note?: string;

  // Lifecycle
  state: "pending" | "provisional" | "approved" | "rejected" | "expired";
  createdAt: string;
  updatedAt: string;
  traceRef: string;
}
```

### Memory Lifecycle

```
pending → provisional → approved → retired
              ↑
        human override (skip to approved)
```

- **Pending**: Auto-created from rejection friction. Waits for contest window (default 48h).
- **Provisional**: Auto-promoted after contest window. Enforced but reversible.
- **Approved**: Human-approved or auto-promoted (for safe types). Fully enforced.
- **Rejected**: Human-rejected. Will not be promoted.
- **Expired**: Provisional that timed out without approval.

### Three Entry Points

1. **Friction-based** (automatic): When the same rejection code hits `rejectionThreshold` (default 3) times, a memory candidate is auto-created with scaffolded few-shot data.
2. **Human override** (file drop): Drop JSON files in `.ai/memory/overrides/`. Processed on next `submit_execution_plan`. Goes straight to `approved` state.
3. **Retrospective** (`signal_task_complete`): Handler reviews all friction data and scaffolds memory candidates from high-frequency patterns.

### Domain Anchors

- Auto-seeded from repository folder structure.
- Each folder becomes a `DomainAnchor` node with parent-child `:CONTAINS` relationships.
- Configurable max depth (default 3) and exclude patterns.
- Memories are connected to anchors via `domainAnchorIds`.
- File → anchor resolution finds most specific match and expands hierarchy.

### Friction Ledger

Every rejection event is logged to `.ai/tmp/friction-ledger.jsonl`:
```typescript
{
  ts: string;
  trigger: string;
  rejectionCodes: string[];
  domainAnchorIds: string[];
  memoryId?: string;
  rejectionCount: number;
  resolved: boolean;
  strategyId: string;
  sessionId: string;
  workId: string;
}
```

### Configuration

Edit `.ai/mcp-controller/src/domains/memory/config.ts`:

| Setting | Default | Purpose |
|---------|---------|---------|
| `rejectionThreshold` | 3 | Rejections before auto-creating memory |
| `contestWindowHours` | 48 | Hours pending memories wait before promotion |
| `provisionalExpiryHours` | 48 | Hours provisional memories wait before expiring |
| `humanOverrideInitialState` | `"approved"` | State for human-dropped memories |
| `enableFewShotInjection` | true | Inject few-shots in `trace_symbol_graph` |
| `enablePlanRuleMutation` | true | Enforce plan rules from memories |
| `enableStrategyOverride` | true | Allow strategy signal overrides |
| `anchorAutoSeedMaxDepth` | 3 | Folder depth for domain anchor scanning |
| `anchorExcludePatterns` | `[node_modules, .git, .ai, dist, build, ...]` | Folders to skip |
| `enableFrictionLedger` | true | Enable friction event logging |
| `frictionLedgerMaxEntries` | 5000 | Max entries before rotation |
| `enableAutoScaffoldFromRejections` | true | Auto-scaffold few-shots from rejections |
| `autoScaffoldMinRejections` | 3 | Min rejections for auto-scaffolding |
| `autoPromotableEnforcementTypes` | `["informational", "strategy_signal"]` | Types that can auto-promote |
| `humanApprovalRequired` | `["plan_rule"]` | Types requiring human approval |

### Files

| Path | Purpose |
|------|---------|
| `src/contracts/memoryRecord.ts` | Type contracts |
| `src/domains/memory/config.ts` | Configuration |
| `src/domains/memory/memoryService.ts` | Core lifecycle service (470 lines) |
| `src/domains/memory/anchorSeeder.ts` | Domain anchor scanner (253 lines) |
| `.ai/memory/records.json` | Persisted memory records (runtime) |
| `.ai/memory/changelog.jsonl` | Memory state transitions |
| `.ai/memory/overrides/` | Human override drop folder |
| `.ai/tmp/friction-ledger.jsonl` | Friction event log |

---

## signal_task_complete — Session Retrospective

When the agent calls `signal_task_complete`:

1. **Friction digest** is generated:
   - Rejection code heatmap
   - Top 10 rejection signatures
   - Retrieval hotspots
   - Rejection trend over time
   - Pending correction count

2. **Memory status** is reported:
   - Pending memories (with scaffolded flag)
   - Provisional memories
   - Approved count

3. **Session statistics**:
   - Total turns, total rejections
   - Verb distribution
   - Rejection distribution

4. **Suggestions** are generated:
   - High-frequency rejection codes → plan_rule candidates
   - Top friction signatures → few-shot candidates
   - Scaffolded memories needing human review

5. **State transitions** to `COMPLETED`.

Triggered via `.github/copilot-instructions.md`:
> When all implementation tasks are complete, call `signal_task_complete` with an optional `summary` to generate a session retrospective.

---

## Evidence Policy

| Field | Purpose |
|-------|---------|
| `minRequirementSources` | Minimum requirement citations per change |
| `minCodeEvidenceSources` | Minimum code evidence per change |
| `minPolicySources` | Minimum policy references |
| `allowSingleSourceWithGuard` | Enable low-evidence guard path |
| `lowEvidenceGuardRules[]` | Rules for single-source allowance |
| `distinctSourceDefinition` | How "distinct" sources are defined |

Single-source path requires: `lowEvidenceGuard=true`, `uncertaintyNote`, `requiresHumanReview=true`.

---

## Execution Model

### `apply_code_patch`

- Structured edit intent only (replace_text or AST codemod).
- Enforced against approved plan node, file, and symbols.
- 4 built-in AST codemods: `rename_identifier_in_file`, `update_import_specifier`, `update_route_path_literal`, `rewrite_template_tag`.
- Custom codemods registrable via runtime registry (`registerCustomCodemod()`).

### `run_sandboxed_code`

- Async IIFE in `vm.Script` sandbox.
- Preflight validates: declared inputs, timeout, memory cap, expected return shape.
- Placeholder/non-substantive returns rejected.

### `execute_gated_side_effect`

- Must reference approved `side_effect` plan node with `commitGateId`.
- No side effects without explicit commit gate.

### Per-Node Artifact Bundle

- `result.json`, `op.log`, `trace.refs.json`, `diff.summary.json`, `validation.json`

### Unified Collision Guard

All mutation verbs pass the same collision checks:
- File and symbol reservations
- Graph mutation reservations
- External side-effect gates
- Collisions reject before execution.

---

## Strategy Enforcement

### ContextSignature Features

| Feature | Type |
|---------|------|
| `hasJira` | boolean |
| `hasSwagger` | boolean |
| `mentionsAgGrid` | boolean |
| `touchesShadowDom` | boolean |
| `crossesFederationBoundary` | boolean |
| `migrationAdpDetected` | boolean |
| `contractAnchorPresent` | boolean |
| `testConfidenceLevel` | ordinal |

### Strategy Classes (4 mandatory)

| Strategy ID | When Selected |
|------------|---------------|
| `ui_aggrid_feature` | ag-Grid UI work |
| `api_contract_feature` | API/contract changes |
| `migration_adp_to_sdf` | ADP → SDF migration |
| `debug_symptom_trace` | Debugging from symptoms |

### Strategy Switch Triggers

- `plan_rejected`, `policy_conflict`, `repeated_failure_threshold`, `repeated_action_threshold`, `missing_required_proof_chain`

---

## Proof Chains

### ag-Grid Origin Chain

```
Table → ColumnDef → CellRenderer → NavTrigger → Route → Component → Service → Definition
```

### Federation Proof Chain

```
Host Route → Federation Mapping → Remote Expose → Remote Module → Destination Component
```

Built via Neo4j graph traversal with AST/lexical fallbacks (`ProofChainBuilder`, 495 lines).

---

## Connector Model

| Connector | Adapter | Auth |
|-----------|---------|------|
| Jira | `jiraTicketSlicer.ts` | PAT from `.ai/auth/jira.token` |
| Swagger | `connectorRegistry.ts` | PAT or public |

Shared kernel (`connectorKernel.ts`): retry/backoff, rate limit, cache, tracing, normalized errors.

### Retrieval Lanes (5 mandatory)

1. Lexical lane
2. Symbol lane
3. Policy lane
4. Artifact lane
5. Episodic memory lane

---

## Recipes

| Recipe ID | Purpose |
|-----------|---------|
| `replace_lexeme_in_file` | Codemod-style lexeme replacement |
| `run_targeted_validation` | Targeted test/validation execution |

Execution emits episodic `recipe_usage` event with: `recipeId`, `validatedParams`, `workId`, `runSessionId`, `planNodeId`, `artifactBundleRef`, `diffSummaryRef`, `validationOutcome`, `failureSignature?`.

---

## Observability

### EventStore

- In-memory event store with SSE streaming.
- Methods: `append()`, `onEvent()`, `listRecent()`, `listErrors()`, `listPendingCorrections()`.
- Analytics: `rejectionHeatmap()`, `rejectionTrend()`, `topRejectionSignatures()`, `retrievalHotspots()`.

### Dashboard

- Express/HTTP on port 8722 (configurable via `MCP_DASHBOARD_PORT`).
- Endpoints: `/health`, `/turn`, `/worktrees`, `/runs`, `/errors`, `/policies/pending`, `/metrics`, `/stream/events` (SSE).

---

## Rejection Codes

| Code | Domain |
|------|--------|
| `PLAN_MISSING_REQUIRED_FIELDS` | Plan validation |
| `PLAN_SCOPE_VIOLATION` | Scope/capability gating |
| `PLAN_EVIDENCE_INSUFFICIENT` | Evidence policy |
| `PLAN_NOT_ATOMIC` | Atomicity rules |
| `PLAN_VERIFICATION_WEAK` | Verification hooks |
| `PLAN_STRATEGY_MISMATCH` | Strategy compliance |
| `PLAN_WEAK_MODEL_AMBIGUOUS` | Weak-model handoff |
| `PLAN_FEDERATION_PROOF_MISSING` | Federation proof chains |
| `PLAN_ORIGIN_UNKNOWN` | ag-Grid origin chain |
| `PLAN_POLICY_VIOLATION` | Policy rule violation |
| `PLAN_MISSING_CONTRACT_ANCHOR` | Contract anchor missing |
| `PLAN_VALIDATION_CONFIDENCE_TOO_LOW` | Confidence threshold |
| `EXEC_SIDE_EFFECT_COLLISION` | Collision guard |
| `EXEC_UNGATED_SIDE_EFFECT` | Missing commit gate |
| `MEMORY_PROVISIONAL_EXPIRED` | Expired provisional memory |
| `PACK_INSUFFICIENT` | Context pack assembly failure |
| `PACK_REQUIRED_ANCHOR_UNRESOLVED` | Anchor resolution failure |

---

## Budget

| Constant | Value |
|----------|-------|
| `DEFAULT_MAX_TOKENS` | 100,000 |
| `DEFAULT_BUDGET_THRESHOLD_PERCENT` | 0.6 (60%) |

Token cost estimated from serialized request size (÷4). Budget-safe verbs bypass the gate.

---

## Config Portability

Layered files merged at startup:
1. `.ai/config/schema.json`
2. `.ai/config/base.json`
3. `.ai/config/repo.json`
4. `.ai/config/env.local.json` (gitignored)

Required config: repo/worktree roots, ingestion globs, Angular/federation hints, parser targets, connector settings, auth refs, recipe manifest path, dashboard port, feature flags.

---

## AST Tooling

| Parser | Target |
|--------|--------|
| `ts-morph` (typescript) | TypeScript/JavaScript symbol extraction |
| `@angular/compiler` | Angular template parsing (tags, bindings, directives) |
| Native JSON/YAML | Config file indexing |

Full AST/symbol index at startup via `IndexingService.rebuild()`. Parser failures logged as structured events.

---

## GraphOps and Team Sync

### Sync Workflow
1. Drop graph
2. Recreate constraints/indexes
3. Upsert from `.ai/graph/seed/**/*.jsonl`

### Seed Row Invariants
Every policy/recipe row: `id`, `type`, `version`, `updated_at`, `updated_by`.

### Folders
- `.ai/graph/seed/` — canonical JSONL
- `.ai/graph/cypher/` — Cypher scripts
- `.ai/graph/out/` — exported deltas

---

## Safety

- Worktree + `workId` scope on every operation.
- Canonicalized path checks prevent traversal.
- No wildcard symbol scopes.
- No side effects without commit gate.
- No arbitrary codemod args — `recipeId + validated params` only.
- Secrets redacted from logs/artifacts.

---

## Test Harness

62 tests across 8 sections (58 PASS, 0 FAIL, 4 SKIP):

| Section | Coverage |
|---------|----------|
| 1. Transport Layer | Initialize, tools/list, ping, unknown method, wrong tool, missing verb |
| 2. Pre-Plan Verbs | All 14 pre-plan verbs with missing field denials |
| 3. Plan Lifecycle | Submit invalid/valid plans, state transitions |
| 4. Post-Plan Mutations | Patch, code_run, side_effect denials; recipe execution |
| 5. Session & Response | Envelope structure, budget, strategy, sub-agent hints |
| 6. Mutation Deny Paths | Pre-plan mutation denials with actionable errors |
| 7. Verb Descriptions | verbDescriptions, suggestedAction, escalate description |
| 8. Memory System | signal_task_complete, retrospective, friction digest, memory status |

Run: `node test-mcp-harness.mjs` from repo root.

---

## Non-Goals for v1

- Full CDP runtime execution (contracts defined, disabled behind flag).
- Multi-agent parallel execution orchestration.
- Cloud-hosted secrets or remote graph services.
- Embedding-based retrieval.
