# Evidence Policy Domain

## Purpose

Enforces non-gameable evidence minimums and category coverage for PlanGraph nodes.

## How to extend

- Keep evidence category rules explicit and deterministic.
- Add policy knobs via typed config fields only.
- Add tests for every new rejection rule.

## Gotchas

- Distinct source checks must not double-count the same artifact.
- Feature work requires both requirement and code evidence lanes.

## Invariants

- Coverage checks are category-aware.
- Single-source path requires low-evidence guard fields.
