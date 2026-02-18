# Memory System — How-To Guide

## What Is It?

The memory system lets the MCP controller **learn from friction** — repeated rejections,
scaffolded patterns, and human-supplied corrections — and **enforce that knowledge** on
future sessions. Memories are dimensional records tied to domain anchors (folders) and
enforced through four mechanisms:

| Enforcement Type   | What It Does |
|--------------------|-------------|
| `few_shot`         | Injects before/after code examples into `trace_symbol_graph` results |
| `plan_rule`        | Adds required steps or deny conditions to plan validation |
| `strategy_signal`  | Overrides strategy feature flags for specific domains |
| `informational`    | Surfaced in context packs but not enforced |

## Memory Lifecycle

```
pending → provisional → approved → retired
                ↑
          human override (skip to approved)
```

- **Pending**: Auto-created from rejection friction. Waits for contest window.
- **Provisional**: Auto-promoted after contest window. Enforced but can be rejected.
- **Approved**: Human-approved or auto-promoted (for safe types). Fully enforced.
- **Retired**: Soft-deleted. No longer enforced.
- **Rejected**: Human-rejected. Will not be promoted.

---

## Creating Memories (3 Ways)

### 1. Automatic (Friction-Based)

When the same rejection code hits `rejectionThreshold` (default: 3) times in a session,
a memory candidate is auto-created with scaffolded few-shot data (before pattern filled in,
`after` and `whyWrong` left blank for human review).

**No action required** — this happens automatically. Check `.ai/memory/records.json` for
pending candidates after sessions with rejections.

### 2. Human Override (File Drop)

Drop a `.json` file in `.ai/memory/overrides/`. The controller picks it up on the
next `initialize_work` call and renames it to `.processed`.

**Every override file must have:**

```json
{
  "enforcementType": "few_shot | plan_rule | strategy_signal | informational",
  "trigger": "human_override",
  "phase": "approved",
  "domainAnchorIds": ["anchor:src/app/some-folder"],
  "note": "Why this memory exists"
}
```

Plus one of the enforcement-specific payloads below.

### 3. Signal Task Complete

When calling `signal_task_complete`, the retrospective handler reviews all friction data
and scaffolds new memory candidates from high-frequency rejection patterns.

---

## Override Schemas (Copy-Paste Ready)

### few_shot — "Do it this way, not that way"

```json
{
  "enforcementType": "few_shot",
  "trigger": "human_override",
  "phase": "approved",
  "domainAnchorIds": ["anchor:src/services"],
  "fewShot": {
    "instruction": "Always null-check API response fields before destructuring",
    "before": "const { data } = response;",
    "after": "const { data } = response ?? {};",
    "antiPattern": "Destructuring without null check",
    "whyWrong": "API can return null on 204/404, causing runtime crash"
  },
  "note": "Learned from repeated API handler failures"
}
```

### plan_rule — "Block plans that don't do X"

```json
{
  "enforcementType": "plan_rule",
  "trigger": "human_override",
  "phase": "approved",
  "domainAnchorIds": ["anchor:src/app/balances"],
  "planRule": {
    "condition": "changes to balance components must include spec updates",
    "denyCode": "PLAN_MISSING_TEST_COVERAGE",
    "requiredSteps": [
      { "kind": "validate", "targetPattern": "*.spec.ts" }
    ]
  },
  "note": "Balances module has fragile calculations — require tests"
}
```

### strategy_signal — "Override strategy flags for this domain"

```json
{
  "enforcementType": "strategy_signal",
  "trigger": "human_override",
  "phase": "approved",
  "domainAnchorIds": ["anchor:src/app/shared"],
  "strategySignal": {
    "featureFlags": {
      "allowAdpComponents": false,
      "requireSdfReplacement": true
    }
  },
  "note": "Shared module fully migrated to SDF — block ADP usage"
}
```

### informational — "Just surface this context"

```json
{
  "enforcementType": "informational",
  "trigger": "human_override",
  "phase": "approved",
  "domainAnchorIds": ["anchor:src/app/legacy"],
  "fewShot": {
    "instruction": "This module is scheduled for deprecation in Q3. Avoid adding new features.",
    "before": "",
    "after": "",
    "antiPattern": "",
    "whyWrong": ""
  },
  "note": "PM decision — legacy module sunset"
}
```

---

## Background Agents for Memory Mining

Background agents are the most powerful way to scale memory creation. Instead of waiting
for friction (slow) or hand-writing overrides (tedious), you run an agent that **scans
the codebase and writes override files**.

### Why this works

1. Agent creates `.json` files in `.ai/memory/overrides/`
2. On the next `initialize_work` call, the controller ingests them
3. Memories are immediately active (phase: `approved` for overrides)
4. No manual review needed if the agent sets `phase: "approved"`

### Example: Dual-library detector

Run this as a Copilot Chat prompt in agent mode:

```
Scan all files matching src/**/*.component.ts. For each component that imports
from BOTH @ADP (or adp-) and @SDF (or sdf-) packages, create a JSON file in
.ai/memory/overrides/ with this exact structure:

{
  "enforcementType": "informational",
  "trigger": "human_override",
  "phase": "approved",
  "domainAnchorIds": ["anchor:<folder-path-of-component>"],
  "fewShot": {
    "instruction": "This component uses both ADP and SDF — migration candidate",
    "before": "<current import lines>",
    "after": "<what cleaned-up SDF-only imports should look like>",
    "antiPattern": "Mixing ADP and SDF imports in same component",
    "whyWrong": "Dual-library components are fragile and block ADP removal"
  },
  "note": "Auto-mined by background agent"
}

Name each file: dual-lib-<ComponentName>.json
```

### Example: Route test coverage audit

```
Query the codebase for all route definition files (*.routes.ts, app.config.ts).
For each route that loads a component, check if a corresponding .spec.ts file exists.
For routes missing test coverage, create a JSON file in .ai/memory/overrides/:

{
  "enforcementType": "plan_rule",
  "trigger": "human_override",
  "phase": "approved",
  "domainAnchorIds": ["anchor:<route-folder>"],
  "planRule": {
    "condition": "changes to this route must include spec updates",
    "denyCode": "PLAN_MISSING_TEST_COVERAGE",
    "requiredSteps": [{"kind": "validate", "targetPattern": "*.spec.ts"}]
  },
  "note": "Route <path> has no test coverage"
}

Name each file: route-coverage-<routePath>.json
```

### Example: Deprecated API usage scanner

```
Search for all usages of HttpModule (not HttpClientModule) across the codebase.
For each file still using the deprecated HttpModule, create an override:

{
  "enforcementType": "few_shot",
  "trigger": "human_override",
  "phase": "approved",
  "domainAnchorIds": ["anchor:<folder>"],
  "fewShot": {
    "instruction": "Replace HttpModule with HttpClientModule",
    "before": "import { HttpModule } from '@angular/http';",
    "after": "import { HttpClientModule } from '@angular/common/http';",
    "antiPattern": "Using deprecated @angular/http",
    "whyWrong": "@angular/http was removed in Angular 6"
  },
  "note": "Auto-mined deprecated API usage"
}
```

### Tips for mining agents

- **Always set `"trigger": "human_override"` and `"phase": "approved"`** — this ensures immediate activation
- **Use specific `domainAnchorIds`** — `["anchor:src/app"]` is too broad, `["anchor:src/app/balances"]` is good
- **Name files descriptively** — they get renamed to `.processed` but the names help with debugging
- **Run mining agents periodically** — as the codebase evolves, re-mine to update memories
- **The controller deduplicates** — if a memory with the same anchor + enforcement already exists, it won't create a duplicate

---

## Configuration

Edit `.ai/mcp-controller/src/domains/memory/config.ts`:

| Setting | Default | Purpose |
|---------|---------|---------|
| `rejectionThreshold` | 3 | Rejections before auto-creating memory |
| `contestWindowHours` | 48 | Hours pending memories wait before promotion |
| `enableFewShotInjection` | true | Inject few-shots in trace_symbol_graph |
| `enablePlanRuleMutation` | true | Enforce plan rules from memories |
| `anchorAutoSeedMaxDepth` | 3 | Folder depth for domain anchor scanning |

## Domain Anchors

Domain anchors are auto-seeded from folder structure by `npm run ai:setup`.
Each folder becomes an anchor node in Neo4j. Memories are connected to anchors
via `domainAnchorIds`. When querying for active memories, the system resolves
file paths to their most specific anchor and expands up the hierarchy.

Example: A memory on `anchor:src/services` applies to all files under `src/services/`.

Anchors are also created for route families — if a route maps to a folder, the
route's `IN_ANCHOR` edge connects it to the same domain anchor as the component files.

## Friction Ledger

Every rejection event is logged to `.ai/tmp/friction-ledger.jsonl`. Format:

```json
{"ts": "2026-02-17T...", "denyCode": "PLAN_MIGRATION_RULE_MISSING", "verb": "submit_execution_plan", "workId": "...", "agentId": "..."}
```

The ledger is the raw input for automatic memory creation. You can also analyze it
externally to find patterns the automatic system hasn't caught yet.

## Reviewing Pending Memories

After a session with rejections, check `.ai/memory/records.json`:

```bash
cat .ai/memory/records.json | python3 -m json.tool | grep -A5 '"phase": "pending"'
```

Pending memories have scaffolded `before` patterns but empty `after` and `whyWrong`.
To approve and complete a memory:

1. Copy the pending record's fields
2. Create a new file in `.ai/memory/overrides/` with the completed fields
3. Set `"phase": "approved"` in the override
4. The controller will merge it on next session

## Files

| Path | Purpose |
|------|---------|
| `.ai/mcp-controller/src/contracts/memoryRecord.ts` | Type contracts |
| `.ai/mcp-controller/src/domains/memory/config.ts` | Configuration |
| `.ai/mcp-controller/src/domains/memory/memoryService.ts` | Core service |
| `.ai/mcp-controller/src/domains/memory/anchorSeeder.ts` | Domain anchor scanner |
| `.ai/memory/records.json` | Persisted memory records (runtime) |
| `.ai/memory/changelog.jsonl` | Memory state transitions |
| `.ai/memory/overrides/` | Human override drop folder |
| `.ai/tmp/friction-ledger.jsonl` | Friction event log |
