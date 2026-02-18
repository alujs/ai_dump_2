/**
 * Handler for verb="initialize_work" — the bootstrap verb.
 *
 * This is the ONLY verb available in UNINITIALIZED state.
 * It builds the contextPack, selects strategy, computes planGraphSchema,
 * and transitions the session to PLANNING.
 *
 * Spec ref: architecture_v2.md §4 (lines 170-281)
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readdirSync, copyFileSync, statSync } from "node:fs";

import type { VerbResult, SessionState } from "../types";
import type { EventStore } from "../../observability/eventStore";
import type { IndexingService } from "../../indexing/indexingService";
import type { MemoryService } from "../../memory/memoryService";
import type { ConnectorRegistry } from "../../connectors/connectorRegistry";
import type { ProofChainBuilder } from "../../proof-chains/proofChainBuilder";
import type { StrategySelection } from "../../strategy/strategySelector";

import { capabilitiesForState } from "../../capability-gating/capabilityMatrix";
import { createContextPack } from "../../context-pack/contextPackService";
import { collectRetrievalLanes } from "../../context-pack/retrievalLanes";
import { selectStrategy, recommendedSubAgentSplits } from "../../strategy/strategySelector";
import { listAllowedFiles } from "../../worktree-scope/worktreeScopeService";
import { listPatchApplyOptions } from "../../patch-exec/patchExecService";
import { resolveTargetRepoRoot, workRoot, scratchRoot } from "../../../shared/fsPaths";
import { writeText } from "../../../shared/fileStore";
import { verbDescriptionsForCapabilities } from "../../../shared/verbCatalog";
import { SCHEMA_VERSION } from "../../../shared/constants";
import { extractAnchors, asStringArray, asStringRecord } from "../turnHelpers";

export interface InitializeWorkDeps {
  eventStore: EventStore;
  indexing: IndexingService | null;
  memoryService: MemoryService;
  connectors?: ConnectorRegistry;
  proofChainBuilder: ProofChainBuilder | null;
}

export async function handleInitializeWork(
  args: Record<string, unknown> | undefined,
  session: SessionState,
  deps: InitializeWorkDeps,
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const originalPrompt = session.originalPrompt;
  const lexemes = asStringArray(args?.lexemes) ?? [];

  /* ── 1. Create workspace directory ─────────────────────── */
  const workDir = workRoot(session.workId);
  try {
    mkdirSync(workDir, { recursive: true });
    mkdirSync(path.join(workDir, "scratch"), { recursive: true });
    mkdirSync(path.join(workDir, "attachments"), { recursive: true });
  } catch { /* directories may already exist */ }

  /* ── 1b. Phase 6: Ingest .ai/inbox/ files ──────────────── */
  const inboxDir = path.join(resolveTargetRepoRoot(), ".ai", "inbox");
  const inboxArtifacts = ingestInboxFiles(inboxDir, path.join(workDir, "attachments"), session.artifacts);
  for (const artifact of inboxArtifacts) {
    session.artifacts.push(artifact);
  }

  /* ── 1c. Phase 6: Accept args.attachments[] pass-through ─ */
  const argsAttachments = Array.isArray(args?.attachments) ? args.attachments : [];
  for (const attachment of argsAttachments) {
    if (attachment && typeof attachment === "object") {
      const att = attachment as Record<string, unknown>;
      session.artifacts.push({
        source: "attachment",
        ref: String(att.ref ?? att.name ?? `attachment:${session.artifacts.length}`),
        summary: String(att.caption ?? att.summary ?? att.description ?? ""),
        metadata: att,
      });
    }
  }

  /* ── 2. Ingest override files FIRST (§4 line 196, §15 gotcha #3) ── */
  await deps.memoryService.ingestOverrideFiles();

  /* ── 3. Query active memories SECOND ────────────────────── */
  const worktreeRoot = resolveTargetRepoRoot();
  let scopeFiles = listAllowedFiles(session.workId, session.scopeAllowlist, worktreeRoot);
  const activeMemories = await deps.memoryService.findActiveForAnchors(
    scopeFiles.slice(0, 50).map((f) => {
      const parts = f.replace(/\\/g, "/").split("/");
      return parts.length > 1 ? `anchor:${parts.slice(0, 2).join("/")}` : `anchor:${parts[0]}`;
    })
  );

  /* ── 4. Compute base ContextSignature ──────────────────── */
  const jiraSlice = (session as SessionState & {
    jiraSlice?: { issueType?: string; labels?: string[]; components?: string[]; summary?: string; description?: string };
  }).jiraSlice;

  // Check if prompt/lexemes reference a Jira ticket key pattern
  let jiraFields = jiraSlice ? {
    issueType: jiraSlice.issueType,
    labels: jiraSlice.labels,
    components: jiraSlice.components,
    summary: jiraSlice.summary,
    description: jiraSlice.description,
  } : undefined;

  // Auto-fetch Jira if prompt/lexemes match ticket pattern (§4 lines 201-202)
  if (!jiraFields && deps.connectors) {
    const ticketPattern = /[A-Z][A-Z0-9]+-\d+/;
    const promptTicket = originalPrompt.match(ticketPattern)?.[0];
    const lexemeTicket = lexemes.find((l) => ticketPattern.test(l));
    const ticketKey = promptTicket ?? lexemeTicket;
    if (ticketKey) {
      try {
        const jiraConnector = deps.connectors.get("jira");
        if (jiraConnector) {
          const ticket = await jiraConnector.fetch({ ticketKey });
          if (ticket) {
            session.artifacts.push(ticket);
            const meta = ticket.metadata as Record<string, unknown> | undefined;
            jiraFields = {
              issueType: meta?.issueType as string | undefined,
              labels: meta?.labels as string[] | undefined,
              components: meta?.components as string[] | undefined,
              summary: ticket.summary,
              description: meta?.description as string | undefined,
            };
          }
        }
      } catch { /* Jira fetch failures are non-fatal */ }
    }
  }

  // Auto-fetch Swagger if prompt/lexemes reference API (§4 lines 201-202)
  if (deps.connectors) {
    const swaggerPatterns = [/swagger/i, /openapi/i, /\/api\//i];
    const hasSwaggerRef = swaggerPatterns.some(
      (p) => p.test(originalPrompt) || lexemes.some((l) => p.test(l))
    );
    if (hasSwaggerRef) {
      try {
        const swaggerConnector = deps.connectors.get("swagger");
        if (swaggerConnector) {
          const specUrl = lexemes.find((l) => l.startsWith("http")) ?? "";
          if (specUrl) {
            const spec = await swaggerConnector.fetch({ specUrl });
            if (spec) session.artifacts.push(spec);
          }
        }
      } catch { /* Swagger fetch failures are non-fatal */ }
    }
  }

  /* ── 5. Apply strategy_signal memory overrides (§13 lines 530-535) ── */
  const strategySignalMemories = activeMemories.filter(
    (m) => m.enforcementType === "strategy_signal" && m.strategySignal
  );

  // Base strategy from prompt + lexemes
  const baseStrategy = selectStrategy({
    originalPrompt,
    lexemes,
    artifacts: session.artifacts.map((a) => ({ source: a.source, ref: a.ref, metadata: a.metadata })),
    anchors: extractAnchors(args),
    jiraFields,
  });

  // Phase 5: Apply strategy_signal memory overrides to ContextSignature
  const strategy = applyStrategySignalOverrides(baseStrategy, strategySignalMemories);

  /* ── 6. Build contextPack via retrieval lanes ──────────── */
  const retrievalLanes = await collectRetrievalLanes({
    queryText: `${originalPrompt}\n${lexemes.join(" ")}`,
    symbolHints: asStringArray(args?.symbolHints) ?? [],
    activePolicies: asStringArray(args?.activePolicies) ?? [],
    knownArtifacts: session.artifacts,
    indexing: deps.indexing,
    events: deps.eventStore,
  });

  // Determine proof chain requirements
  const needsAgGrid = strategy.contextSignature?.mentions_aggrid
    ?? lexemes.some((l) => l.includes("ag-grid"));
  const needsFederation = strategy.contextSignature?.behind_federation_boundary
    ?? lexemes.some((l) => l.includes("federation"));

  let agGridProofChain: Awaited<ReturnType<ProofChainBuilder["buildAgGridOriginChain"]>> | undefined;
  let federationProofChain: Awaited<ReturnType<ProofChainBuilder["buildFederationChain"]>> | undefined;

  if (deps.proofChainBuilder) {
    const chainSeed = extractChainSeed(args, lexemes, originalPrompt);
    if (needsAgGrid && chainSeed) {
      try {
        agGridProofChain = await deps.proofChainBuilder.buildAgGridOriginChain(chainSeed);
        await deps.eventStore.append({
          ts: new Date().toISOString(), type: "proof_chain_built",
          runSessionId: session.runSessionId, workId: session.workId, agentId: session.agentId,
          payload: { chainType: "ag_grid_origin", complete: agGridProofChain.complete, links: agGridProofChain.chain.length, missingLinks: agGridProofChain.missingLinks },
        });
      } catch { /* chain build failures are non-fatal */ }
    }
    if (needsFederation && chainSeed) {
      try {
        federationProofChain = await deps.proofChainBuilder.buildFederationChain(chainSeed);
        await deps.eventStore.append({
          ts: new Date().toISOString(), type: "proof_chain_built",
          runSessionId: session.runSessionId, workId: session.workId, agentId: session.agentId,
          payload: { chainType: "federation", complete: federationProofChain.complete, links: federationProofChain.chain.length, missingLinks: federationProofChain.missingLinks },
        });
      } catch { /* chain build failures are non-fatal */ }
    }
  }

  // Extract raw Jira ticket from session artifacts
  const rawJiraTicket = extractRawJiraTicket(session.artifacts);

  /* ── 6b. Enrich scope from retrieval lanes (v2: start narrow, grow from evidence) ── */
  if (scopeFiles.length === 0) {
    const retrievedFiles = new Set<string>();
    for (const hit of retrievalLanes.lexicalLane) {
      const fp = hit.filePath as string | undefined;
      if (fp) retrievedFiles.add(fp);
    }
    for (const hit of retrievalLanes.symbolLane) {
      const fp = hit.filePath as string | undefined;
      if (fp) retrievedFiles.add(fp);
    }
    // Also include schema links as always-accessible files
    const schemaLinks = [
      ".ai/config/schema.json",
      "src/contracts/controller.ts",
      "src/contracts/planGraph.ts",
      ".ai/mcp-controller/specs/ast_codemod_policy.md",
    ];
    for (const sl of schemaLinks) retrievedFiles.add(sl);
    scopeFiles = [...retrievedFiles];
  }

  const packOutput = await createContextPack({
    runSessionId: session.runSessionId,
    workId: session.workId,
    originalPrompt,
    strategyId: strategy.strategyId,
    strategyReasons: strategy.reasons,
    taskConstraints: asStringArray(args?.taskConstraints) ?? [],
    conflicts: asStringArray(args?.conflicts) ?? [],
    activePolicies: asStringArray(args?.activePolicies) ?? [],
    policyVersionSet: asStringRecord(args?.policyVersionSet),
    allowedFiles: scopeFiles,
    allowedCapabilities: capabilitiesForState("PLANNING"),
    validationPlan: asStringArray(args?.validationPlan) ?? [],
    missingness: asStringArray(args?.missingness) ?? [],
    retrievalLanes,
    executionOptions: { patchApply: listPatchApplyOptions() },
    schemaLinks: [
      ".ai/config/schema.json",
      "src/contracts/controller.ts",
      "src/contracts/planGraph.ts",
      ".ai/mcp-controller/specs/ast_codemod_policy.md",
    ],
    anchors: extractAnchors(args),
    requiresAgGridProof: needsAgGrid,
    requiresFederationProof: needsFederation,
    rawJiraTicket,
    agGridProofChain,
    federationProofChain,
    activeMemories,
  });

  /* ── 7. Store contextPack on session ───────────────────── */
  session.contextPack = {
    ref: packOutput.contextPackRef,
    hash: packOutput.contextPackHash,
    files: scopeFiles,
  };

  /* ── 8. Compute planGraphSchema (§7 lines 348-360) ─────── */
  const planGraphSchema = {
    validators: computeActiveValidators(strategy, activeMemories),
    expectedNodeKinds: ["change", "validate", "escalate", "side_effect"],
    requiredFields: {
      change: ["nodeId", "operation", "targetFile", "editIntent", "citations", "codeEvidence"],
      validate: ["nodeId", "verificationHooks", "mapsToNodeIds", "successCriteria"],
    },
    evidencePolicy: {
      minRequirementSources: 1,
      minCodeEvidenceSources: 1,
      minDistinctSources: 2,
      allowSingleSourceWithGuard: true,
    },
    enforcementObligations: computeEnforcementObligations(activeMemories),
  };

  /* ── 9. Build response ─────────────────────────────────── */
  const capabilities = capabilitiesForState("PLANNING");

  result.contextPack = {
    ref: packOutput.contextPackRef,
    hash: packOutput.contextPackHash,
    files: scopeFiles.slice(0, 200), // Summarize, don't dump full list
    totalFiles: scopeFiles.length,
    symbols: deps.indexing
      ? deps.indexing.getSymbolHeaders(100).map((s) => ({
          symbol: s.symbol, filePath: s.filePath, kind: s.kind, highSignal: s.highSignal,
        }))
      : [],
    policies: activeMemories
      .filter((m) => m.enforcementType === "plan_rule")
      .map((m) => ({ id: m.id, type: "hard", rule: m.planRule?.condition ?? m.note ?? "" })),
    memories: activeMemories
      .filter((m) => m.enforcementType === "few_shot")
      .map((m) => ({ id: m.id, enforcementType: m.enforcementType, summary: m.fewShot?.instruction ?? m.note ?? "" })),
    attachments: session.artifacts
      .filter((a) => a.source === "attachment")
      .map((a) => ({ ref: a.ref, caption: a.summary })),
  };

  if (packOutput.insufficiency) {
    result.insufficiency = packOutput.insufficiency;
  }

  result.planGraphSchema = planGraphSchema;
  result.strategy = {
    strategyId: strategy.strategyId,
    approach: describeApproach(strategy.strategyId),
    escalationGuidance: describeEscalationGuidance(strategy.strategyId),
    suggestedSplits: recommendedSubAgentSplits(strategy.strategyId),
  };
  result.capabilities = capabilities;
  result.verbDescriptions = verbDescriptionsForCapabilities(capabilities);
  result.message = "Work session initialized. ContextPack built. You are now in PLANNING state. "
    + "Read pack-scoped files, then submit_execution_plan or escalate for more context.";

  return {
    result,
    denyReasons,
    stateOverride: "PLANNING",
  };
}

/* ── Internal helpers ────────────────────────────────────── */

function computeActiveValidators(
  strategy: StrategySelection,
  memories: Array<{ enforcementType: string }>,
): string[] {
  const validators = ["evidence_policy"];

  if (strategy.strategyId === "migration_adp_to_sdf") {
    validators.push("migration_rule_citation");
  }

  if (memories.some((m) => m.enforcementType === "plan_rule")) {
    validators.push("plan_rule_enforcement");
  }

  validators.push("component_contract_check");
  return validators;
}

function computeEnforcementObligations(
  memories: Array<{ enforcementType: string; planRule?: { condition?: string } | null; note?: string }>,
): string[] {
  const obligations: string[] = [];
  const planRules = memories.filter((m) => m.enforcementType === "plan_rule");

  if (planRules.length > 0) {
    obligations.push(
      `${planRules.length} active plan_rule memories are enforced. Plans must satisfy their conditions.`
    );
  }

  obligations.push(
    "Plans performing migration changes MUST cite the corresponding MigrationRule in policyRefs",
  );
  obligations.push(
    "Plans referencing attachments MUST include artifactRefs for those attachments",
  );

  return obligations;
}

function describeApproach(strategyId: string): string {
  switch (strategyId) {
    case "migration_adp_to_sdf":
      return "Inventory all adp-* usage in scope files, match to MigrationRules, generate change nodes per occurrence with validation nodes per component boundary";
    case "debug_symptom_trace":
      return "Trace symptom to root cause via behavior chain, identify candidates, generate targeted validation";
    case "api_contract_feature":
      return "Anchor on Swagger endpoints and DTO symbol mappings, validate contract conformance";
    case "ui_aggrid_feature":
    default:
      return "Build origin proof chain for component, separate layer concerns, validate with shadow-aware hooks";
  }
}

function describeEscalationGuidance(strategyId: string): string {
  switch (strategyId) {
    case "migration_adp_to_sdf":
      return "If a component has no MigrationRule (status=unknown), escalate with type=artifact_fetch requesting the SDF contract for that component";
    case "debug_symptom_trace":
      return "If the symptom trace is incomplete, escalate with type=graph_expand to find more callers/callees";
    case "api_contract_feature":
      return "If API contract is missing, escalate with type=artifact_fetch requesting the Swagger spec";
    case "ui_aggrid_feature":
    default:
      return "If origin chain is incomplete, escalate with type=scope_expand to find missing module boundaries";
  }
}

function extractChainSeed(
  args: Record<string, unknown> | undefined,
  lexemes: string[],
  prompt: string,
): string | null {
  if (args?.chainSeed && typeof args.chainSeed === "string") return args.chainSeed;
  if (args?.targetFile && typeof args.targetFile === "string") return args.targetFile;
  if (args?.symbol && typeof args.symbol === "string") return args.symbol;

  for (const lex of lexemes) {
    if (lex.includes("/") || lex.includes("component") || lex.includes("grid") || lex.includes("table")) {
      return lex;
    }
  }

  const substantive = lexemes.find((l) => l.length > 3 && !["the", "and", "for", "this", "that", "with"].includes(l));
  if (substantive) return substantive;

  const trimmed = prompt.trim();
  return trimmed.length > 3 ? trimmed.slice(0, 50) : null;
}

function extractRawJiraTicket(
  artifacts: Array<{ source: string; ref: string; summary?: string; metadata?: Record<string, unknown> }>,
): Record<string, unknown> | undefined {
  const jira = artifacts.find((a) => a.source === "jira");
  if (!jira) return undefined;

  const payload = jira.metadata?.payload;
  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }

  return {
    issueKey: jira.ref,
    summary: jira.summary,
    ...jira.metadata,
  };
}

/**
 * Phase 5: Apply strategy_signal memory overrides to the base strategy selection.
 * Overrides modify the ContextSignature feature flags based on friction-derived signals.
 */
function applyStrategySignalOverrides(
  baseStrategy: StrategySelection,
  signalMemories: Array<{ strategySignal?: { featureFlag: string; value: boolean | string; reason: string } | null }>,
): StrategySelection {
  if (signalMemories.length === 0) return baseStrategy;

  // Deep-clone the context signature to apply overrides
  const overriddenSignature = { ...baseStrategy.contextSignature } as Record<string, unknown>;

  for (const memory of signalMemories) {
    if (!memory.strategySignal) continue;
    const { featureFlag, value } = memory.strategySignal;
    overriddenSignature[featureFlag] = value;
  }

  return {
    ...baseStrategy,
    contextSignature: overriddenSignature as StrategySelection["contextSignature"],
    reasons: [
      ...baseStrategy.reasons,
      ...signalMemories
        .filter((m) => m.strategySignal)
        .map((m) => ({
          reason: `strategy_signal override: ${m.strategySignal!.featureFlag} = ${m.strategySignal!.value}`,
          evidenceRef: `memory:strategy_signal`,
        })),
    ],
  };
}

/**
 * Phase 6: Scan .ai/inbox/ directory and copy files to work attachments.
 * Returns artifact records for each ingested file.
 */
function ingestInboxFiles(
  inboxDir: string,
  attachmentsDir: string,
  existingArtifacts?: Array<{ metadata?: Record<string, unknown> }>,
): Array<{ source: string; ref: string; summary: string; metadata: Record<string, unknown> }> {
  const artifacts: Array<{ source: string; ref: string; summary: string; metadata: Record<string, unknown> }> = [];

  if (!existsSync(inboxDir)) return artifacts;

  // Build set of already-ingested content hashes to deduplicate across sessions
  const alreadyIngested = new Set<string>();
  if (existingArtifacts) {
    for (const a of existingArtifacts) {
      const h = a.metadata?.contentHash;
      if (typeof h === "string") alreadyIngested.add(h);
    }
  }

  try {
    const entries = readdirSync(inboxDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // Skip already-processed files
      if (entry.name.endsWith(".processed")) continue;

      const sourcePath = path.join(inboxDir, entry.name);

      try {
        const { readFileSync, renameSync } = require("node:fs");
        const content = readFileSync(sourcePath);
        const contentHash = createHash("sha256").update(content).digest("hex");

        // Skip if content already ingested (dedupe by hash)
        if (alreadyIngested.has(contentHash)) continue;
        alreadyIngested.add(contentHash);

        const destPath = path.join(attachmentsDir, entry.name);
        copyFileSync(sourcePath, destPath);
        const stats = statSync(sourcePath);

        artifacts.push({
          source: "attachment",
          ref: `inbox:${entry.name}`,
          summary: `File from .ai/inbox/: ${entry.name} (${stats.size} bytes)`,
          metadata: {
            originalPath: sourcePath,
            copiedTo: destPath,
            fileName: entry.name,
            sizeBytes: stats.size,
            contentHash,
            ingestedAt: new Date().toISOString(),
          },
        });

        // Consume: rename to .processed so next initialize_work won't re-ingest
        try {
          renameSync(sourcePath, `${sourcePath}.processed`);
        } catch { /* rename failure is non-fatal — dedupe hash guards re-ingestion */ }
      } catch {
        // Individual file read/copy failures are non-fatal
      }
    }
  } catch {
    // Directory read failures are non-fatal
  }

  return artifacts;
}
