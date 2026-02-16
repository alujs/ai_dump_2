# Connectors Domain

## Purpose

Defines connector adapter boundary for Jira and Swagger ingestion while using shared kernel primitives.

## How to extend

- Add adapter per provider under this domain.
- Keep adapter-specific shape handling isolated.
- Route retries/cache/tracing through shared infrastructure hooks.

## Gotchas

- Do not leak auth values into traces.
- Do not add unsupported auth methods in v1 for Jira (PAT-only).

## Invariants

- v1 connectors are Jira and Swagger only.
- Adapter outputs must be normalized artifact refs.
