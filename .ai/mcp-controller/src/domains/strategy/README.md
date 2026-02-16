# Strategy Domain

## Purpose

Select deterministic strategy class for a turn using prompt and lexeme evidence.

## How to extend

- Add new strategy IDs in `strategySelector.ts`.
- Add bounded heuristic branches with explicit reason and evidenceRef.
- Keep sub-agent split hints aligned with strategy IDs.

## Gotchas

- Do not return free-text reasons without evidence refs.
- Avoid non-deterministic tie logic.

## Invariants

- Selection always returns a valid strategy ID.
- Selection always returns at least one evidence-backed reason.
