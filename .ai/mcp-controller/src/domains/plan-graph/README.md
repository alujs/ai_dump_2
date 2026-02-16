# Plan Graph Domain

## Purpose

Validates PlanGraph envelope and node-kind contracts before execution.

## How to extend

- Add new rejection codes only when tied to explicit validator checks.
- Keep per-kind validation logic isolated by node type.
- Add tests for every new mandatory field.

## Gotchas

- Avoid partial checks that allow schema drift.
- Keep low-evidence guard logic explicit and auditable.

## Invariants

- Invalid plans always return deterministic rejection codes.
- `change` nodes require evidence, target scope, and verification hooks.
