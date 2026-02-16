# ai_dump_2

MCP runtime files are colocated under `.ai/mcp-controller`.
The runtime executes directly from TypeScript source (`tsx`); no project-level build/dist output is required.

Run commands from repo root:

- `npm --prefix .ai/mcp-controller test`
- `npm --prefix .ai/mcp-controller start`
- `npm --prefix .ai/mcp-controller run e2e:smoke`
- `npm --prefix .ai/mcp-controller run start:mcp`
- `npm --prefix .ai/mcp-controller run e2e:mcp-smoke`
- `npm --prefix .ai/mcp-controller run e2e:mcp-stdio-smoke`

External test-app validation:

- `node e2e/run-validation.mjs`
