# Capability Gating Domain

## Purpose

Maps run state to allowed command capabilities.

## How to extend

- Add capabilities by state in `capabilityMatrix.ts`.
- Keep mutation permissions explicit and centralized.

## Gotchas

- Never unlock mutation commands in pre-plan states.

## Invariants

- State-to-capability mapping is deterministic.
- Mutation permission is gated by plan acceptance.
