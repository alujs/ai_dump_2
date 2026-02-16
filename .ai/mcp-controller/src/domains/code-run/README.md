# Code Run Domain

## Purpose

Executes approved async-IIFE workloads with preflight checks and durable artifact outputs.

## How to extend

- Keep preflight strict and deterministic.
- Validate declared inputs and expected output shape before execution.
- Persist primary results to artifact bundles for replayability.

## Gotchas

- Placeholder or non-substantive returns must be rejected.
- External side effects require explicit side-effect commit gates.

## Invariants

- `code_run` input must be async IIFE text.
- Result pointers are artifact-backed, not memory-only.
