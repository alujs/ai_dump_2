# Controller Domain

## Purpose

Owns single-tool turn handling for `controller.turn`, ID assignment, state transitions, and command gating handoff.

## How to extend

- Add new verbs in `turnController.ts` with explicit gate checks.
- Keep response envelope stable and versioned.
- Log every decision through `EventStore`.

## Gotchas

- Do not allow mutation verbs before plan acceptance.
- Keep `originalPrompt` persistence verbatim.
- Return typed `pack_insufficient` rather than generic failure when anchors are missing.

## Invariants

- `workId` scope is enforced on file operations.
- `subAgentHints` are always present.
- Every turn produces a trace reference.
