# Implementation Plan — Architecture v2 (Pack-First Lifecycle)

**Date:** 2026-02-17
**Source of truth:** `.ai/mcp-controller/specs/architecture_v2.md`
**Status:** Ready to execute. Drop this file into a fresh Copilot chat context.

---

## Instructions for the Implementing Agent

1. Read `.ai/mcp-controller/specs/architecture_v2.md` in full before touching any code.
2. Execute phases in order. Each phase has a "done when" gate — don't advance until it passes.
3. After each phase, update the checklist in `architecture_v2.md` §16 (lines 596-646) to mark items `[x]`.
4. Run `npm --prefix .ai/mcp-controller test` after every phase. Existing tests may break — fix them to match the new architecture, don't delete them.
5. Do NOT create summary/changelog markdown files. The checklist in `architecture_v2.md` IS the progress tracker.

---

## Phase 1: Lifecycle Inversion

**Spec ref:** `architecture_v2.md` §1 (lines 20-78), §4 (lines 170-281), §16.Phase1 (lines 596-605)

### What to do

#### 1a. Add `UNINITIALIZED` state to contracts

**File:** `src/contracts/controller.ts`
**Change:** Add `"UNINITIALIZED"` to the `RunState` union type.
**Why:** §2 line 82 — new initial state.

#### 1b. Add `progress` to TurnResponse

**File:** `src/contracts/controller.ts`
**Change:** Add `progress` field to `TurnResponse`:
```typescript
progress: {
  totalNodes: number;
  completedNodes: number;
  remainingNodes: number;
  pendingValidations: Array<{ nodeId: string; status: string }>;
};
```
**Why:** §8 (lines 362-385) — every response must include progress.

#### 1c. Update constants

**File:** `src/shared/constants.ts`
**Change:**
- Add `UNINITIALIZED_CAPABILITIES = ["initialize_work"] as const`
- Update `PRE_PLAN_CAPABILITIES` to include `write_scratch_file` and `escalate`, remove `list_available_verbs`, `list_scoped_files`, `list_directory_contents`, `fetch_jira_ticket`, `fetch_api_spec`, `get_original_prompt`, `request_evidence_guidance`
- Keep `POST_PLAN_CAPABILITIES` as PRE_PLAN + mutation verbs
- Update `SCHEMA_VERSION` to `"2.0.0"`
**Why:** §3 (lines 128-167) — verb table is restructured.

#### 1d. Update capability matrix

**File:** `src/domains/capability-gating/capabilityMatrix.ts`
**Change:**
- Add `UNINITIALIZED` state mapping → `["initialize_work"]`
- Update `PLAN_REQUIRED` → rename concept to `PLANNING`, gate to: `read_file_lines`, `lookup_symbol_definition`, `trace_symbol_graph`, `search_codebase_text`, `write_scratch_file`, `submit_execution_plan`, `escalate`, `signal_task_complete`
- `PLAN_ACCEPTED` / `EXECUTION_ENABLED`: above + `apply_code_patch`, `run_sandboxed_code`, `execute_gated_side_effect`, `run_automation_recipe`
- `COMPLETED` / `FAILED`: only `signal_task_complete`
- `BLOCKED_BUDGET`: `initialize_work`, `escalate`, `signal_task_complete`
**Why:** §3 lines 130-139.

#### 1e. Update verb catalog

**File:** `src/shared/verbCatalog.ts`
**Change:**
- Add `initialize_work` descriptor (description: "Bootstrap a work session. Sends prompt + lexemes, receives contextPack + strategy + planGraphSchema.", whenToUse: "First call of every session. Only verb available in UNINITIALIZED state.", requiredArgs: [], optionalArgs: ["lexemes", "attachments"])
- Add `escalate` descriptor (description: "Request additional context. MCP searches and adds to contextPack.", whenToUse: "When contextPack is insufficient to build a plan.", requiredArgs: ["need"], optionalArgs: ["requestedEvidence", "type"])
- Remove: `list_available_verbs`, `list_scoped_files`, `list_directory_contents`, `fetch_jira_ticket`, `fetch_api_spec`, `get_original_prompt`, `request_evidence_guidance`
- Keep all other existing descriptors as-is
**Why:** §3 lines 155-167 (removed verbs), §4 line 170 (initialize_work), §5 line 284 (escalate).

#### 1f. Update SessionState

**File:** `src/domains/controller/types.ts`
**Change:** Add to `SessionState`:
```typescript
contextPack?: {
  ref: string;
  hash: string;
  files: string[];
};
planGraphProgress?: {
  totalNodes: number;
  completedNodes: number;
  completedNodeIds: string[];
};
```
**Why:** §8 lines 362-385 (progress tracking), §4 lines 215-281 (contextPack on session).

#### 1g. Update session.ts — initial state

**File:** `src/domains/controller/session.ts`
**Change:** `createSession()` should set `state: "UNINITIALIZED"` instead of `"PLAN_REQUIRED"`.
**Why:** §2 line 117 — UNINITIALIZED is the initial state.

#### 1h. Create `initializeWorkHandler.ts`

**File:** `src/domains/controller/handlers/initializeWorkHandler.ts` (NEW)
**Change:** Create handler that:
1. Calls `memoryService.ingestOverrideFiles()` FIRST (§4 line 196, §15 line 586 gotcha #3)
2. Queries active memories SECOND
3. Computes base ContextSignature from prompt + lexemes
4. Calls connector handlers internally for Jira/Swagger if prompt/lexemes match patterns (§4 lines 201-202)
5. Builds contextPack via `createContextPack()` — move the entire CONTEXT_PACK_VERBS block from `turnController.ts` (currently lines ~245-340 in turnController) into this handler
6. Applies strategy_signal memory overrides to ContextSignature (§13 lines 530-535)
7. Computes final strategy AFTER overrides (§13 line 536)
8. Computes planGraphSchema shape (validators, expected kinds, required fields, evidence policy) per §7 lines 348-360
9. Creates `.ai/tmp/work/{workId}/` workspace
10. Writes pack to disk, computes SHA-256
11. Stores `contextPack` ref/hash/files on session
12. Returns: contextPack summary, planGraphSchema, strategy, capabilities, progress
13. Sets `stateOverride: "PLANNING"`

**Source material to move:** The context pack assembly block currently in `turnController.ts` inside the `if (CONTEXT_PACK_VERBS.has(request.verb))` conditional. That entire block moves here. The strategy selection currently at the top of `handleTurn` also partially moves here (the override application step).

#### 1i. Add pack-scope enforcement to read handlers

**File:** `src/domains/controller/handlers/readHandlers.ts`
**Change:** Every handler (`handleReadRange`, `handleReadSymbol`, `handleGrepLexeme`, `handleReadNeighbors`) must check that the requested file / result files are in `session.contextPack.files`. If the file is not in the pack, deny with `"PACK_SCOPE_VIOLATION"`.
**Why:** §3 lines 141-153 — pack-scoping rule.
**Implementation:** Add a utility function `isInPack(filePath: string, session: SessionState): boolean` that checks `session.contextPack?.files.includes(normalizedPath)`. Call it at the top of each handler.

#### 1j. Update turnController.ts

**File:** `src/domains/controller/turnController.ts`
**Change:**
- Remove the `CONTEXT_PACK_VERBS` set and the entire context pack assembly block from `handleTurn()` (moved to `initializeWorkHandler`)
- Add `initialize_work` case to `dispatchVerb()` switch
- Add `escalate` case to `dispatchVerb()` switch (calls new escalate handler, Phase 2)
- Remove cases: `list_scoped_files`, `list_directory_contents`, `fetch_jira_ticket`, `fetch_api_spec`, `get_original_prompt`, `request_evidence_guidance`, `list_available_verbs`
- Keep: `submit_execution_plan`, `write_scratch_file`, `read_file_lines`, `lookup_symbol_definition`, `search_codebase_text`, `trace_symbol_graph`, `apply_code_patch`, `run_sandboxed_code`, `execute_gated_side_effect`, `run_automation_recipe`, `signal_task_complete`
- Add `progress` to `makeResponse()` output — compute from `session.planGraphProgress`
- Add `originalPrompt` to every response envelope (replaces deleted `get_original_prompt` verb)
- Strategy selection stays in `handleTurn()` for the base computation, but `initialize_work` handler applies overrides before finalizing
**Why:** §1 lines 20-78 (lifecycle), §3 lines 155-167 (removed verbs), §18 lines 666-682 (file changes).

#### 1k. Update handler.ts tool schema

**File:** `src/mcp/handler.ts`
**Change:** Update `TOOL_DESCRIPTION` to reflect pack-first lifecycle. The `CONTROLLER_TURN_INPUT_SCHEMA` shape doesn't need to change (verb + args is still the contract).
**Why:** §18 line 679.

### Done when

- `npm test` passes (fix broken tests)
- Calling `controller_turn` with `verb: "initialize_work"` returns a contextPack, strategy, planGraphSchema, and capabilities
- Calling any read verb without a prior `initialize_work` returns a deny
- Calling `read_file_lines` with a file NOT in the contextPack returns `PACK_SCOPE_VIOLATION`

---

## Phase 2: Escalate Verb

**Spec ref:** `architecture_v2.md` §5 (lines 284-322), §16.Phase2 (lines 607-612)

### What to do

#### 2a. Rewrite escalateHandler.ts

**File:** `src/domains/controller/handlers/escalateHandler.ts`
**Change:** Replace current `handleEscalate` with new implementation:
1. Parse `args.need`, `args.type`, `args.requestedEvidence`
2. Based on type (`artifact_fetch`, `scope_expand`, `graph_expand`, `pack_rebuild`):
   - Search index/graph for matching files and symbols
   - Add found items to `session.contextPack.files` (monotonic — never remove)
   - Optionally re-augment planGraphSchema if new validators apply
3. Rewrite pack to disk, recompute SHA-256 hash
4. Return delta: new files added, new symbols, updated hash, updated schema (if changed)
5. State stays `PLANNING` (no state override)
**Why:** §5 lines 308-322.

#### 2b. Add incremental pack growth to contextPackService.ts

**File:** `src/domains/context-pack/contextPackService.ts`
**Change:** Add an `enrichContextPack()` function that takes an existing pack ref + new files/symbols and produces an updated pack. Must recompute hash.
**Why:** §5 line 310 — monotonic pack growth.

### Done when

- Agent can call `escalate` after `initialize_work` and get back new files in the pack
- Subsequent `read_file_lines` can read the newly added files
- Pack hash changes after escalation

---

## Phase 3: Progress Tracking

**Spec ref:** `architecture_v2.md` §8 (lines 362-385), §16.Phase3 (lines 614-619)

### What to do

#### 3a. Track node completion in session

**File:** `src/domains/controller/types.ts` (already updated in 1f), `src/domains/controller/turnController.ts`
**Change:** After each successful mutation handler (`handlePatchApply`, `handleCodeRun`, `handleSideEffect`), mark the node as completed in `session.planGraphProgress`. After `handleSubmitPlan` succeeds, initialize `planGraphProgress.totalNodes` from the plan.

#### 3b. Gate signal_task_complete

**File:** `src/domains/controller/handlers/retrospectiveHandler.ts`
**Change:** `handleSignalTaskComplete` must check `session.planGraphProgress.remainingNodes`. If > 0, reject with `"WORK_INCOMPLETE"` and return the remaining nodes list.
**Why:** §8 lines 380-385.

### Done when

- Every response includes `progress` with accurate counts
- `signal_task_complete` is rejected when nodes remain incomplete

---

## Phase 4: Day-0 Seed Expansion

**Spec ref:** `architecture_v2.md` §9 (lines 388-428), §16.Phase4 (lines 621-626)

**Note:** This phase requires Neo4j seed data changes. It can be done independently of Phases 1-3.

### What to do

- Extend `IndexingService` to extract high-signal symbol headers (interfaces, types, DTOs, route boundaries, key services) and persist as graph nodes
- Extract component usage facts from Angular template AST (`adp-*`, `sdf-*` tags) with file/line/attribute summaries
- Create a parser for SDF `components.d.ts` → `Component(tag)` + `Prop(name, type, required)` graph nodes
- Add JSONL seed files for MigrationRule policy objects (§11 lines 462-483)
- Add Cypher constraints for new node labels

### Done when

- `graphops:sync` loads symbol/component/contract nodes
- `IndexingService.rebuild()` produces usage facts queryable by domain anchor

---

## Phase 5: Policy Grounding + Enforcement Bundle

**Spec ref:** `architecture_v2.md` §10 (lines 432-450), §14 (lines 548-575), §16.Phase5 (lines 628-633)

### What to do

- Add `UIIntent`, `ComponentIntent`, `MacroConstraint` node types to seed schema
- Add grounding check: policy node must link to at least one `UsageExample` in the same domain to become enforceable (§10 lines 442-450)
- At plan submission, compute `enforcementBundle` from active memories + graph policies (§14 lines 558-575)
- Convert graph policy rules to `plan_rule` shape and feed through existing `validateMemoryRules()` — do NOT persist as memory records, they are ephemeral (§14 line 575)

### Done when

- Ungrounded policies are advisory-only in the pack
- Grounded policies deny plans missing required policyRefs
- Graph policies enforce without new validator plumbing

---

## Phase 6: Attachments

**Spec ref:** `architecture_v2.md` §12 (lines 493-521), §16.Phase6 (lines 635-639)

### What to do

- At `initialize_work`, scan `.ai/inbox/` for files, copy to `{workId}/attachments/`, create artifact records
- Accept `args.attachments[]` pass-through, store metadata as session artifacts
- Include attachment refs in contextPack response
- In plan validator: if a change node's citations reference an attachment, require matching `artifactRefs` entry (§12 lines 517-521)

### Done when

- Files dropped in `.ai/inbox/` appear in contextPack.attachments after initialize_work
- Plan denied if it cites attachment-derived requirements without artifactRefs

---

## Phase 7: AgentID / Sub-Agent Tracking

**Spec ref:** `architecture_v2.md` §6 (lines 324-346), §16.Phase7 (lines 641-646)

### What to do

- If a `controller_turn` call has a `workId` but no `agentId`: MCP assigns a new agentID and logs it as a new sub-agent
- Session lookup changes: contextPack and planGraph are keyed by `runSessionId:workId` (shared). Per-agent tracking (actions, rejections, budget) keyed by `runSessionId:workId:agentId`
- Update `.github/copilot-instructions.md` to include: "Always pass your agentId in every controller_turn call if you have one"

### Done when

- Multiple agents can operate under one workID sharing the same contextPack
- Each agent's actions are tracked separately

---

## Files: Change vs. Do Not Touch

### MUST CHANGE (Phases 1-3)

| File | What changes | Phase |
|------|-------------|-------|
| `src/contracts/controller.ts` | Add `UNINITIALIZED` to RunState, add `progress` to TurnResponse | 1 |
| `src/shared/constants.ts` | New verb lists, schema version bump | 1 |
| `src/shared/verbCatalog.ts` | Add `initialize_work`/`escalate`, remove retired verbs | 1 |
| `src/domains/capability-gating/capabilityMatrix.ts` | Add UNINITIALIZED state, restructure all state mappings | 1 |
| `src/domains/controller/types.ts` | Add contextPack + planGraphProgress to SessionState | 1 |
| `src/domains/controller/session.ts` | Initial state → UNINITIALIZED | 1 |
| `src/domains/controller/turnController.ts` | Remove context pack block from handleTurn, remove retired verb cases from dispatchVerb, add progress to makeResponse, add initialize_work/escalate dispatch | 1+2 |
| `src/domains/controller/handlers/readHandlers.ts` | Add pack-scope filter to all handlers | 1 |
| `src/domains/controller/handlers/escalateHandler.ts` | Full rewrite for pack enrichment | 2 |
| `src/domains/controller/handlers/retrospectiveHandler.ts` | Gate on remainingNodes | 3 |
| `src/domains/controller/handlers/mutationHandlers.ts` | Track completed nodes in session after successful patch/run | 3 |
| `src/domains/controller/handlers/planHandlers.ts` | Initialize planGraphProgress.totalNodes on plan acceptance | 3 |
| `src/mcp/handler.ts` | Update TOOL_DESCRIPTION | 1 |

### NEW FILES

| File | Purpose | Phase |
|------|---------|-------|
| `src/domains/controller/handlers/initializeWorkHandler.ts` | Bootstrap handler — builds pack, selects strategy, returns schema | 1 |

### DO NOT TOUCH

| File | Why |
|------|-----|
| `src/mcp/stdioServer.ts` | Transport is verb-agnostic. No changes needed. |
| `src/runtime/bootstrapRuntime.ts` | Boot sequence is fine. IndexingService.rebuild() at boot stays. |
| `src/config/*` | Config layering unchanged. |
| `src/infrastructure/*` | All infra (fs, git, http, lexical-index, neo4j, vm) unchanged. |
| `src/domains/patch-exec/*` | Patch exec, collision guard, AST codemods — all unchanged. |
| `src/domains/proof-chains/*` | Proof chain builder — unchanged, just called from initialize_work instead of submit_plan. |
| `src/domains/memory/*` | Memory service, anchor seeder, config — unchanged. |
| `src/domains/observability/*` | EventStore — unchanged. |
| `src/domains/plan-graph/planGraphValidator.ts` | Validation logic unchanged in Phase 1-3. Enhanced in Phase 5. |
| `src/domains/evidence-policy/*` | Evidence policy — unchanged. |
| `src/domains/code-run/*` | Code run service — unchanged. |
| `src/domains/recipes/*` | Recipe registry — unchanged. |
| `src/domains/context-pack/contextPackService.ts` | Unchanged in Phase 1. Gets `enrichContextPack()` added in Phase 2. |
| `src/domains/context-pack/retrievalLanes.ts` | Unchanged. |
| `src/domains/context-pack/retrievalReranker.ts` | Unchanged. |
| `src/domains/context-pack/glossaryNormalization.ts` | Unchanged. |
| `src/domains/strategy/*` | Unchanged in Phase 1-3. Strategy override layer added in Phase 5. |
| `src/domains/connectors/*` | Unchanged. Called internally by initializeWorkHandler instead of via standalone verbs. |
| `src/domains/dashboard/*` | Unchanged. |
| `src/domains/graph-ops/*` | Unchanged in Phase 1-3. Seed expansion in Phase 4. |
| `src/domains/indexing/*` | Unchanged in Phase 1-3. Enhanced in Phase 4. |
| `src/domains/worktree-scope/*` | Unchanged. |
| `src/shared/artifacts.ts` | Unchanged. |
| `src/shared/fileStore.ts` | Unchanged. |
| `src/shared/fsPaths.ts` | Unchanged. |
| `src/shared/ids.ts` | Unchanged. |
| `src/shared/replaceGuard.ts` | Unchanged. |

### DELETE (optional cleanup, not blocking)

| File/Code | Why |
|-----------|-----|
| `src/domains/controller/handlers/connectorHandlers.ts` | Jira/Swagger fetch absorbed into initializeWorkHandler. The connector *services* stay; only the standalone verb handlers are retired. Can be deleted or kept as dead code. |
| `src/domains/memory-promotion/memoryPromotionService.ts` | Already noted as superseded in v1 spec. |
