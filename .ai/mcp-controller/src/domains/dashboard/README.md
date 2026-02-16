# Dashboard Domain

## Purpose

Hosts local HTTP dashboard APIs and SSE event stream for run/worktree/error visibility.

## How to extend

- Add new read-only endpoints for additional telemetry views.
- Keep `/turn` thin and delegate all logic to controller domain.
- Keep SSE payloads sourced from observability events.

## Gotchas

- Avoid long-running endpoint handlers.
- Keep dashboard local-only by default.

## Invariants

- Default port remains `8722` unless overridden by env.
- SSE endpoint streams append-only observability events.
