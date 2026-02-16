# Graph-Backed MCP Controller Full Spec (Atomic v1)

## Summary

Single-tool MCP controller with lexical-first graph retrieval, high-signal context, validator-gated planning, weak-model-safe execution, strict worktree scope, and observability-driven memory/policy evolution.

## Core Model

- Strong models: planning only.
- Weak models: implementation only.
- MCP: controller authority.

## Hard Constraints

- One external MCP tool: `controller.turn`.
- No embeddings, local or external.
- Local Neo4j plus lexical side index.
- PlanGraph required before repo writes.
- Pre-plan writes allowed only to scratch path.
- Work scoped by `workId` and worktree boundary.
- This system runs against the target Angular 14 repository context only.
- Supported external artifact connectors in v1 are Jira and Swagger only.
- Jira authentication in v1 uses Personal Access Token (PAT) only.

## Domain Structure

- `src/domains/controller`
- `src/domains/capability-gating`
- `src/domains/context-pack`
- `src/domains/plan-graph`
- `src/domains/strategy`
- `src/domains/evidence-policy`
- `src/domains/worktree-scope`
- `src/domains/patch-exec`
- `src/domains/code-run`
- `src/domains/observability`
- `src/domains/memory-promotion`
- `src/domains/recipes`
- `src/domains/connectors`
- `src/domains/graph-ops`
- `src/domains/indexing`
- `src/domains/dashboard`
- `src/infrastructure/neo4j`
- `src/infrastructure/lexical-index`
- `src/infrastructure/fs`
- `src/infrastructure/git`
- `src/infrastructure/vm`
- `src/infrastructure/http`
- `src/contracts`
- `src/config`

## Modularity Rules

- Soft file target: 200-350 lines.
- Warning threshold: 400 lines.
- Review and split justification at 500+ lines.
- No magic strings.
- Use constants, enums, and typed models.
- Every domain folder must include:
- `README.md` with purpose, extension guide, gotchas, invariants.
- Minimal tests for invariants and failure modes.

## Single Tool Protocol

### Request envelope

- `runSessionId?`
- `workId?`
- `agentId?`
- `verb`
- `args`
- `traceMeta?`

### Response envelope

- `runSessionId`
- `workId`
- `agentId`
- `state`
- `outcome?`
- `capabilities[]`
- `scope`
- `result`
- `denyReasons[]`
- `knowledgeStrategy`
- `budgetStatus`
- `traceRef`
- `schemaVersion`

## Capability Gating

### Pre-plan

- `list`
- `list_allowed_files`
- `read_range`
- `read_symbol`
- `read_neighbors`
- `grep_lexeme`
- `original_prompt`
- `write_tmp`
- `submit_plan`
- `escalate`

### Post-plan approved

- All pre-plan commands remain.
- `patch_apply`
- `code_run`

### Scratch path rules

- `write_tmp` resolves under `.ai/tmp/work/{workId}/scratch/...` only.
- Scratch artifacts are observable and referenceable by artifact ID.

## ContextPack Contract

Required sections:

- Header IDs, hashes, and `schemaVersion`.
- Task constraints and conflicts.
- Active policy set.
- Active strategy with evidence-backed reasons.
- Anchors and proof chains.
- Allowed files and command capabilities.
- Validation plan.
- Missingness and conflicts.
- Schema links and expectations.

High-signal rule:

- ContextPack is minimum sufficient context only.
- No bulk dumps unless explicitly required by policy or escalation.

## PlanGraph Day-0 Envelope

Required:

- `workId`
- `agentId`
- `runSessionId`
- `repoSnapshotId`
- `worktreeRoot`
- `contextPackRef`
- `contextPackHash`
- `policyVersionSet`
- `scopeAllowlistRef`
- `knowledgeStrategyId`
- `knowledgeStrategyReasons[]` with evidence refs
- `evidencePolicy` object
- `planFingerprint`
- `sourceTraceRefs[]`
- `schemaVersion`

Node kinds:

- `change`
- `validate`
- `escalate`
- `side_effect`

Kind-specific required fields are mandatory and validator-enforced.

## PlanGraph Kind-Specific Contracts (Mandatory)

### Common fields for all node kinds

Required on every node:

- `nodeId`
- `kind`
- `dependsOn[]`
- `atomicityBoundary`
- `expectedFailureSignatures[]`
- `correctionCandidateOnFail`

`atomicityBoundary` must be machine-checkable and include:

- `inScopeAcceptanceCriteriaIds[]`
- `outOfScopeAcceptanceCriteriaIds[]`
- `inScopeModules[]`
- `outOfScopeModules[]`

### `change` nodes

Required:

- `operation` (`create|modify|delete`)
- `targetFile`
- `targetSymbols[]` (or explicit symbol-creation intent for `create`)
- `whyThisFile`
- `editIntent`
- `escalateIf[]`
- `citations[]`
- `codeEvidence[]`
- `artifactRefs[]`
- `policyRefs[]`
- `verificationHooks[]`

Conditional:

- `fewShotRefs[]` or `recipeRefs[]`
- If strategy or policy marks examples mandatory, at least one must be present.
- If single-source evidence is used:
- `lowEvidenceGuard = true`
- `uncertaintyNote`
- `requiresHumanReview = true`

### `validate` nodes

Required:

- `verificationHooks[]`
- `mapsToNodeIds[]`
- `successCriteria`

### `escalate` nodes

Required:

- `requestedEvidence[]`
- `blockingReasons[]`
- `proposedNextStrategyId?`

`requestedEvidence[]` must be typed:

- `artifact_fetch`
- `graph_expand`
- `pack_rebuild`

### `side_effect` nodes

Required:

- `sideEffectType`
- `sideEffectPayloadRef`
- `commitGateId`

Rule:

- `dependsOn[]` must include relevant `validate` nodes unless policy explicitly allows pre-validation side effects.

## Evidence Policy

Configurable:

- `minRequirementSources`
- `minCodeEvidenceSources`
- `minPolicySources`
- `allowSingleSourceWithGuard`
- `lowEvidenceGuardRules[]`
- `distinctSourceDefinition`

Feature-work category coverage rule:

- At least one requirement citation.
- At least one code anchor.

Single-source path allowed only when:

- `allowSingleSourceWithGuard = true`
- Node sets low-evidence guard fields.
- Node includes uncertainty plus review requirement.

Non-gameable evidence rules:

- Distinct-source validation is category-aware.
- Two references to the same underlying file or artifact do not count as two sources.
- Feature work must satisfy category coverage:
- requirement evidence present
- code evidence present

## Execution Model

### `patch_apply`

- Structured edit intent only.
- Enforced against approved node, file, and symbols.
- No freeform repo writes.

### `code_run`

- Async IIFE only.
- Preflight required:
- declared inputs
- timeout
- memory cap
- artifact target
- expected return shape
- Reject placeholder or non-substantive returns.

### Per-node artifact bundle

- `result.json`
- `op.log`
- `trace.refs.json`
- `diff.summary.json` for patch operations
- `validation.json`

### Unified side-effect collision guard

All mutation-capable operations must pass the same collision checks:

- `patch_apply`
- `code_run`
- `side_effect`

Rules:

- Operation declares intended effect set before execution.
- MCP checks for collisions against:
- approved `side_effect` nodes
- scoped file and symbol reservations
- graph mutation reservations
- external side-effect gates
- Collisions reject execution before apply.

`code_run` defaults:

- Artifact-only behavior by default.
- No external network/process side effects unless explicitly allowed by approved `side_effect` node and commit gate.
- Primary result must be persisted in artifact bundle and returned as pointer/summary.

## Connector Model

Adapters:

- `jira`
- `swagger`

Shape:

- Custom adapter per connector.
- Shared kernel for auth plumbing, retry/backoff, rate limit, cache, tracing, normalized errors.

Ingestion targeting:

- Config-driven includes/excludes and module hints.

Mandatory retrieval lanes:

- lexical lane
- symbol lane
- policy lane
- artifact lane
- episodic memory lane

Jira auth contract:

- PAT token source from `.ai/auth/jira.token` or configured local override.
- No alternate Jira auth methods in v1.

## CDP Boundary

- Define plugin contracts now in `browser-automation` domain.
- Keep runtime disabled behind feature flag in v1.

## Config Portability

Layered files:

- `.ai/config/base.json`
- `.ai/config/repo.json`
- `.ai/config/env.local.json` (gitignored)
- `.ai/config/schema.json`

Startup:

- Validate merged config before service starts.
- Fail fast with actionable config errors.

Required config areas:

- Repo/worktree roots.
- Ingestion include and exclude globs.
- Angular and federation hint paths.
- Parser target roots by language.
- Connector endpoint settings and auth refs.
- Recipe manifest path.
- Dashboard port and feature flags.

## AST Tooling Baseline

Required parser stack in v1:

- TypeScript and JavaScript: `ts-morph` on top of `typescript`.
- Angular templates and bindings: `@angular/compiler` template parser.
- JSON and YAML: parser adapters with stable AST output for indexing.

Angular template indexing requirements:

- Parse template AST for:
- component tags and selector usage
- inputs/outputs and bindings
- structural directives and control flow nodes
- reference variables and event handlers

Parser operation model:

- Full AST/symbol index at MCP startup.
- Incremental re-index on commit/change events.
- Parser failures are logged as structured indexing events and never silently ignored.

## Secrets

- Local secrets in `.ai/auth/*`.
- `.ai/auth` is gitignored.
- Redact secret values and auth paths from logs and artifacts.

## GraphOps and Team Sync

Default sync workflow:

1. Drop graph.
2. Recreate constraints and indexes.
3. Upsert from `.ai/graph/seed/**/*.jsonl`.

Export workflow:

- Export local changes into JSONL buckets for git merge and rebase.

Conflict policy:

- Last-write-wins.
- Deterministic tiebreak:
1. higher `version`
2. newer `updated_at`
3. lexical `updated_by`

Policy and recipe seed row invariants:

- Every policy/recipe row must include:
- `id`
- `type`
- `version`
- `updated_at`
- `updated_by`
- Upsert tooling must reject rows missing required versioning fields.
- Version increments are enforced by import tooling for changed rows.

Folders:

- `.ai/graph/seed/` for canonical JSONL.
- `.ai/graph/cypher/` for cypher scripts.
- `.ai/graph/out/` for exported deltas.

## Dashboard

Runtime:

- Express/HTTP listener.
- Default port: `8722` (configurable, non-4200/non-8080).

Endpoints:

- `/health`
- `/worktrees`
- `/runs`
- `/errors`
- `/policies/pending`
- `/metrics`
- `/stream/events` (SSE)

UI scope:

- Current worktrees.
- Run statuses.
- Error stream.
- Live log stream.
- Pending corrections and policy candidates.
- Rejection-code heatmaps and trend lines.
- Top rejection signatures by strategy and module.
- Retrieval/slicing failure hotspots for tuning.

## Observability and Memory

Log everything:

- Input and output envelopes.
- Retrieval traces.
- Plan validation outcomes.
- Execution outcomes.
- Repeated actions and failures.
- Strategy choices and switches.

Memory pipeline:

- Auto-create `PendingCorrection` and `PolicyCandidate`.
- Human approval required before promotion.
- Approved items upsert to graph policy/memory planes with provenance refs.

### Promotion states

- `pending`
- `provisional`
- `approved`
- `rejected`
- `expired`

### Provisional auto-promotion lane

Purpose:

- Avoid approval bottlenecks for low-risk, high-signal updates.

Eligibility (policy-configurable):

- low-risk lexeme aliases
- low-risk retrieval tuning metadata
- non-destructive strategy hints

Default flow:

- Item remains `pending` for contest window (default 48h).
- If uncontested, item may move to `provisional`.
- `provisional` items are reversible, time-bound, and fully trace-linked.
- `provisional` items auto-expire unless promoted to `approved`.

Hard policy rule:

- Durable policy rules and high-impact behavior changes still require explicit human approval.

Mandatory episodic recipe usage event:

- `recipeId`
- `validatedParams`
- `workId`
- `runSessionId`
- `planNodeId`
- `artifactBundleRef`
- `diffSummaryRef`
- `validationOutcome`
- `failureSignature?`

## Safety and Guardrails

- Worktree and `workId` scope enforcement on every operation.
- Canonicalized path checks prevent traversal.
- No wildcard symbol scopes in execution.
- No side effects without explicit commit gate.
- No arbitrary codemod args.
- Recipe execution is `recipeId + validated params` only.
- Secret and auth values must be redacted in all logs, traces, and artifacts.

## Rejection Codes

- `PLAN_MISSING_REQUIRED_FIELDS`
- `PLAN_SCOPE_VIOLATION`
- `PLAN_EVIDENCE_INSUFFICIENT`
- `PLAN_NOT_ATOMIC`
- `PLAN_VERIFICATION_WEAK`
- `PLAN_STRATEGY_MISMATCH`
- `PLAN_WEAK_MODEL_AMBIGUOUS`
- `PLAN_FEDERATION_PROOF_MISSING`
- `PLAN_ORIGIN_UNKNOWN`
- `PLAN_POLICY_VIOLATION`
- `PLAN_MISSING_CONTRACT_ANCHOR`
- `PLAN_VALIDATION_CONFIDENCE_TOO_LOW`
- `EXEC_SIDE_EFFECT_COLLISION`
- `EXEC_UNGATED_SIDE_EFFECT`
- `MEMORY_PROVISIONAL_EXPIRED`
- `PACK_INSUFFICIENT`
- `PACK_REQUIRED_ANCHOR_UNRESOLVED`

## Acceptance Tests

- Pre-plan scratch write succeeds only inside scoped scratch path.
- Plan rejection is deterministic with precise codes.
- Low-evidence guard path enforced correctly.
- Weak executor cannot infer extra files or symbols.
- `code_run` preflight and non-placeholder return checks enforced.
- Repeated failures create pending correction candidates.
- Approved corrections influence later strategy and policy choices.
- Graph sync/export deterministic after rebase.

Additional mandatory tests:

- PlanGraph validator enforces exact kind-specific required fields.
- Single-source guard path rejects when guard fields are absent.
- Strategy reasons require evidence pointers, not free text only.
- Feature plans reject when requirement evidence or code evidence category is missing.
- Policy seed import rejects missing `version`/`updated_at`/`updated_by`.
- Recipe usage emits episodic event with artifact and validation refs.

## Implementation Sequence

1. Contracts and config schema.
2. Controller entrypoint and capability gating.
3. Retrieval lanes and ContextPack builder.
4. PlanGraph validator and rejection matrix.
5. Scratch, `patch_apply`, and `code_run` execution layer.
6. Observability and repeat/failure detectors.
7. Memory promotion queue and graph integration.
8. Connector adapters plus shared kernel.
9. GraphOps sync/export commands.
10. Dashboard HTTP plus SSE stream.
11. Domain docs and tests hardening.

## Strategy Enforcement Surface

ContextSignature features are required inputs to strategy selection:

- `hasJira`
- `hasSwagger`
- `mentionsAgGrid`
- `touchesShadowDom`
- `crossesFederationBoundary`
- `migrationAdpDetected`
- `contractAnchorPresent`
- `testConfidenceLevel`

Multiple strategy classes are mandatory in v1 (not optional):

- `ui_aggrid_feature`
- `api_contract_feature`
- `migration_adp_to_sdf`
- `debug_symptom_trace`

### Feature strategy doctrine (applies to `ui_aggrid_feature` and `api_contract_feature`)

Planning behavior requirements:

- Maximize relevant context assembly before proposing edits.
- For each planned touched file, include at least one few-shot or recipe-aligned example.
- Evaluate active policies before final plan submission and include policy adjustments if needed.
- Prefer in-repo examples and prevailing patterns over external documentation during initial design.
- Validate intended patterns by prevalence in the current codebase before adopting them.

Assumption testing requirements:

- At each major planning step, explicitly test assumptions against repository evidence.
- If a pattern appears sparse or inconsistent, mark low confidence and escalate instead of normalizing it.
- Unresolved assumptions must produce explicit escalation requirements in PlanGraph.

Architecture invariants for feature plans:

- Preserve clear separation of `controller`, `service`, and `data` layers.
- Reject feature plans that collapse these layers without explicit policy-backed justification.

Verification requirements:

- Include test authoring in the plan for impacted behavior.
- Include end-to-end validation path in plan verification hooks before completion state.

### Deep-quality variant (refactor-heavy or high-risk feature paths)

When time and scope allow, planners should use this stricter sequence:

1. Run blast-radius analysis first:
- upstream dependency impact
- downstream consumer impact
- integration boundary impact (host/remote, shared contracts)
2. Confirm baseline test coverage:
- e2e coverage for target component or flow
- unit coverage for touched services/data transforms
3. If baseline tests are missing:
- create baseline tests first (before behavior-changing edits)
- prefer codemod-assisted scaffolding where available
4. Establish baseline truth:
- run tests and require pass state
- capture Cypress screenshot artifact for current behavior
- ensure stable e2e selectors exist for target flow
5. Apply feature/refactor changes only after baseline is green.
6. Re-run verification and compare against baseline artifacts.

Non-negotiable hygiene in this variant:

- No magic strings in UI/domain logic.
- i18n-compliant text handling for user-facing copy.
- Selector hygiene for durable e2e execution.
- Thorough repository-grounded research at each major step.

### Cypress + Accessibility doctrine (LLM-assisted)

Testing strategy expectations:

- Cypress suites may be LLM-assisted for broad input coverage and edge cases.
- Accessibility verification targets WCAG AA compliance as far as practical.
- Generated tests must still be deterministic and repository-pattern aligned.

SDF component caveat:

- Many `sdf-*` components include built-in semantics/attributes.
- Avoid redundant or counterproductive labeling when component contracts already satisfy accessibility intent.
- Prefer component API contract evidence over ad hoc markup assumptions.

CDP-aware validation path:

- If CDP capability is enabled, use browser inspection to validate runtime accessibility and interaction behavior.
- If CDP is unavailable, validate using:
- component library API contracts
- structural evidence from templates
- repository few-shot examples

Shadow DOM rule:

- For Shadow DOM/Shadow Root interactions, Cypress examples from the repository are the primary evidence source.
- Plans touching Shadow DOM must reference shadow-capable Cypress patterns or recipes.

Strategy selection must output:

- `knowledgeStrategyId`
- structured `knowledgeStrategyReasons[]` with evidence refs
- required proof obligations for this strategy

Hard strategy switch triggers:

- `plan_rejected`
- `policy_conflict`
- `repeated_failure_threshold`
- `repeated_action_threshold`
- `missing_required_proof_chain`

After trigger:

- Strategy switch is mandatory.
- Next attempt must reference new strategy ID or explicit escalation evidence.
- Regeneration without new pack, new strategy, or resolved missingness is rejected.

## ContextPack Readiness Invariants

A ContextPack is not ready unless all required invariants pass:

- Snapshot purity.
- At least one entrypoint anchor.
- At least one definition anchor.
- Active policy set resolved.
- Validation plan present.
- Missingness/conflicts present.

UI and federated work invariants:

- Ag-grid origin proof chain present when UI task involves tables:
- `Table -> ColumnDef -> CellRenderer -> NavTrigger -> Route -> Component`
- Federation proof chain present when boundary is crossed:
- `Host route -> mapping -> expose -> remote module -> destination`

If required proof chain cannot be resolved in current worktree scope:

- Mark pack as insufficient.
- Emit escalation requirement before PlanGraph acceptance.

Pack insufficiency handling contract:

- Return `outcome = "pack_insufficient"`.
- Include `missingAnchors[]` with:
- `anchorType`
- `requiredBy`
- `whyRequired`
- `attemptedSources[]`
- `confidence`
- Include `escalationPlan[]` typed actions:
- `artifact_fetch`
- `graph_expand`
- `scope_expand`
- `pack_rebuild`
- `strategy_switch`
- Include `blockedCommands[]` that remain unavailable until insufficiency is resolved.
- Include `nextRequiredState` for the recovery path.

## Worktree and Federation Scope Rule

Default scope model:

- One `workId` maps to one active worktree.

Cross-boundary behavior:

- If host and required remote are not both available in current scope, planner must emit escalation.
- PlanGraph cannot pass with unresolved federation proof obligations.

## `code_run` Reproducibility Invariant

Every `code_run` must:

- write durable outputs into per-node artifact bundle
- return a pointer/summary to produced artifacts
- avoid returning primary results only in-memory

Non-replayable `code_run` outputs are rejected.

## Retrieval Debug Digest

PlanGraph keeps `retrievalConfigId` optional in v1.

ContextPack must carry:

- retrieval config digest
- query trace refs
- scoring rationale refs

This preserves debuggability without expanding Day-0 PlanGraph envelope.

## Non-goals for v1

- Full CDP runtime execution.
- Multi-agent parallel execution orchestration.
- Cloud-hosted secrets or remote graph services.

## Defaults

- Local-only operation.
- File-based local auth under `.ai/auth`.
- Local Neo4j.
- JSONL seed/export team sync.
- Drop plus upsert as baseline graph sync strategy.
