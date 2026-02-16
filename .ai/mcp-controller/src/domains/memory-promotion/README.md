# Memory Promotion Domain

## Purpose

Tracks correction and policy candidates through pending/provisional/approved lifecycle.

## How to extend

- Keep state transitions explicit and auditable.
- Preserve provenance and trace refs on every transition.
- Enforce reversible provisional lane behavior.

## Gotchas

- High-impact policies must not auto-promote.
- Expired provisional items must be rejected deterministically.

## Invariants

- Promotion states are one of pending/provisional/approved/rejected/expired.
- Every item contains source trace and creation metadata.
