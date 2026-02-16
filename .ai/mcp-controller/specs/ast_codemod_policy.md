# AST Codemod Policy (MCP v1)

## Why This Exists

This MCP allows AST-backed patch operations without allowing freeform "invent your own codemod engine" behavior.

- Allowed: fixed codemod IDs from the allowlist.
- Not allowed: custom/unregistered codemod IDs generated ad hoc by an agent.

## Allowed `patch_apply` Operations

1. `replace_text`
2. `ast_codemod`

`ast_codemod` must provide:

- `codemodId`
- `codemodParams`

## Codemod Allowlist

1. `rename_identifier_in_file`
Required params: `from`, `to`
2. `update_import_specifier`
Required params: `moduleSpecifier`, `from`, `to`
3. `update_route_path_literal`
Required params: `fromPath`, `toPath`
4. `rewrite_template_tag`
Required params: `fromTag`, `toTag`

Canonical source:

- `src/domains/patch-exec/astCodemodCatalog.ts`

## PlanGraph Citation Requirement

If `patch_apply.operation = ast_codemod`, the `change` node citations must include:

- `codemod:<codemodId>`

Version suffix is allowed:

- `codemod:<codemodId>@v1`

Examples:

- `codemod:rename_identifier_in_file`
- `codemod:update_import_specifier@v1`

## Rejection Behavior

1. Unknown codemod ID:
- `PLAN_POLICY_VIOLATION`
2. Missing required params:
- `PLAN_MISSING_REQUIRED_FIELDS`
3. Codemod requested without required PlanGraph citation:
- `PLAN_POLICY_VIOLATION`
4. File/symbol scope mismatch:
- `PLAN_SCOPE_VIOLATION`

## Agent Guidance

Agent should:

1. Choose a codemod from the allowlist only.
2. Add codemod citation to PlanGraph change node citations.
3. Provide required params for that codemod.
4. Use `patch_apply` with `operation="ast_codemod"`.

Agent should not:

1. Propose custom codemod IDs.
2. Skip PlanGraph citation linkage for codemod requests.
