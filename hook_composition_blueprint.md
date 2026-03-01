# Hook-First, Plug-and-Play Agent Runtime
*A conceptual blueprint for a progressive, composable hook ecosystem (no MCP, no single “gateway”), built around shared artifacts and a minimal state contract.*

> Goal: let teams “drop in” capabilities (context pack, plan graph, memory, graph DB, harness, validators, ingestion, etc.) as independent hooks that automatically discover prerequisites and compose progressively—without requiring a central orchestrator.

---

## 1. Mental Model

### 1.1 “Hooks as runtime”
Treat VS Code Agent Hooks as the **runtime kernel**. Each hook is a self-sufficient plugin that:
- **detects** whether it should act (feature flags + prerequisites),
- **produces artifacts** (append-only, content-addressed where possible),
- **patches its own state namespace** (never stomping other hooks),
- **gates tools** (PreToolUse) to enforce invariants.

There is no “controller.” Instead, hooks coordinate via:
- **shared state file(s)**,
- **artifact index** (append-only pub/sub),
- **locks** (best-effort mutual exclusion).

### 1.2 The “bus”: artifacts, not conversations
In a hook-first runtime, “memory” and “state” are not held inside the model. They are **written**:
- `state.json` is the “variables store”
- `artifacts/index.jsonl` is the “pub/sub bus”
- `events.jsonl` is the audit trail and compaction survival mechanism
- `resume.md` is the human-readable restart capsule

This shifts you from:
- “LLM as REPL”
to
- “LLM as planner selecting operations over durable artifacts.”

### 1.3 Progressive composition
Progressive means:
- Hook A produces artifact X
- Hook B discovers X and produces artifact Y
- Hook C discovers X+Y and produces Z
- Gating becomes stricter as state progresses (pack → plan → execute → validate → complete)

No central scheduler is needed; prerequisites are discovered from the bus.

---

## 2. The Minimal Shared Contract (Required)

To get plug-and-play composition without chaos, you need **exactly one stable contract**.

### 2.1 Work root directory
All hooks agree to write under a per-work directory:

```
.ai/tmp/work/<workId>/
```

How workId is chosen is a policy; a common approach is:
- `workId = hash(sessionId + prompt)` or a monotonic counter per session
- stored in state on SessionStart or first UserPromptSubmit

### 2.2 `state.json` (namespaced)
A single JSON file containing **namespaced sections**. No hook writes outside its namespace.

Example namespaces:
- `core.*` (minimal shared fields)
- `pack.*` (context pack hook)
- `plan.*` (plan hook)
- `validators.*` (validator manifest hook)
- `memory.*` (memory hook)
- `graph.*` (neo4j hook)
- `harness.*` (composition & step registry hook)
- `tools.*` (tool gating / leases hook)
- `subagents.*` (subagent mailbox / coordination hook)

**Key principle:** state patches are additive; delete/overwrite is rare and controlled.

### 2.3 `artifacts/index.jsonl` (append-only)
A line-oriented event log that is the primary discovery mechanism for other hooks.

Each line is a record like:
- `ts`
- `workId`
- `producer` (hook name)
- `kind` (artifact type)
- `ref` (path or content-addressed pointer)
- `hash` (optional, recommended)
- `tags` (lexemes, domains, scope)
- `dependsOn` (refs/hashes)
- `summary` (short)

Append-only makes it safe for concurrency.

### 2.4 Lock directory (best-effort)
```
.ai/tmp/work/<workId>/locks/<jobKey>.lock
```
Used to prevent duplicate expensive work (e.g., multiple subagents scanning the same set).

---

## 3. Feature Flags and Opt-In/Opt-Out

### 3.1 Config files
Hooks check a shared config. Recommended pattern:
- committed defaults: `.ai/config/hooks.runtime.json`
- local overrides: `.ai/config/hooks.local.json` (gitignored)
- env overrides: `.env` or system env vars

### 3.2 Feature flags (conceptual)
Flags allow progressive adoption and safe degradation:
- `FEATURE_PACK` (context pack)
- `FEATURE_PLAN` (plan graph)
- `FEATURE_VALIDATORS` (manifest + enforcement)
- `FEATURE_MEMORY` (candidates + promotion)
- `FEATURE_GRAPH` (neo4j)
- `FEATURE_HARNESS` (steps/pipelines)
- `FEATURE_ATTACHMENTS` (inbox + pass-through)
- `FEATURE_SUBAGENTS` (mailbox + coordination)
- `FEATURE_TOOL_GATING` (deny/ask/allow)
- `FEATURE_ROUTES` (route topology facts)
- `FEATURE_COMPONENTS` (Waypoint d.ts + usage facts)
- `FEATURE_MIGRATION` (adp→sdf rules)

Each hook decides:
- noop if disabled,
- strict/lenient behavior if enabled but deps missing.

---

## 4. Core Hook Plugins (Conceptual)

Below are modular hooks. Any can be dropped in/out.

### 4.1 WorkInitHook
**Events:** SessionStart, UserPromptSubmit  
**Purpose:** ensure work root exists and `state.json` is created.

Produces:
- `state.core.workId`, `state.core.sessionId`, `state.core.phase=UNINITIALIZED`
- directory scaffolding under work root
- artifact entry: `kind=work_initialized`

### 4.2 ContextPackHook
**Events:** UserPromptSubmit (and/or PreToolUse if pack missing)  
**Purpose:** build the “world snapshot” used for planning and scoped operations.

Consumes:
- prompt text + lexemes
- attachments (if enabled)
- optional graph slice (if enabled)
- optional symbol/usage facts (if enabled)

Produces:
- `pack/contextPack.json` + `pack/hash`
- `state.pack = { hash, ref, status }`
- artifact entry: `kind=context_pack`

If insufficient:
- `pack/insufficiency.json` and `state.pack.status=INSUFFICIENT`

### 4.3 AttachmentIngestHook
**Events:** UserPromptSubmit, PreToolUse  
**Purpose:** make user-provided files visible to the system deterministically.

Two lanes:
- `.ai/inbox/` (always works)
- pass-through metadata (best effort)

Produces:
- `artifacts/attachments/*`
- artifact entries: `kind=attachment`

### 4.4 PlanGraphHook
**Events:** PreToolUse (when a tool requires a plan), PostToolUse (when plan submitted)  
**Purpose:** require, validate, and accept/deny a PlanGraph.

Consumes:
- `state.pack.hash` (plan must bind to pack)
- `plan/planGraph.json` (or tool-provided plan payload)
- active plan rules (memory/graph)

Produces:
- `plan/fingerprint`, `plan/accepted|denied`, diagnostics
- `state.plan.status`, `state.plan.fingerprint`
- artifact entry: `kind=plan_accepted|plan_denied`

### 4.5 ValidatorManifestHook (progressive)
**Events:** PostToolUse after plan accepted; PreToolUse before execution  
**Purpose:** derive validators from plan + policies.

Consumes:
- accepted plan graph
- pack contents
- policy/memory rules

Produces:
- `validators/manifest.json` + hash
- `state.validators.manifestRef/hash`
- artifact entry: `kind=validator_manifest`

### 4.6 ToolGateHook
**Events:** PreToolUse  
**Purpose:** enforce lifecycle and tool permissions deterministically.

Consumes:
- `state.core.phase`
- `state.pack.status`
- `state.plan.status`
- `validators/manifest.json` (if present)
- per-node “leases” (optional)

Produces:
- PreToolUse deny/ask/allow
- optionally injects context: “call pack builder”, “submit plan”, “run validator”, etc.

This hook is what turns “guidance” into “guarantee”.

### 4.7 HarnessHook (composition)
**Events:** PreToolUse / PostToolUse  
**Purpose:** enforce compositional code shape and run repeatable pipelines.

Conceptual outputs:
- a step registry (see §6)
- derived facts (symbols/routes/usages/policies)
- deterministic pipeline outputs used by pack and plan validation

Produces:
- `artifacts/computed/*`
- registry updates
- artifact entries: `kind=computed_*`

### 4.8 GraphHook (Neo4j optional)
**Events:** SessionStart, UserPromptSubmit  
**Purpose:** check neo4j availability, export graph slices, upsert approved memory/policies.

Consumes:
- neo4j config if present

Produces:
- `state.graph = { enabled, ok, lastCheck }`
- artifacts: `kind=graph_slice` (policies, migration rules, component stubs, anchors)
- can noop cleanly if neo4j missing

### 4.9 MemoryHook
**Events:** PostToolUse, Stop, PreCompact  
**Purpose:** generate memory candidates and promote durable knowledge.

Consumes:
- denyReasons, failures, validation results, events
- domain anchors from pack
- optional neo4j

Produces:
- `memory/candidates/*.json`
- optional: `graph/upserts/*.jsonl`
- artifact entries: `kind=memory_candidate|memory_promoted`

### 4.10 PreCompactHook
**Events:** PreCompact  
**Purpose:** prevent context loss from breaking the run.

Produces:
- `resume.md` capsule (how to rehydrate)
- `state.tools.locked=true`
- artifact entry: `kind=resume_capsule`

---

## 5. Lifecycle and State Machine (Conceptual)

The system progresses through phases:

1. **UNINITIALIZED**
   - pack not built
   - tools denied except pack builders

2. **PLANNING**
   - pack exists and is sufficient
   - plan not accepted yet
   - read-only tools permitted within pack scope

3. **EXECUTING**
   - plan accepted
   - execution tools allowed per node/manifest
   - validations run post-change

4. **COMPLETE**
   - validations pass
   - retrospective/memory candidates generated

5. **BLOCKED**
   - pack insufficient, policy violation, failed validations, budget caps
   - tools restricted until remedied

Hooks enforce these phases through ToolGateHook and manifest.

---

## 6. “Harness” as Composition (Without MCP)

### 6.1 Why a harness?
LLMs default to one-off scripts and grep. A harness forces:
- modular steps
- deterministic outputs
- reuse via artifacts and registry
- fewer tool calls and fewer “debug turns”

### 6.2 Step contract
A “step” is an operator with:
- a tag
- a typed interface (input/output)
- access to a controlled `ctx` (artifact IO, pack, state, graph)

Steps are composed into pipelines using combinators (pipe/branch/fanOut/retry/tap).

### 6.3 Registry
The registry is “grep for operations”:
- searchable by keywords (lexemes), types, domain anchor, usage count
- reranked results steer the agent toward reuse
- registry growth is controlled by promotion rules (see §10)

### 6.4 Pipelines as derived products
Pipelines exist to eliminate expensive repeated reads:
- symbol headers
- template component usage facts
- route graphs
- Waypoint policy parsing and grounding
- ADP inventory and migration candidate suggestions

Outputs are artifacts, not terminal output.

---

## 7. Anchors: Domain, Symbol, Component

Progressive composition needs join keys between:
- what the repo contains (facts)
- what rules exist (policies)
- what to do (plans/validators)

Three anchor types enable this:

1) **DomainAnchor** (`anchor:<folder>`)
   - folder-derived scope boundaries

2) **SymbolStub** (`sym:<kind>:<path>#<name>`)
   - stable headers for high-signal symbols (not full AST)

3) **ComponentStub** (`component:<tag>`)
   - `adp-*` and `sdf-*` tags become first-class entities

Policies/memories attach to anchors. Facts reference anchors. Plans cite anchor-backed evidence.

---

## 8. Day-0 Seeding (Conceptual)

The “day-0 seed” goal is to avoid spending time rediscovering basics.

Day-0 computed artifacts + graph facts typically include:
- Domain anchors (folder topology)
- High-signal symbol headers (exports/interfaces/services/routes)
- Template usage facts (`adp-*`, `sdf-*` occurrences)
- Waypoint contracts (`components.d.ts` → component props/events)
- Waypoint docs (`skills/md` → intents/constraints candidates)
- Grounding results (which policies are supported by real usage)
- Optional route topology stubs

These seed outputs become reusable artifacts (and optionally graph facts).

---

## 9. ADP→SDF Migration (Conceptual)

Migration is treated as policy + evidence:
- Facts: “ADP usage inventory” (where is `adp-*` used)
- Rules: `MigrationRule(fromTag,toTag,status)` with statuses:
  - `approved`
  - `candidate`
  - `unknown`
  - `no_analog` (requires fallback pattern)

Plan enforcement:
- if a change claims migration, it must cite the relevant mapping rule or escalate.

This avoids hallucinated conversions and supports progressive completion.

---

## 10. Registry Growth and Pruning

Yes, a registry can grow too large. The solution is tiering + promotion rules.

### 10.1 Tiers
- **Core steps**: stable, widely reused primitives
- **Domain steps**: e.g., ADP/SDF/Waypoint/routing specifics
- **Work-local steps**: transient, expire with workId

### 10.2 Promotion rules
A work-local step becomes “registry” only if:
- used successfully ≥ N times
- produces stable artifacts
- has clear interfaces and documentation
- passes typecheck and lint policy

### 10.3 Pruning
Steps not used for M days are retired automatically.
This keeps the registry actionable.

---

## 11. Subagents as Cooperative Producers

Subagents help each other by publishing artifacts, not by sharing chat context.

### 11.1 Mailbox
A mailbox is a folder + index:
- `mailbox/<agentId>/offers/*.json`
- `mailbox/<agentId>/requests/*.json`
- `mailbox/index.jsonl` (append-only)

### 11.2 Coordination
Hooks inject “new offers” into subagent contexts on SubagentStart.
Locks prevent duplicate scanning work.

This creates real cooperative parallelism without shared REPL state.

---

## 12. Tool Gating as a Lease System (Optional)

Even without MCP, you can have safe “interactive mode”:

- default: deny terminal/edit/search
- unlock: only when a plan node explicitly grants a lease (toolGateId)
- lease expires after node completes or PreCompact fires

This makes power tools safe and intentional.

---

## 13. Failure Modes and How This Architecture Prevents Them

### 13.1 “LLM wrote a hanging script”
Prevented by:
- harness runner contracts
- timeouts
- deny non-harness terminal use by default

### 13.2 “LLM re-grepped everything”
Prevented by:
- derived artifacts
- registry reranking
- gating repeated greps unless no artifacts exist

### 13.3 “Post-compaction drift”
Prevented by:
- PreCompact capsule + tool relock
- forced rehydration via pack checks

### 13.4 “Hook disabled by org policy”
Degradation behavior:
- hooks noop
- system falls back to manual operation
- artifacts remain usable

---

## 14. Putting It Together: How Work Flows

1) User submits prompt
2) WorkInitHook ensures work root & state
3) ContextPackHook builds pack (plus attachments, graph slice, computed facts)
4) ToolGateHook denies non-pack actions
5) User/agent proposes plan
6) PlanGraphHook validates and accepts/denies
7) ValidatorManifestHook derives validators
8) Execution and validation proceed, governed by manifest + gating
9) MemoryHook produces candidates and optional promotions
10) PreCompact preserves state if needed, Stop finalizes reports

---

## 15. Why This Is “Plug and Play”
A new team drops in a hook plugin and config flag:
- If prerequisites exist, it runs and publishes artifacts.
- If prerequisites missing, it noops (or denies if strict).
- Other hooks discover its outputs via the artifact bus and adapt.

No orchestrator. No hard coupling. Progressive composition is achieved by artifact contracts and namespaced state.

---

## 16. Glossary (Short)
- **Hook plugin**: a deterministic script triggered by an agent lifecycle event.
- **Artifact**: durable output file referenced by `ref` and ideally hashed.
- **Bus**: `artifacts/index.jsonl`, the append-only discovery mechanism.
- **Pack**: world snapshot; inputs and derived facts needed for planning.
- **PlanGraph**: explicit work plan; drives validator manifest.
- **Manifest**: derived validators/tool leases; enforces progressive execution.
- **Anchors**: stable join keys (domain, symbol, component).
- **Registry**: searchable index of reusable operations (steps).

---

## 17. Next Step (Conceptual)
Start with three hooks:
1) Pack (build/refresh)
2) Plan (accept/deny)
3) Gate (deny anything out of order)

Then add:
- Harness (derived facts)
- Graph (neo4j)
- Memory (candidates/promotion)
- Routes/components/policies (Waypoint + ADP)

This gets you progressive composition without building a monolith again.
