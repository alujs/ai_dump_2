# Hook Dispatcher Contract v2

> Authoritative spec for the VS Code Copilot Agent hook runtime.
> All modules, schemas, and tooling MUST conform to this document.
> If this document and code disagree, this document wins until amended.

---

## 1. Architecture summary

One Node.js process per VS Code hook event. No per-module process spawns.

```
VS Code fires hook event
  → spawns: node .ai/hooks/dispatch.mjs <EventName>
  → dispatcher reads stdin JSON + env vars
  → constructs ctx (one state read, one capability snapshot)
  → iterates enabled modules in priority order
  → collects HookAction results
  → applies short-circuit + merge rules
  → single buffered write: state.json (idempotent), events.jsonl (append), artifacts (append)
  → writes single JSON result to stdout
  → exits 0
```

---

## 2. Entrypoint registration

One command per event in `.github/hooks.json`:

```json
{
  "hooks": {
    "SessionStart":      [{ "type": "command", "command": "node .ai/hooks/dispatch.mjs SessionStart",      "timeout": 15 }],
    "UserPromptSubmit":  [{ "type": "command", "command": "node .ai/hooks/dispatch.mjs UserPromptSubmit",  "timeout": 10 }],
    "PreToolUse":        [{ "type": "command", "command": "node .ai/hooks/dispatch.mjs PreToolUse",        "timeout": 10 }],
    "PostToolUse":       [{ "type": "command", "command": "node .ai/hooks/dispatch.mjs PostToolUse",       "timeout": 10 }],
    "PreCompact":        [{ "type": "command", "command": "node .ai/hooks/dispatch.mjs PreCompact",        "timeout": 10 }],
    "Stop":              [{ "type": "command", "command": "node .ai/hooks/dispatch.mjs Stop",              "timeout": 15 }],
    "SubagentStart":     [{ "type": "command", "command": "node .ai/hooks/dispatch.mjs SubagentStart",     "timeout": 10 }],
    "SubagentStop":      [{ "type": "command", "command": "node .ai/hooks/dispatch.mjs SubagentStop",      "timeout": 10 }]
  }
}
```

Windows paths: use forward slashes in JSON. Node resolves them.

---

## 3. IO protocol

### 3.1 Input

Dispatcher reads:

| Source | What |
|--------|------|
| `argv[2]` | Event name (e.g., `PreToolUse`) |
| **stdin** | JSON object per VS Code hook spec (see `hook-input.schema.json`) |
| `COPILOT_*` env vars | Optional; dispatcher may read `COPILOT_AGENT_ID` etc. if present |

### 3.2 Output

Dispatcher writes **exactly one JSON object** to **stdout** per `hook-output.schema.json`.

**Nothing else may be written to stdout or stderr.**

All diagnostic/debug output goes to:

- `.ai/tmp/dispatch.log` (dispatcher-level trace, append, best-effort)
- `.ai/tmp/<sid>/<feature>/logs/debug.log` (per-feature debug, append)
- Structured events in `events.jsonl`

### 3.3 Catastrophic failure

If the dispatcher itself crashes before producing output:

- For **PreToolUse**: VS Code treats missing/malformed output as "allow" (fail-open by VS Code spec).
- Dispatcher SHOULD attempt a last-resort `{"decision": "allow"}` write in a top-level catch.

---

## 4. Durability model: Option A (event-log authoritative)

### 4.1 Append-only logs are the source of truth

| File | Role | Concurrency safety |
|------|------|--------------------|
| `events.jsonl` | All structured events (tool calls, decisions, errors, metrics) | Append-only; safe under overlap |
| `p.jsonl` | Prompt audit entries (raw text or hash-only) | Append-only |
| `registry.jsonl` | Artifact registrations | Append-only |

### 4.2 `state.json` is a cached snapshot, not authoritative

State contains **only idempotent pointers** — fields that can be safely overwritten by any concurrent writer without losing correctness:

| Field | Type | Semantics |
|-------|------|-----------|
| `core.sessionId` | string | Set once, never changes |
| `core.workId` | string | Set-if-newer (by turnId) |
| `core.lastTurnId` | integer | Set to max(current, incoming) |
| `core.phase` | enum | Set to max ordinal (UNINITIALIZED < PLANNING < EXECUTING < COMPLETE; BLOCKED is lateral) |
| `core.lastEventOffset` | integer | Set to max (byte offset into e.jsonl, optional optimization) |
| `plan.currentPath` | string | Overwrite; last writer is fine |
| `plan.mtime` | integer | Overwrite with latest |
| `plan.hash` | string | Overwrite; derived from file |
| `cap.neo4j.enabled` | boolean | Overwrite |
| `cap.neo4j.reachable` | boolean | Overwrite |
| `cap.neo4j.schemaVersion` | string | Overwrite |
| `cap.neo4j.lastCheckTs` | integer | Set to max |
| `rlm.*` | object | Idempotent pointers only |
| `memory.*` | object | Idempotent pointers only |

**No counters.** If you need counts, derive them from `e.jsonl` at Stop or on-demand.

### 4.3 Write protocol

Dispatcher performs **one** read of `state.json` at startup and **one** write at exit:

1. Read `state.json` → `originalState`
2. Run all modules; each returns `statePatch` (JSON merge-patch, idempotent fields only)
3. Apply patches sequentially: `finalState = applyPatches(originalState, ...patches)`
4. Write `finalState` to `state.json` atomically (write to `.tmp`, rename)
5. Append buffered events to `events.jsonl`
6. Append buffered artifacts to `registry.jsonl`

If write fails (e.g., disk full), events are lost for this invocation. That's acceptable — the next invocation re-derives from the same inputs.

---

## 5. IDs and paths

### 5.1 ID formats

| ID | Format | Example | Generated by |
|----|--------|---------|--------------|
| `sessionId` (`sid`) | 8-char lowercase hex | `a3f0c812` | `session` module on SessionStart |
| `workId` (`wid`) | `w` + 3-digit zero-padded counter | `w001` | `session` module; incremented on policy trigger |
| `agentId` | `u` (user) or `a` + 2-digit counter | `u00`, `a01` | `session` module; `u00` = main agent |
| `turnId` | monotonic integer | `14` | `session` module; incremented on UserPromptSubmit |
| `hookRunId` | `<eventName>-<turnId>-<ms timestamp>` | `PreToolUse-14-1740700000123` | dispatcher, per invocation |

### 5.2 Directory layout

Defined in `workspace.json`. All paths resolved through `lib/paths.mjs`.

```
.ai/tmp/
├── dispatch.log                          # dispatcher trace (pre-session, always-on)
└── <sid>/
    ├── state.json                        # state snapshot (idempotent pointers)
    ├── events.jsonl                      # event log (append-only, authoritative)
    ├── registry.jsonl                    # artifact registrations
    │
    ├── session/                          # session feature
    │   └── logs/
    │       └── debug.log
    │
    ├── graph-pretooluse/                 # unbounded-guard feature
    │   └── logs/
    │       └── debug.log
    │
    ├── planGraph-exec/                   # plan graph execution guard
    │   ├── logs/
    │   │   └── debug.log
    │   └── output/
    │       └── planGraph.json            # fallback planGraph location
    │
    ├── plan-subagent-contract/           # plan subagent contract
    │   ├── logs/
    │   │   └── debug.log
    │   └── output/
    │       └── sa/
    │           └── Plan/
    │               └── <aid>/
    │                   ├── planGraph.json
    │                   └── manifest.json
    │
    ├── rlm-work/                         # RLM work orchestration
    │   ├── logs/
    │   │   └── debug.log
    │   └── output/
    │       └── sa/
    │           └── <type>/
    │               └── <aid>/
    │                   └── *.json
    │
    ├── memory-journal/                   # memory journal
    │   ├── logs/
    │   │   └── debug.log
    │   └── output/
    │       ├── experience.jsonl
    │       └── candidates.json
    │
    ├── memory-activation/                # memory activation
    │   └── logs/
    │       └── debug.log
    │
    └── stop-synth/                       # stop artifact synthesis
        ├── logs/
        │   └── debug.log
        └── output/
            ├── summary.md
            └── adr/
                └── *.md
```

**Windows path budget:** `.ai/tmp/a3f0c812/plan-subagent-contract/output/sa/Plan/a01/planGraph.json` = 72 chars from repo root. With a repo at `C:\Users\WowSi\ai_dump_2\` (~28 chars) = ~100 total. Well under 260.

---

## 6. Context object (`ctx`)

Dispatcher constructs one `ctx` per invocation. Modules receive it read-write (but only via returned patches, not direct mutation).

See `ctx.schema.json` for the full shape. Summary:

| Property | Type | Description |
|----------|------|-------------|
| `ids` | object | `{ sessionId, workId, agentId, turnId, hookRunId }` |
| `event` | object | Normalized hook input (event name, tool name/input, prompt text, transcript_path, etc.) |
| `paths` | object | All paths from `workspace.json` via `lib/paths.mjs` — `repoRoot`, `hooksRoot`, `workRoot`, `sessionRoot`, `stateFile`, `eventsFile`, `registryFile`, `configFile`, `policyFile`, `followupRulesFile`, `manifestFile`, `schemaDir`, `featureRoot(slug)`, `featureLogs(slug)`, `featureOutput(slug)`, `relRef(absPath)`, `repoRelative(absPath)` |
| `state` | object | Loaded from `state.json`; modules read this but write via `statePatch` in HookAction |
| `config` | object | Per-feature config from `config.json` — dispatcher sets `ctx.config = hookConfig[moduleName]` before each module call. Modules read filenames, dir names, and knobs from here instead of hardcoding. |
| `feature` | object | `{ root, logs, output }` — current feature's paths, set by dispatcher before each module call |
| `cap` | object | Cached capabilities: `{ neo4j: { enabled, reachable, schemaVersion, lastCheckTs } }` |
| `timers` | object | `{ startMs, budgetMs, elapsed() }` — dispatcher enforces budget |
| `log` | function | `(level, msg, data?) → void` — writes to per-feature `logs/debug.log`, never stdout |

**`ctx.state` is read-only during module execution.** Modules express writes via `statePatch` in their returned `HookAction`.

---

## 7. Module interface

Each module is an ES module exporting a default object:

```js
// .ai/hooks/features/<name>/hook.mjs
export default {
  name: 'session',                          // unique, matches manifest key
  supports: new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse',
                     'PostToolUse', 'PreCompact', 'Stop']),
  priority: 0,                              // lower = runs first
  hotPathSafe: true,                        // if false, skipped on PreToolUse
  critical: true,                           // if true, errors may fail the event

  async handle(eventName, ctx) {
    // ... module logic ...
    return {
      // All fields optional. See hook-action.schema.json
      decision: 'allow',                    // PreToolUse only: allow | ask | deny
      denyReason: undefined,                // string, required if decision=deny
      inputMetadata: undefined,             // ID/path stamps (session module only)
      updatedInput: undefined,              // semantic rewrites (one owner only)
      additionalContext: undefined,         // [{ key, value }] for events that support it
      statePatch: undefined,                // JSON merge-patch (idempotent fields only)
      emitEvents: [],                       // structured event objects → e.jsonl
      registerArtifacts: [],                // artifact records → registry.jsonl
      warnings: [],                         // human-readable strings → events + debug
      metrics: undefined,                   // { ms, counters... }
    };
  }
};
```

### 7.1 Module discovery

Dispatcher reads `dispatch.manifest.json` for the ordered list of enabled modules and their overrides. Modules are loaded via dynamic `import()` from `.ai/hooks/features/<name>/hook.mjs`. Each feature folder is self-contained and copy-pasteable.

---

## 8. Dispatch algorithm

```
function dispatch(eventName, stdinPayload):
  ctx = buildContext(eventName, stdinPayload)
  modules = loadEnabledModules(manifest, eventName)
             .filter(m => m.supports.has(eventName))
             .filter(m => eventName !== 'PreToolUse' || m.hotPathSafe)
             .sort(m => m.priority)

  results = []
  finalDecision = 'allow'

  for module in modules:
    if ctx.timers.elapsed() > ctx.timers.budgetMs:
      // budget exceeded — stop iterating, fail open
      ctx.log('warn', `Budget exceeded at module ${module.name}`)
      break

    try:
      action = await module.handle(eventName, ctx)
      results.push({ module: module.name, action })

      // Short-circuit on deny
      if action.decision === 'deny':
        finalDecision = 'deny'
        break  // stop running remaining modules

      // Escalate ask (but continue hotPathSafe modules)
      if action.decision === 'ask' and finalDecision !== 'deny':
        finalDecision = 'ask'
        break  // stop to reduce work

    catch error:
      emitErrorEvent(ctx, module.name, error)
      if module.critical:
        finalDecision = 'deny'
        break
      // non-critical: skip this module's outputs, continue

  // Merge phase
  mergedOutput = mergeResults(results, finalDecision)
  commitState(ctx, results)    // single s.json write
  appendEvents(ctx)            // single e.jsonl append
  appendArtifacts(ctx)         // single registry append

  writeStdout(mergedOutput)    // exactly one JSON object
```

### 8.1 Decision precedence

```
deny > ask > allow
```

First `deny` wins and stops the pipeline. First `ask` wins and stops the pipeline.

### 8.2 Budget enforcement

| Event | Budget | Exceeded behavior |
|-------|--------|-------------------|
| PreToolUse | 300ms | Fail open (allow), except if a critical module already denied |
| PostToolUse | 500ms | Stop iterating, commit what we have |
| SessionStart | 5000ms | Stop iterating, commit what we have |
| Stop | 5000ms | Stop iterating, commit what we have |
| All others | 1000ms | Stop iterating, commit what we have |

Budgets are configurable in `dispatch.manifest.json`.

---

## 9. Rewrite channels (two non-conflicting categories)

### 9.1 `inputMetadata` — structural stamps

Owned by: `session` module (and only `session`).

Purpose: attach IDs, compute artifact paths, set routing fields. **Never changes the meaning of the tool operation.**

Example:
```json
{
  "inputMetadata": {
    "_hookSessionId": "a3f0c812",
    "_hookWorkId": "w001",
    "_hookArtifactRoot": "a/w001"
  }
}
```

### 9.2 `updatedInput` — semantic rewrites

Owned by: one module per event, configured in manifest (`rewriteOwner` field). Default: `planGraph-exec`.

Purpose: clamp scope, add `--max-count`, change search root, block dangerous flags.

Example:
```json
{
  "updatedInput": {
    "query": "handleClick",
    "includePattern": "src/app/home/**"
  }
}
```

### 9.3 Merge rule

Dispatcher applies in order:
1. `inputMetadata` (merge into tool input as prefixed `_hook*` keys — non-colliding)
2. `updatedInput` (overwrite matching tool input keys)

If multiple modules return `updatedInput`: first writer wins, later writers are logged as warnings and ignored.

---

## 10. Module error isolation

Every `handle()` call is wrapped in try/catch by the dispatcher.

On unhandled exception:

| Module flag | Behavior |
|-------------|----------|
| `critical: true` | Emit `ERROR_MODULE_CRITICAL` event. Set `finalDecision = deny`. Stop pipeline. |
| `critical: false` | Emit `ERROR_MODULE` event (name, event, stack hash). Skip module outputs. Continue pipeline. |

For PreToolUse specifically:
- Only `session` and `graph-pretooluse` should be `critical: true`.
- All other modules are non-critical and fail-open.

---

## 11. Neo4j capability (shared utility, not a module)

No separate hook. A shared utility function:

```
neo4jCapability(ctx) → { enabled, reachable, schemaVersion, lastCheckTs }
```

Rules:
- If `ctx.state.cap.neo4j.lastCheckTs` is recent (< 5 min): return cached.
- If event is **PreToolUse**: **never** compute. Return cached or `{ enabled: false, reachable: false }`.
- Otherwise (SessionStart, Stop, PostToolUse): compute, cache to `statePatch`.

Location: `.ai/hooks/lib/neo4j-cap.mjs`

---

## 12. Lifecycle phases

### 12.1 Phase enum

```
UNINITIALIZED → PLANNING → EXECUTING → COMPLETE
                                ↕
                             BLOCKED
```

Ordinals: `UNINITIALIZED=0, PLANNING=1, EXECUTING=2, COMPLETE=3, BLOCKED=99`

### 12.2 Phase transitions

| Trigger | Transition |
|---------|-----------|
| SessionStart completes | → UNINITIALIZED (initial) |
| First UserPromptSubmit | → PLANNING |
| planGraph accepted and validated | → EXECUTING |
| All plan nodes complete + validations pass | → COMPLETE |
| Policy violation / validation failure / budget cap | → BLOCKED |
| Remediation accepted | BLOCKED → previous phase |

### 12.3 Phase enforcement (PreToolUse)

Configurable per-phase tool policy in `dispatch.manifest.json`:

```json
{
  "phasePolicy": {
    "UNINITIALIZED": { "allowTools": ["semantic_search", "read_file", "grep_search", "list_dir", "file_search"], "mode": "deny" },
    "PLANNING":      { "allowTools": ["semantic_search", "read_file", "grep_search", "list_dir", "file_search", "runSubagent"], "mode": "deny" },
    "EXECUTING":     { "allowTools": "*", "mode": "allow" },
    "COMPLETE":      { "allowTools": ["read_file", "grep_search"], "mode": "deny" },
    "BLOCKED":       { "allowTools": ["read_file"], "mode": "deny" }
  }
}
```

`mode: "deny"` = reject tools not in allowlist. Can be set to `"warn"` for adoption-speed mode.

### 12.4 Phase enforcement toggle

```json
{
  "enforcePhases": false
}
```

When false, phases are tracked in state but not enforced. Modules can still read `ctx.state.core.phase` for informational purposes.

---

## 13. `hotPathSafe` semantics

- `hotPathSafe` **only** gates execution on **PreToolUse**.
- On all non-PreToolUse events, modules run normally if `supports` includes that event.

Rule:
```
if (eventName === 'PreToolUse' && !module.hotPathSafe) → skip
else if (module.supports.has(eventName)) → run
else → skip
```

---

## 14. v1 module registry

| # | Module | Priority | hotPathSafe | critical | Events |
|---|--------|----------|-------------|----------|--------|
| 1 | `session` | 0 | true | true | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop |
| 2 | `graph-pretooluse` | 10 | true | true | PreToolUse |
| 3 | `planGraph-exec` | 20 | true | false | PreToolUse |
| 4 | `plan-subagent-contract` | 30 | false | false | SubagentStart, SubagentStop |
| 5 | `rlm-work` | 40 | true | false | PreToolUse, SubagentStart, SubagentStop |
| 6 | `memory-journal` | 50 | false | false | UserPromptSubmit, PostToolUse, Stop |
| 7 | `memory-activation` | 60 | true | false | PreToolUse, PostToolUse |
| 8 | `stop-synth` | 100 | false | false | Stop |

### 14.1 Minimal v1 enable set

```json
["session", "graph-pretooluse", "planGraph-exec"]
```

Add progressively:
1. `plan-subagent-contract` (when using plan subagents)
2. `rlm-work` (when enforcing subagent orchestration)
3. `memory-journal` + `memory-activation` (when building learning loop)
4. `stop-synth` (when you want ADR drafts)

---

## 15. Configuration files

| File | Purpose | Committed? |
|------|---------|-----------|
| `.ai/hooks/config.json` | Per-feature configuration (output filenames, subdir names, knobs) | Yes |
| `.ai/hooks/dispatch.manifest.json` | Module enable list, priorities, overrides, budgets, phase policy | Yes |
| `.ai/hooks/rlm-policy.json` | RLM tool-intent → subagent requirements | Yes |
| `.ai/hooks/followup-rules.json` | Static memory-activation followup triggers | Yes |
| `.ai/hooks/schema/*.schema.json` | All JSON schemas for validation | Yes |
| `.ai/hooks/features/*/hook.mjs` | Feature hook implementations (one folder per feature) | Yes |
| `.ai/hooks/lib/*.mjs` | Shared utilities (neo4j-cap, path helpers, etc.) | Yes |
| `.ai/hooks/dispatch.mjs` | Dispatcher entrypoint | Yes |

---

## 16. Schema inventory

| Schema file | Validates |
|-------------|-----------|
| `hook-input.schema.json` | stdin payload from VS Code |
| `hook-output.schema.json` | stdout JSON written by dispatcher |
| `ctx.schema.json` | Internal ctx object (for test harnesses) |
| `hook-action.schema.json` | HookAction returned by modules |
| `state.schema.json` | `s.json` content |
| `event-record.schema.json` | Single line in `e.jsonl` |
| `artifact-record.schema.json` | Single line in `registry.jsonl` |
| `rlm-policy.schema.json` | `.ai/hooks/rlm-policy.json` |
| `followup-rules.schema.json` | `.ai/hooks/followup-rules.json` |

---

## 17. Invariants (things that must always be true)

1. **Exactly one JSON object on stdout per invocation.** No exceptions.
2. **No module writes to stdout or stderr.** All output via `ctx.log()` or returned HookAction.
3. **State patches are idempotent.** No counters, no read-modify-write, no arrays.
4. **Event log is append-only.** No truncation, no editing.
5. **PreToolUse budget is hard.** Exceeded = stop + fail open (unless critical deny already issued).
6. **One rewrite owner per channel.** `inputMetadata` = session. `updatedInput` = manifest-configured owner.
7. **Non-critical modules cannot block tool execution.** Errors are logged and skipped.
8. **Neo4j is never checked on PreToolUse hot path.** Cached or unavailable.
9. **Short IDs only.** sessionId=8hex, workId=w###, agentId=[ua]##.
10. **All paths under `.ai/tmp/<sid>/`.** Nothing escapes the session root.
