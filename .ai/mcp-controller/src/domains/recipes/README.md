# Recipes Domain

## Purpose

Validates and executes recipe invocations by `recipeId + validated params` only.

## How to extend

- Add recipe definitions with explicit parameter schemas.
- Keep recipe runtime deterministic and trace-linked.
- Emit episodic usage events for every run.

## Gotchas

- Do not allow raw script injection as recipe payload.
- Missing artifact refs in usage events break replayability.

## Invariants

- Recipe execution requires a known recipe ID.
- Usage event includes artifact and validation references.
