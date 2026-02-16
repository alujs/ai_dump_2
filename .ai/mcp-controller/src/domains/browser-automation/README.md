# Browser Automation Domain

## Purpose

Defines CDP plugin contracts while keeping runtime disabled behind feature flag in v1.

## How to extend

- Keep contract-only surface in v1.
- Gate runtime execution by explicit feature flag.
- Preserve deterministic artifacts for any future runs.

## Gotchas

- Do not enable CDP runtime by default.
- Avoid side effects when feature is disabled.

## Invariants

- `browserAutomationEnabled=false` means no runtime execution.
- Contracts remain stable for later implementation phases.
