# MCP Local Config

Config layering order:

1. `base.json`
2. `repo.json`
3. `env.local.json` (gitignored)
4. environment variables
5. validated against `schema.json` at startup

Common overrides:

- `NEO4J_URI`
- `NEO4J_USERNAME`
- `NEO4J_PASSWORD`
- `NEO4J_DATABASE`
- `MCP_DASHBOARD_PORT`
- `MCP_TARGET_REPO_ROOT` (optional separate target app root while keeping `.ai` at repo root)

Required config areas include:

- repo/worktree roots
- ingestion include/exclude globs
- Angular/federation hints
- parser target roots
- connector settings and auth references
- recipe manifest path
- feature flags

Default parser/ingestion roots are broad enough for mixed Angular workspaces:

- `src`, `apps`, `libs`, `projects`, `packages`

## MCP Client Registration

Use `.ai/config/mcp.client.template.json` as the copy/paste template for an MCP client config.
For this workspace, `.ai/config/mcp.client.local.json` is pre-filled with absolute paths.

- Replace `<ABSOLUTE_REPO_ROOT>` with the real local repo path.
- The launcher script `scripts/run-mcp-stdio.mjs` sets up repo-root resolution automatically.
- `MCP_ENABLE_DASHBOARD=true` lets the MCP process expose dashboard endpoints on `MCP_DASHBOARD_PORT`.

## Swagger Connector

`swagger.roots` is an array so you can provide one or many OpenAPI entry roots.

- For a single API, use one root URL/path in the array.
- Example:
  - `"swagger": { "roots": ["https://api.example.com"] }`
