# MCP Controller — Architecture v2 (Pack-First Lifecycle)

**Version:** 2.0-draft
**Date:** 2026-02-17
**Status:** Design approved, not yet implemented
**Supersedes:** `mcp_controller_full_spec.md` (v1 agent-driven model)

---

## 0. Non-Negotiable Invariants

1. **The agent never plans outside the ContextPack.** Every file, symbol, policy, and memory the agent can see comes from the pack. If it's not in the pack, it doesn't exist to the agent.
2. **MCP drives discovery, not the agent.** The agent's job is to plan and execute against what MCP gives it, not to explore the codebase.
3. **One tool, one bootstrap verb.** The agent starts with `initialize_work` and nothing else. Everything after that is gated by the pack and the state machine.
4. **WorkID is a permission key.** It scopes access to a bucket (`.ai/tmp/work/{workId}/`). All sub-agents share the same workID. AgentID is for tracking only.
5. **Completion is determined by validation, not agent opinion.** All `validate` nodes in the PlanGraph must pass. The agent cannot declare itself done while work remains.

---

## 1. Lifecycle (The Correct Order)

```
MCP boots → builds AST/index (full workspace)
    ↓
User prompts agent
    ↓
Agent has ONE verb: initialize_work
    ↓
Agent sends: { verb: "initialize_work", originalPrompt, args: { lexemes, attachments? } }
    ↓
MCP does (in this order):
    1. Mint runSessionId, workId, agentId
    2. Create .ai/tmp/work/{workId}/ workspace
    3. Ingest side channels (overrides from .ai/memory/overrides/, inbox, attachments)
    4. Query graph + indexes to assemble ContextPack
       - Retrieval lanes (lexical, symbol, policy, artifact, episodic memory)
       - Proof chains (if ContextSignature signals ag-Grid/federation)
       - Jira fetch (if prompt/lexemes reference a ticket key)
       - Swagger fetch (if prompt/lexemes reference API)
       - Active memories for domain anchors
       - Day-0 seed facts (symbols, components, templates)
    5. Apply graph/memory overrides to:
       a. Strategy selection (ContextSignature overrides from strategy_signal memories)
       b. Plan acceptance rules (validator augmentation from graph policies + plan_rule memories)
    6. Compute final strategy (AFTER overrides, not before)
    7. Write pack to disk, compute SHA-256 hash
    ↓
MCP responds with:
    - workId, agentId, state: "PLANNING"
    - contextPack location + hash + content summary (files, symbols, policies, memories)
    - planGraphSchema (augmented validators, expected node kinds, required fields, evidence policy)
    - strategy (approach, escalation guidance, suggested sub-agent splits)
    - available verbs for PLANNING state
    - progress: { totalNodes: 0, completedNodes: 0, remainingNodes: 0 }
    ↓
Agent (or sub-agents with same workID) either:
    a. Creates PlanGraph conforming to the provided schema → submit_execution_plan
    b. Calls escalate (not enough context) → MCP enriches pack → returns updated pack
    ↓
MCP validates PlanGraph:
    - Rejects with reasons → agent fixes and resubmits (state stays PLANNING)
    - Accepts → state becomes PLAN_ACCEPTED, mutation verbs unlock
    ↓
Agent/sub-agents execute PlanGraph nodes:
    - apply_code_patch, run_sandboxed_code, execute_gated_side_effect, run_automation_recipe
    - All scoped to contextPack files
    - Each response includes progress: { totalNodes, completedNodes, remainingNodes, pendingValidations }
    ↓
All validation nodes pass → agent calls signal_task_complete
    - MCP verifies all nodes complete; rejects if remainingNodes > 0
    - State becomes COMPLETED
    ↓
Agent presents results to human (agent just stops, no formal MCP freeze)
    ↓
Memory retrospective: candidates surfaced for human approval/rejection
```

---

## 2. State Machine

```
                                    ┌─────────────────┐
                                    │  UNINITIALIZED   │
                                    │  (1 verb only)   │
                                    └────────┬────────┘
                                             │ initialize_work
                                             ▼
                      ┌──────────── ┌─────────────────┐
                      │             │    PLANNING      │
                      │   escalate  │  (pack-scoped    │
                      │  (enriches  │   read + plan)   │
                      │    pack)    └────────┬────────┘
                      └─────────────┐       │ submit_execution_plan
                                    │       ▼
                                    │ ┌─────────────────┐
                          rejected ─┤ │  PLAN_ACCEPTED   │
                          (back to  │ │  (mutations      │
                           PLANNING)│ │   unlocked)      │
                                    │ └────────┬────────┘
                                    │          │ all validations pass
                                    │          ▼
                                    │ ┌─────────────────┐
                                    │ │   COMPLETED      │
                                    │ │  (frozen)        │
                                    │ └─────────────────┘
                                    │
                                    │ budget exceeded (any state)
                                    │          ▼
                                    │ ┌─────────────────┐
                                    └─│ BLOCKED_BUDGET   │
                                      └─────────────────┘
```

### State Definitions

| State | Meaning |
|-------|---------|
| `UNINITIALIZED` | Session not started. Only `initialize_work` is available. |
| `PLANNING` | ContextPack built. Agent can read (pack-scoped), plan, escalate. |
| `PLAN_ACCEPTED` | Plan validated and accepted. Mutation verbs unlocked. All still pack-scoped. |
| `COMPLETED` | All validation nodes passed. `signal_task_complete` accepted. |
| `BLOCKED_BUDGET` | Token budget exceeded. Only budget-safe verbs. |
| `FAILED` | Terminal failure. Only `signal_task_complete`. |

---

## 3. Verb Table

### Available Verbs by State

| State | Verbs |
|-------|-------|
| `UNINITIALIZED` | `initialize_work` |
| `PLANNING` | `read_file_lines`, `lookup_symbol_definition`, `trace_symbol_graph`, `search_codebase_text`, `write_scratch_file`, `submit_execution_plan`, `escalate`, `signal_task_complete` |
| `PLAN_ACCEPTED` | All PLANNING verbs + `apply_code_patch`, `run_sandboxed_code`, `execute_gated_side_effect`, `run_automation_recipe` |
| `COMPLETED` | `signal_task_complete` |
| `BLOCKED_BUDGET` | `initialize_work`, `escalate`, `signal_task_complete` |
| `FAILED` | `signal_task_complete` |

### Pack-Scoping Rule

**Every read/search/mutation verb operates only on files listed in the contextPack.** This is enforced at the handler level:

- `read_file_lines` — rejects if `filePath` is not in `contextPack.files`
- `lookup_symbol_definition` — returns only symbols from `contextPack.files`
- `trace_symbol_graph` — returns only neighbors within `contextPack.files`
- `search_codebase_text` — searches only within `contextPack.files`
- `apply_code_patch` — rejects if `targetFile` is not in `contextPack.files`
- `write_scratch_file` — writes to `{workId}/scratch/`, not the repo (no pack-scope check needed)
- `run_sandboxed_code` — executes in workID sandbox
- `execute_gated_side_effect` — requires approved commit gate (existing behavior)
- `run_automation_recipe` — scoped to pack files

### Removed Verbs (Absorbed into MCP Internals)

| Old Verb | Disposition |
|----------|-------------|
| `list_available_verbs` | **Removed.** Capabilities always in response envelope. |
| `list_scoped_files` | **Removed.** ContextPack IS the file list. |
| `list_directory_contents` | **Removed.** Pack has the files. |
| `fetch_jira_ticket` | **Absorbed into `initialize_work`.** MCP fetches if prompt/lexemes reference a ticket. |
| `fetch_api_spec` | **Absorbed into `initialize_work`.** MCP fetches if prompt/lexemes reference API. |
| `get_original_prompt` | **Removed.** Always in response envelope. |
| `write_scratch_file` | **Kept.** Writes to `{workId}/scratch/`. Low-risk artifact/note primitive for sub-agents. Not pack-scoped (writes to scratch, not repo). |
| `request_evidence_guidance` | **Replaced by `escalate`.** First-class pack enrichment. |

---

## 4. `initialize_work` — The Bootstrap Verb

### Agent Sends

```json
{
  "verb": "initialize_work",
  "originalPrompt": "Migrate the dashboard grid from adp-data-table to sdf-table",
  "args": {
    "lexemes": ["adp-data-table", "sdf-table", "dashboard", "grid", "migration"],
    "attachments": [
      { "type": "screenshot", "ref": "inline:base64:...", "caption": "Current dashboard layout" }
    ]
  }
}
```

### MCP Does (Ordered)

1. **Mint IDs** — `runSessionId`, `workId`, `agentId` (or accept incoming agentId)
2. **Create workspace** — `.ai/tmp/work/{workId}/`
3. **Ingest side channels (BEFORE querying memories)**
   - Human override files from `.ai/memory/overrides/` → create memory records, rename `.processed`
   - Inbox files from `.ai/inbox/` (if present)
   - Attachment metadata from `args.attachments[]` → store as session artifacts
4. **Query active memories** (now includes just-ingested overrides)
5. **Compute base ContextSignature** from prompt + lexemes (cheap, no graph I/O)
6. **Build contextPack**
   - Retrieval lanes: lexical, symbol, policy, artifact, episodic memory
   - Proof chains: if ContextSignature signals ag-Grid or federation
   - Jira fetch: if prompt/lexemes match a ticket key pattern
   - Swagger fetch: if prompt/lexemes reference API endpoints
   - Day-0 seed facts: domain anchors, symbol definitions, component usage facts, SDF contracts
   - Active memories for in-scope domain anchors
7. **Apply overrides to strategy** — `strategy_signal` memories override ContextSignature features
8. **Compute final strategy** (AFTER overrides)
9. **Compute enforcement bundle** — active `plan_rule` memories + graph policy rules → determines what validators will be applied at plan submission
10. **Determine planGraphSchema augmentations** — based on what was retrieved:
    - Which validators are active
    - What node kinds are expected
    - What evidence policy applies
    - What required policyRefs must be cited
11. **Write pack to disk** — `.ai/tmp/work/{workId}/context-pack.json`
12. **Compute SHA-256 hash**

### MCP Responds

```json
{
  "runSessionId": "run-abc123",
  "workId": "work-def456",
  "agentId": "agent-ghi789",
  "state": "PLANNING",
  "contextPack": {
    "ref": ".ai/tmp/work/work-def456/context-pack.json",
    "hash": "sha256:...",
    "files": [
      "src/app/dashboard/dashboard.component.ts",
      "src/app/dashboard/dashboard.component.html",
      "src/app/shared/ui/data-table/data-table.component.ts"
    ],
    "symbols": [
      { "name": "DashboardComponent", "kind": "class", "file": "src/app/dashboard/dashboard.component.ts" },
      { "name": "adp-data-table", "kind": "component_usage", "file": "src/app/dashboard/dashboard.component.html" }
    ],
    "policies": [
      { "id": "no_adp", "type": "hard", "rule": "No new adp-* component usage" }
    ],
    "memories": [
      { "id": "mem-001", "enforcementType": "few_shot", "summary": "adp-data-table → sdf-table migration pattern" }
    ],
    "attachments": [
      { "ref": ".ai/tmp/work/work-def456/attachments/screenshot-001.png", "caption": "Current dashboard layout" }
    ]
  },
  "planGraphSchema": {
    "validators": ["evidence_policy", "migration_rule_citation", "component_contract_check"],
    "expectedNodeKinds": ["change", "validate", "escalate", "side_effect"],
    "requiredFields": {
      "change": ["nodeId", "operation", "targetFile", "editIntent", "citations", "codeEvidence"],
      "validate": ["nodeId", "verificationHooks", "mapsToNodeIds", "successCriteria"]
    },
    "evidencePolicy": {
      "minRequirementSources": 1,
      "minCodeEvidenceSources": 1,
      "minDistinctSources": 2,
      "allowSingleSourceWithGuard": true
    },
    "enforcementObligations": [
      "Plans performing migration changes MUST cite the corresponding MigrationRule in policyRefs",
      "Plans referencing attachments MUST include artifactRefs for those attachments"
    ]
  },
  "strategy": {
    "strategyId": "migration_adp_to_sdf",
    "approach": "Inventory all adp-* usage in scope files, match to MigrationRules, generate change nodes per occurrence with validation nodes per component boundary",
    "escalationGuidance": "If a component has no MigrationRule (status=unknown), escalate with type=artifact_fetch requesting the SDF contract for that component",
    "suggestedSplits": ["inventory-scan", "migration-per-component", "validation-suite"]
  },
  "capabilities": ["read_file_lines", "lookup_symbol_definition", "trace_symbol_graph", "search_codebase_text", "submit_execution_plan", "escalate", "signal_task_complete"],
  "verbDescriptions": { "...": "..." },
  "progress": { "totalNodes": 0, "completedNodes": 0, "remainingNodes": 0, "pendingValidations": [] },
  "budgetStatus": { "maxTokens": 100000, "usedTokens": 250, "thresholdTokens": 60000, "blocked": false },
  "traceRef": "trace-xyz",
  "schemaVersion": "2.0.0",
  "subAgentHints": {
    "recommended": true,
    "suggestedSplits": ["inventory-scan", "migration-per-component", "validation-suite"]
  }
}
```

---

## 5. `escalate` — Pack Enrichment

### Purpose

Agent needs context beyond what MCP provided on init. Instead of reading files directly, the agent asks MCP to look things up and add them to the pack.

### Agent Sends

```json
{
  "verb": "escalate",
  "workId": "work-def456",
  "agentId": "agent-ghi789",
  "args": {
    "need": "I need the SDF contract for sdf-table and the routing config for /dashboard",
    "type": "artifact_fetch",
    "requestedEvidence": [
      { "type": "artifact_fetch", "detail": "SDF contract for sdf-table component" },
      { "type": "scope_expand", "detail": "Routing config files that reference /dashboard" }
    ]
  }
}
```

### MCP Does

1. Takes the need + requestedEvidence
2. Searches index/graph for matching files, symbols, contracts
3. **Adds found items to contextPack** (monotonic growth — pack never shrinks)
4. Possibly re-augments planGraphSchema if new validators become relevant
5. Updates pack on disk, recomputes hash

### MCP Responds

Returns a delta: new files added, new symbols found, updated schema, updated hash. Same response envelope shape as `initialize_work` but with `state: "PLANNING"` preserved.

The pack grows. The agent's world gets bigger. But it never includes anything MCP didn't explicitly add.

---

## 6. WorkID / AgentID Model

### WorkID — Permission Key

- Scopes access to `.ai/tmp/work/{workId}/`
- All sub-agents share the same workID
- The contextPack, planGraph, scratch files, and artifacts all live under this bucket
- An agent arriving with a valid workID but no agentID → MCP knows it's a new sub-agent

### AgentID — Tracking

- Assigned by MCP on first contact (or accepted from agent if provided)
- Multiple agentIDs can operate under one workID
- Each agentID gets its own session state entry for tracking (action counts, rejections, budget)
- `copilot-instructions.md` tells all agents: "always pass agentID if present"

### Session Key

- Sessions are keyed by `runSessionId:workId` (the collision scope)
- Agent-level tracking by `runSessionId:workId:agentId`
- Sub-agents inherit the session's contextPack, planGraph, and state — they operate within the same permission bucket

---

## 7. PlanGraph Schema (What MCP Returns)

MCP does NOT pre-fill the PlanGraph. It returns:

1. **The schema shape** — what node kinds exist, what fields are required per kind
2. **The active validators** — what checks will be applied at submission
3. **The enforcement obligations** — what policyRefs must be cited, what evidence minimums apply
4. **The strategy** — how the agent should approach building the plan
5. **Sub-agent split recommendations** — how to decompose the work

The agent builds the PlanGraph from scratch, conforming to this schema. The strategy guides the approach. The obligations tell the agent what the validator will reject.

---

## 8. Progress Tracking

Every `TurnResponse` includes:

```json
{
  "progress": {
    "totalNodes": 12,
    "completedNodes": 7,
    "remainingNodes": 5,
    "pendingValidations": [
      { "nodeId": "validate-login-redirect", "status": "not_started" },
      { "nodeId": "validate-auth-guard", "status": "not_started" }
    ]
  }
}
```

### Completion Rules

- `signal_task_complete` is rejected if `remainingNodes > 0`
- A node is "completed" when its patch/execution succeeds AND all validation nodes that map to it have passed
- The host agent can see at a glance what's left and delegate remaining work to sub-agents

---

## 9. Day-0 Seed Data (What MCP Has Before Any Agent Calls)

### 9.1 Domain Anchors (Existing)

Auto-seeded from folder structure (up to 3 levels deep). Provides join keys for everything else: memories, policies, scoping.

### 9.2 Symbol Ingestion (TS Facts)

Persist high-signal symbol facts only:

- `SymbolDefinition` (name, kind, file path) — interfaces, types, DTOs, UI model types
- Route/module boundaries
- Key service APIs used by UI
- Optional `SymbolRef` edges (import/reference relationships) for proof chains

**Do NOT dump every AST node.** Keep it to stable "headers" that enable deterministic plan generation ("here are the existing interface shapes to mirror").

### 9.3 Template Ingestion (Angular Template AST → Usage Facts)

Extract component usage facts from template AST:

- Every `adp-*` tag used (inventory)
- Every `sdf-*` tag used (inventory)
- Per-occurrence `UsageExample` facts:
  - File path + line range
  - Tag name
  - Attribute/binding summary (compressed)
  - Domain anchor id (scope)
  - Optional co-occurrence summary (what else is nearby)

**Why:** Enables "choose correct component without vibes" and grounds Waypoint prose in real usage.

### 9.4 SDF Contract Ingestion (`components.d.ts`)

From Waypoint's `components.d.ts`:

- `Component(tag)`
- `Prop(name, typeText, required?)` edges
- `Event/slot` if needed later

**Why:** Answers legality and prevents the planner from inventing props.

---

## 10. Waypoint/Prose → Enforceable Policies

### 10.1 Policy Node Types

| Node Type | Purpose |
|-----------|---------|
| `UIIntent` | Categorical intent: `tabular_view`, `modal_confirm`, `wizard_flow`, `form_entry`, etc. |
| `ComponentIntent` | When/when-not for each SDF component |
| `MacroConstraint` | "If page contains X, don't do Y" |

### 10.2 Grounding Rule

A policy derived from prose (skills.md, markdown docs) becomes enforceable ONLY when it is grounded by at least one `UsageExample` in the repo **in the same domain/scope**.

- **Grounded** → can hard-deny plans
- **Ungrounded** → included in pack as advisory only, cannot deny

**Why:** Prevents importing "markdown vibes" as truth.

---

## 11. ADP → SDF Migration System

### 11.1 Day-0: Inventory

From template usage ingestion:
- Create `Component(tag=adp-*)` facts
- Attach all `UsageExample`s to domain anchors
- Immediate answer to "where is ADP still used" + local pattern discovery

### 11.2 MigrationRule Policy Objects

```json
{
  "kind": "node",
  "labels": ["MigrationRule"],
  "properties": {
    "fromTag": "adp-alert",
    "toTag": "sdf-alert",
    "status": "approved|candidate|unknown|no_analog",
    "propMappings": { "type": "severity", "message": "children" },
    "requiredWrappers": [],
    "constraints": []
  }
}
```

Statuses:
- `approved` — vetted, can be used in plans without escalation
- `candidate` — proposed, plan must include low-evidence guard
- `unknown` — no mapping known, plan must include `escalate` node
- `no_analog` — confirmed no SDF equivalent, plan must use custom wrapper or explicit fallback policy

### 11.3 Enforcement at Plan Submission

- Migration change nodes MUST cite the corresponding `MigrationRule` in `policyRefs`
- If `MigrationRule.status != approved`, the plan MUST include an `escalate` node or explicit `lowEvidenceGuard + requiresHumanReview`
- Unknown ADP mappings MUST NOT block all migration work — force escalation or fallback, don't halt

---

## 12. Attachments (First-Class Artifacts)

### Ingestion Lanes

1. **`.ai/inbox/`** — drop files, always ingested at `initialize_work`
2. **`args.attachments[]`** — agent pass-through from user (best effort)

### Pack Integration

```json
{
  "contextPack": {
    "attachments": [
      {
        "ref": ".ai/tmp/work/{workId}/attachments/screenshot-001.png",
        "type": "screenshot",
        "caption": "Current dashboard layout",
        "artifactId": "att-001"
      }
    ]
  }
}
```

### Enforcement

- If a plan cites requirements derived from attachments, it MUST include `artifactRefs` for those attachments
- Plan validator denies if attachment-derived citations lack artifactRefs

---

## 13. Strategy Selection (Fixed Order)

### Current Problem

Strategy is computed BEFORE retrieval/graph/memory influences. This means overrides can't affect strategy.

### Fixed Order

1. **Base ContextSignature** — computed from prompt + lexemes + Jira fields (cheap, no graph I/O)
2. **Override layer** — `strategy_signal` memory records override ContextSignature features
3. **Graph policy signals** — graph-derived policy signals (e.g., `no_adp` policy presence → force migration strategy)
4. **Final strategy** — computed from the overridden ContextSignature

### Decision Table (Unchanged, But Applied to Overridden Signature)

| Priority | Condition | Strategy |
|----------|-----------|----------|
| 1 | `migration_adp_present` | `migration_adp_to_sdf` |
| 2 | `task_type_guess === "debug"` | `debug_symptom_trace` |
| 3 | `has_swagger \|\| task_type_guess === "api_contract"` | `api_contract_feature` |
| 4 | default | `ui_aggrid_feature` |

---

## 14. Plan Validation — Enforcement Bundle

### Current Mechanism (Preserved)

`validatePlanGraph(plan, activeMemories)` checks:
- Structural validity (no cycles, no duplicate nodeIds, all deps resolve)
- Per-kind field requirements
- Evidence policy (min sources, distinct source check)
- Memory-carried `plan_rule` enforcement

### New: Graph Policy Enforcement

At plan submission, MCP computes an `enforcementBundle`:

```typescript
interface EnforcementBundle {
  activeMemories: MemoryRecord[];        // existing
  graphPolicyRules: GraphPolicyRule[];    // NEW — derived from Neo4j
  migrationRules: MigrationRule[];       // NEW — from seed/graph
  componentContracts: ComponentContract[]; // NEW — from SDF ingestion
}
```

The validator checks the plan against all of these. Graph policy rules follow the same pattern as memory `plan_rule`s: each rule specifies required steps, and unsatisfied rules inject deny codes.

**Design choice:** Graph policies are converted to the same shape as `plan_rule` memories and passed into the existing `validateMemoryRules()` function. This reuses the enforcement pipeline without new validator plumbing. They are NOT persisted as memory records — they are ephemeral, derived fresh from the graph at submission time.

---

## 15. Gotchas to Guard Against

| # | Gotcha | Guard |
|---|--------|-------|
| 1 | Pack built too late | Fixed: pack built at `initialize_work`, not `submit_execution_plan` |
| 2 | Strategy decided before overrides | Fixed: strategy computed AFTER override layer |
| 3 | Override ingestion ordering | Fixed: ingest overrides BEFORE querying memories |
| 4 | GraphOps drop-and-reseed with huge facts | Don't dump every AST node. Persist compressed symbol headers only. Separate facts sync from policy sync if volume grows. |
| 5 | Competing patterns in federated repo | Scope everything by DomainAnchor. Never use global exemplars when local ones exist. |
| 6 | Unknown ADP mappings | Must not block all migration work. Force escalation or explicit no-analog fallback. |
| 7 | Template AST parsing failures | Treat as "pack insufficient" for that scope and require escalation. Don't silently proceed. |
| 8 | Agent forms mental model outside pack | Impossible — agent never sees files not in pack. Read/search verbs enforce pack intersection. |
| 9 | Sub-agent arrives without agentID | MCP assigns one, tracks as new sub-agent under same workID. |
| 10 | `signal_task_complete` called with work remaining | MCP checks progress; rejects if `remainingNodes > 0`. |

---

## 16. Implementation Phases

### Phase 1: Lifecycle Inversion (Biggest Win)

- [x] Add `initialize_work` verb + handler
- [x] Move contextPack building from `submit_execution_plan` to `initialize_work`
- [x] Fix override ingestion order (ingest → query → assemble)
- [x] Fix strategy order (base → overrides → final)
- [x] Update `capabilityMatrix.ts`: `UNINITIALIZED` → only `initialize_work`
- [x] Add pack-scoping filter to all read handlers
- [x] Update `handler.ts` tool schema
- [x] Update `constants.ts` verb lists

### Phase 2: Escalate Verb

- [x] Add `escalate` verb + handler (replaces `request_evidence_guidance`)
- [x] Implement monotonic pack growth (add files/symbols, never remove)
- [x] Pack re-hash on escalation
- [x] Optional planGraphSchema re-augmentation on escalation

### Phase 3: Progress Tracking

- [x] Add `progress` field to `TurnResponse`
- [x] Track node completion state in session
- [x] Gate `signal_task_complete` on `remainingNodes === 0`
- [x] Return `pendingValidations` list in every response

### Phase 4: Day-0 Seed Expansion

- [x] Symbol ingestion (high-signal TS facts → graph)
- [x] Template ingestion (component usage facts → graph)
- [x] SDF contract ingestion (`components.d.ts` → graph)
- [x] MigrationRule seed data

### Phase 5: Policy Grounding + Enforcement Bundle

- [x] `UIIntent`, `ComponentIntent`, `MacroConstraint` policy node types
- [x] Grounding check (prose policy → requires UsageExample to enforce)
- [x] Enforcement bundle computation at plan submission
- [x] Graph policy → plan_rule shape conversion for validator reuse

### Phase 6: Attachments

- [x] `.ai/inbox/` ingestion at `initialize_work`
- [x] `args.attachments[]` pass-through
- [x] Attachment artifactRef enforcement in plan validator

### Phase 7: AgentID / Sub-Agent Tracking

- [x] Auto-assign agentID for new sub-agents
- [x] Shared contextPack/planGraph across agentIDs within same workID
- [x] Per-agentID tracking (action counts, rejections, budget slices)
- [x] Update `copilot-instructions.md` with agentID guidance

---

## 17. What Stays Unchanged

These systems are architecturally sound and carry forward as-is:

- **Proof chains** (ag-Grid origin, federation) — invoked during `initialize_work` instead of `submit_execution_plan`
- **Memory system** — friction-triggered creation, auto-promotion, human overrides, few-shot injection
- **Collision guard** — per-session file/symbol reservation during mutations
- **Patch execution** — `replace_text` and `ast_codemod` (4 built-in codemods + custom registry)
- **Neo4j graph** — seed data, constraints, sync/export
- **Config layering** — `base.json` → `repo.json` → `env.local.json` → env vars → `schema.json` validation
- **EventStore / observability** — structured event logging, SSE, dashboard
- **Budget accounting** — token estimation, threshold gating
- **NDJSON stdio transport** — JSON-RPC 2.0, single tool `controller_turn`

---

## 18. File Changes Summary

| File | Change |
|------|--------|
| `contracts/controller.ts` | Add `UNINITIALIZED` to `RunState`. Add `progress` to `TurnResponse`. |
| `shared/constants.ts` | New verb lists for `UNINITIALIZED` state. Remove deleted verbs. |
| `shared/verbCatalog.ts` | Add `initialize_work`, `escalate`. Remove retired verbs. |
| `domains/capability-gating/capabilityMatrix.ts` | Add `UNINITIALIZED` state mapping. Update all state mappings. |
| `domains/controller/turnController.ts` | Move context pack build to `initialize_work`. Add pack-scope enforcement. Add progress tracking. |
| `domains/controller/session.ts` | Add `contextPack` and `planGraphProgress` to `SessionState`. |
| `domains/controller/types.ts` | Update `SessionState` type. |
| `domains/controller/handlers/` | Add `initializeWorkHandler.ts`. Modify `escalateHandler.ts`. Add pack-scope filter to all read handlers. Gate `signal_task_complete` on progress. |
| `mcp/handler.ts` | Update tool input schema (unchanged structure, verb is still required). |
| `mcp/stdioServer.ts` | No changes (transport is verb-agnostic). |
| `domains/context-pack/contextPackService.ts` | Add incremental pack growth support for `escalate`. |
| `domains/strategy/strategySelector.ts` | Split into base → override → final computation. |
| `domains/plan-graph/planGraphValidator.ts` | Accept `enforcementBundle` parameter. |
