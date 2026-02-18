## MCP Controller

This repo has a policy-gated MCP controller at `.ai/`. All code changes must go through the `controller_turn` tool.

### Session flow

1. Call `controller_turn` with `verb: "initialize_work"` and your `originalPrompt`
2. Read the returned `contextPack`, `strategy`, and `planGraphSchema`
3. Use read/search verbs to gather context: `read_file_lines`, `lookup_symbol_definition`, `search_codebase_text`
4. If you need files outside the contextPack scope, call `escalate`
5. Submit your plan via `submit_execution_plan` with a PlanGraphDocument
6. Apply patches via `apply_code_patch`
7. Call `signal_task_complete` when done — this triggers memory candidate scaffolding

### Rules

- Always pass your `agentId` in every `controller_turn` call
- Sub-agents spawned from a parent should use a unique `agentId`
- Never skip `initialize_work` — it sets up scope, strategy, and budget
- If the controller rejects your plan, read the `fixes[]` array and resubmit
- Do not fabricate proof chains — if data is missing, call `escalate`
- When migration strategy is active, change nodes MUST cite a `migration:` policyRef

### Environment

- Angular 14 / TypeScript / Node.js
- macOS / VS Code
- Two component libraries: ADP (legacy, Waypoint) and SDF (new, design system)
- Neo4j graph has routes, symbols, components, policies, migration rules
- Runtime AST index has line-precise symbol locations and full-text search

### Memory system

- The controller learns from friction (repeated rejections → auto-created memories)
- You can suggest memories via `signal_task_complete` summary
- Human overrides go in `.ai/memory/overrides/` — see `.ai/how-to/memory-system.md`
