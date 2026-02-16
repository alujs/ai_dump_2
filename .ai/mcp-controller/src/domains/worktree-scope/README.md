# Worktree Scope Domain

## Purpose

Enforces canonicalized path and symbol scope for every operation within one `workId` worktree.

## How to extend

- Keep scope checks centralized in this domain.
- Use explicit allowlists rather than wildcard scope grants.
- Return deterministic rejection reasons on scope misses.

## Gotchas

- Path traversal checks must be canonicalized before compare.
- Symbol scopes must reject wildcard assumptions.

## Invariants

- File writes never escape worktree root.
- Symbol checks are exact, not fuzzy.
