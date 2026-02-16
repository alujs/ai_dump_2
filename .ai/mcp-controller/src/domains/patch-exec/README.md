# Patch Exec Domain

## Purpose

Executes structured patch intents against approved plan nodes with scope and collision checks.

## How to extend

- Keep edit operations typed and deterministic.
- Validate file and symbol scope before reading content.
- Persist artifact bundles for every operation.

## Supported Operations

- `replace_text`
  - required fields: `find`, `replace`
  - deterministic string replacement scoped to approved node/file/symbols.
- `ast_codemod`
  - required fields: `codemodId`, `codemodParams`
  - codemod options are fixed by `astCodemodCatalog.ts`:
    - `rename_identifier_in_file`
    - `update_import_specifier`
    - `update_route_path_literal`
    - `rewrite_template_tag`
  - custom codemods are not allowed in v1.

## PlanGraph Citation Rule

- Any `ast_codemod` execution requires the change-node `citations` to include:
  - `codemod:<codemodId>`
  - optional version suffix allowed: `codemod:<codemodId>@vN`
- Unknown codemod citation tokens are rejected by PlanGraph validation.

## Gotchas

- Never allow freeform repository writes.
- Collision checks run before any file mutation.
- Unknown/custom codemod IDs must fail with policy violation.

## Invariants

- `patch_apply` only targets approved node/file/symbol scopes.
- Patch operations always emit `diff.summary.json`.
- AST codemods are allowlisted and citation-gated.
