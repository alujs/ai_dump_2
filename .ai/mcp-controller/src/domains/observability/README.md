# Observability Domain

## Purpose

Appends JSONL events and broadcasts live event stream signals for dashboard and analytics.

## How to extend

- Add event fields via payload objects; preserve core identifiers.
- Keep write path append-only.
- Add event readers/aggregators outside this append path.

## Gotchas

- Do not log raw secrets or auth values.
- Do not introduce mutable event rewrites.

## Invariants

- Each event has `ts`, `type`, `runSessionId`, `workId`, `agentId`.
- Events are persisted and emitted to SSE listeners.
