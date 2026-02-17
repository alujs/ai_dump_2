# Memory System — How-To Guide

## What Is It?

The memory system lets the MCP controller **learn from friction** — repeated rejections,
scaffolded patterns, and human-supplied corrections — and **enforce that knowledge** on
future sessions. Memories are dimensional records tied to domain anchors (folders) and
enforced through three mechanisms:

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

## Creating Memories

### 1. Automatic (Friction-Based)
When the same rejection code hits `rejectionThreshold` (default: 3) times in a session,
a memory candidate is auto-created with scaffolded few-shot data (before pattern filled in,
`after` and `whyWrong` left blank for human review).

### 2. Human Override (File Drop)
Drop a JSON file in `.ai/memory/overrides/`:

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

The controller picks these up on the next `submit_execution_plan` call and processes them
(renames to `.processed`).

### 3. Signal Task Complete
When calling `signal_task_complete`, the retrospective handler reviews all friction data
and scaffolds new memory candidates from high-frequency rejection patterns.

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

Domain anchors are auto-seeded from folder structure. Each folder becomes an anchor node.
Memories are connected to anchors via `domainAnchorIds`. When querying for active memories,
the system resolves file paths to their most specific anchor and expands up the hierarchy.

Example: A memory on `anchor:src/services` applies to all files under `src/services/`.

## Friction Ledger

Every rejection event is logged to `.ai/tmp/friction-ledger.jsonl`. The ledger provides
raw data for the retrospective handler and can be used for external analysis.

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
