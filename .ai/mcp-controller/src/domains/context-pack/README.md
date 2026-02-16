# Context Pack Domain

## Purpose

Creates context pack artifacts, persists original prompt verbatim, and detects pack insufficiency early.
Applies deterministic query normalization and retrieval reranking with explicit reasons.

## How to extend

- Add new anchor checks in `evaluateMissingAnchors`.
- Add new escalation action types only with explicit contract support.
- Keep context payload minimal and high signal.
- Keep reranking deterministic (stable tie-breakers) and explainable (reason strings).

## Gotchas

- Do not silently skip missing required anchors.
- Keep proof-chain checks explicit for ag-grid and federation tasks.
- Alias expansion is suggestion-only and can be suppressed by negative aliases.

## Invariants

- `original_prompt.txt` is written as verbatim text.
- Context pack hash matches written payload.
- Missing anchors produce typed insufficiency output.
- Retrieval decisions include deterministic rerank output and reason traces.
