# Graph Ops Domain

## Purpose

Owns deterministic local graph sync flow: drop, reindex, upsert seed, export deltas.

## How to extend

- Keep sync steps explicit and idempotent.
- Enforce required seed row fields for policy/recipe nodes.
- Keep import conflict policy deterministic.

## Gotchas

- Missing version metadata causes silent drift if not rejected.
- Non-deterministic merge behavior breaks team rebase flow.

## Invariants

- Sync flow is reproducible from `.ai/graph/seed`.
- Conflict tiebreak uses version, updated_at, updated_by.

## Commands

- `npm run graphops:check`
- `npm run graphops:sync`
- `npm run graphops:export`
