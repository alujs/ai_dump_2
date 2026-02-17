import { capabilitiesForState } from "../capability-gating/capabilityMatrix";
import { createContextPack } from "../context-pack/contextPackService";
import { collectRetrievalLanes } from "../context-pack/retrievalLanes";
import { ConnectorRegistry } from "../connectors/connectorRegistry";
import { MemoryPromotionService } from "../memory-promotion/memoryPromotionService";
import { EventStore } from "../observability/eventStore";
import { CollisionGuard } from "../patch-exec/collisionGuard";
import { listPatchApplyOptions } from "../patch-exec/patchExecService";
import { RecipeRegistry } from "../recipes/recipeRegistry";
import { recommendedSubAgentSplits, selectStrategy, type StrategySelection } from "../strategy/strategySelector";
import { ProofChainBuilder } from "../proof-chains/proofChainBuilder";
import { listAllowedFiles } from "../worktree-scope/worktreeScopeService";
import type { RunState, TurnRequest, TurnResponse } from "../../contracts/controller";
import type { IndexingService } from "../indexing/indexingService";
import { SCHEMA_VERSION } from "../../shared/constants";
import { resolveTargetRepoRoot, scratchRoot } from "../../shared/fsPaths";
import { ensureId, traceRef } from "../../shared/ids";
import { verbDescriptionsForCapabilities } from "../../shared/verbCatalog";

import type { SessionState, VerbResult } from "./types";
import { createSession, resolveOriginalPrompt, extractLexemes, trackRejections } from "./session";
import { consumeBudget, isBudgetSafeVerb } from "./budget";
import { extractAnchors, asStringArray, asStringRecord, moduleHint } from "./turnHelpers";
import { handleReadRange, handleReadSymbol, handleGrepLexeme, handleReadNeighbors, handleListDir } from "./handlers/readHandlers";
import { handleSubmitPlan, handleWriteTmp } from "./handlers/planHandlers";
import { handlePatchApply, handleCodeRun, handleSideEffect } from "./handlers/mutationHandlers";
import { handleFetchJira, handleFetchSwagger } from "./handlers/connectorHandlers";
import { handleRunRecipe } from "./handlers/recipeHandler";
import { handleEscalate } from "./handlers/escalateHandler";

/* ── Verbs that benefit from full context pack + retrieval ── */
const CONTEXT_PACK_VERBS = new Set([
  "submit_execution_plan", "write_scratch_file",
]);

export class TurnController {
  private readonly sessions = new Map<string, SessionState>();
  private readonly collisionGuard = new CollisionGuard();
  private readonly memoryPromotion: MemoryPromotionService;
  private readonly recipes: RecipeRegistry;
  private readonly proofChainBuilder: ProofChainBuilder | null;

  constructor(
    private readonly eventStore: EventStore,
    private readonly connectors?: ConnectorRegistry,
    private readonly indexing: IndexingService | null = null,
    memoryPromotion?: MemoryPromotionService,
    recipes?: RecipeRegistry,
    private readonly neo4jConfig?: { uri: string; username: string; password: string; database: string },
  ) {
    this.memoryPromotion = memoryPromotion ?? new MemoryPromotionService();
    this.recipes = recipes ?? new RecipeRegistry();
    this.proofChainBuilder = neo4jConfig
      ? new ProofChainBuilder({ neo4j: neo4jConfig }, indexing)
      : null;
  }

  /* ── Main dispatch ─────────────────────────────────────── */

  async handleTurn(request: TurnRequest): Promise<TurnResponse> {
    const runSessionId = ensureId(request.runSessionId, "run");
    const workId = ensureId(request.workId, "work");
    const agentId = ensureId(request.agentId, "agent");
    const sessionKey = `${runSessionId}:${workId}:${agentId}`;
    const collisionScopeKey = `${runSessionId}:${workId}`;
    const session = this.ensureSession(sessionKey, runSessionId, workId, agentId);
    const worktreeRoot = (): string => session.planGraph?.worktreeRoot ?? resolveTargetRepoRoot();

    const originalPrompt = resolveOriginalPrompt(session, request.originalPrompt, this.eventStore);
    const lexemes = extractLexemes(request);

    // Enrich strategy selection with Jira ticket fields and session artifacts [REF:CONTEXTSIGNATURE]
    const jiraSlice = (session as SessionState & { jiraSlice?: { issueType?: string; labels?: string[]; components?: string[]; summary?: string; description?: string } }).jiraSlice;
    const strategy = selectStrategy({
      originalPrompt,
      lexemes,
      artifacts: session.artifacts.map((a) => ({ source: a.source, ref: a.ref, metadata: a.metadata })),
      anchors: extractAnchors(request.args),
      jiraFields: jiraSlice ? {
        issueType: jiraSlice.issueType,
        labels: jiraSlice.labels,
        components: jiraSlice.components,
        summary: jiraSlice.summary,
        description: jiraSlice.description,
      } : undefined,
    });
    const budgetStatus = consumeBudget(session, request);

    await this.logInput(runSessionId, workId, agentId, request);

    /* ── Context pack: only on planning-relevant verbs ─── */
    let contextPackRef: string | undefined;
    let contextPackHash: string | undefined;

    if (CONTEXT_PACK_VERBS.has(request.verb)) {
      const retrievalLanes = await collectRetrievalLanes({
        queryText: `${originalPrompt}\n${lexemes.join(" ")}`,
        symbolHints: asStringArray(request.args?.symbolHints) ?? [],
        activePolicies: asStringArray(request.args?.activePolicies) ?? [],
        knownArtifacts: session.artifacts,
        indexing: this.indexing,
        events: this.eventStore,
      });

      await this.logRetrieval(runSessionId, workId, agentId, retrievalLanes as unknown as Record<string, unknown>);

      // Determine proof chain requirements from ContextSignature [REF:PROOF-CHAINS]
      const needsAgGrid = strategy.contextSignature?.mentions_aggrid
        ?? lexemes.some((l) => l.includes("ag-grid"));
      const needsFederation = strategy.contextSignature?.behind_federation_boundary
        ?? lexemes.some((l) => l.includes("federation"));

      // Auto-build proof chains when proof chain builder is available [REF:CHAIN-AGGRID] [REF:CHAIN-FEDERATION]
      let agGridProofChain: Awaited<ReturnType<ProofChainBuilder["buildAgGridOriginChain"]>> | undefined;
      let federationProofChain: Awaited<ReturnType<ProofChainBuilder["buildFederationChain"]>> | undefined;

      if (this.proofChainBuilder) {
        const chainSeed = extractChainSeed(request.args, lexemes, originalPrompt);
        if (needsAgGrid && chainSeed) {
          try {
            agGridProofChain = await this.proofChainBuilder.buildAgGridOriginChain(chainSeed);
            await this.eventStore.append({
              ts: new Date().toISOString(), type: "proof_chain_built",
              runSessionId, workId, agentId,
              payload: { chainType: "ag_grid_origin", complete: agGridProofChain.complete, links: agGridProofChain.chain.length, missingLinks: agGridProofChain.missingLinks },
            });
          } catch { /* chain build failures are non-fatal; reported via insufficiency */ }
        }
        if (needsFederation && chainSeed) {
          try {
            federationProofChain = await this.proofChainBuilder.buildFederationChain(chainSeed);
            await this.eventStore.append({
              ts: new Date().toISOString(), type: "proof_chain_built",
              runSessionId, workId, agentId,
              payload: { chainType: "federation", complete: federationProofChain.complete, links: federationProofChain.chain.length, missingLinks: federationProofChain.missingLinks },
            });
          } catch { /* chain build failures are non-fatal */ }
        }
      }

      // Extract raw Jira ticket from session artifacts [REF:CP-SECTIONS]
      const rawJiraTicket = extractRawJiraTicket(session.artifacts);

      const packOutput = await createContextPack({
        runSessionId, workId, originalPrompt,
        strategyId: strategy.strategyId,
        strategyReasons: strategy.reasons,
        taskConstraints: asStringArray(request.args?.taskConstraints) ?? [],
        conflicts: asStringArray(request.args?.conflicts) ?? [],
        activePolicies: asStringArray(request.args?.activePolicies) ?? [],
        policyVersionSet: asStringRecord(request.args?.policyVersionSet),
        allowedFiles: listAllowedFiles(workId, session.scopeAllowlist, worktreeRoot()),
        allowedCapabilities: capabilitiesForState(budgetStatus.blocked ? "BLOCKED_BUDGET" : session.state),
        validationPlan: asStringArray(request.args?.validationPlan) ?? [],
        missingness: asStringArray(request.args?.missingness) ?? [],
        retrievalLanes,
        executionOptions: { patchApply: listPatchApplyOptions() },
        schemaLinks: [
          ".ai/config/schema.json",
          "src/contracts/controller.ts",
          "src/contracts/planGraph.ts",
          ".ai/mcp-controller/specs/ast_codemod_policy.md",
        ],
        anchors: extractAnchors(request.args),
        requiresAgGridProof: needsAgGrid,
        requiresFederationProof: needsFederation,
        rawJiraTicket,
        agGridProofChain,
        federationProofChain,
      });

      contextPackRef = packOutput.contextPackRef;
      contextPackHash = packOutput.contextPackHash;

      if (packOutput.insufficiency) {
        const response = this.makeResponse({
          runSessionId, workId, agentId,
          state: budgetStatus.blocked ? "BLOCKED_BUDGET" : "PLAN_REQUIRED",
          strategy, result: {
            message: "Context pack is insufficient for execution-safe planning.",
            contextPackRef, contextPackHash,
          },
          denyReasons: ["PACK_INSUFFICIENT", "PACK_REQUIRED_ANCHOR_UNRESOLVED"],
          outcome: "pack_insufficient",
          packInsufficiency: packOutput.insufficiency,
          budgetStatus, scopeWorktreeRoot: worktreeRoot(),
        });
        await this.logTurn("pack_insufficient", request.verb, response, request.args);
        session.state = response.state;
        this.sessions.set(sessionKey, session);
        return response;
      }
    }

    session.actionCounts[request.verb] = (session.actionCounts[request.verb] ?? 0) + 1;

    /* ── Budget gate ──────────────────────────────────────── */
    if (budgetStatus.blocked && !isBudgetSafeVerb(request.verb)) {
      const response = this.makeResponse({
        runSessionId, workId, agentId,
        state: "BLOCKED_BUDGET", strategy,
        result: { message: "Token budget threshold exceeded. Use list_available_verbs/get_original_prompt/request_evidence_guidance.", contextPackRef, contextPackHash },
        denyReasons: ["BUDGET_THRESHOLD_EXCEEDED"],
        budgetStatus, scopeWorktreeRoot: worktreeRoot(),
      });
      trackRejections(session, response.denyReasons);
      session.state = "BLOCKED_BUDGET";
      this.sessions.set(sessionKey, session);
      await this.finalizeTurn(session, request, response);
      return response;
    }

    /* ── Verb dispatch ────────────────────────────────────── */
    const state = budgetStatus.blocked ? "BLOCKED_BUDGET" : session.state;
    const verbResult = await this.dispatchVerb(request.verb, request.args, session, state, collisionScopeKey, workId, worktreeRoot());

    const mergedResult: Record<string, unknown> = { ...verbResult.result };
    if (contextPackRef) mergedResult.contextPackRef = contextPackRef;
    if (contextPackHash) mergedResult.contextPackHash = contextPackHash;

    const finalState = verbResult.stateOverride ?? state;
    trackRejections(session, verbResult.denyReasons);

    const response = this.makeResponse({
      runSessionId, workId, agentId,
      state: finalState, strategy,
      result: mergedResult,
      denyReasons: verbResult.denyReasons,
      budgetStatus, scopeWorktreeRoot: worktreeRoot(),
    });

    session.state = finalState;
    this.sessions.set(sessionKey, session);
    await this.finalizeTurn(session, request, response);
    return response;
  }

  /* ── Public query helpers ──────────────────────────────── */

  runSummaries(): Array<{ runSessionId: string; workId: string; agentId: string; state: RunState }> {
    return [...this.sessions.values()].map((s) => ({
      runSessionId: s.runSessionId, workId: s.workId, agentId: s.agentId, state: s.state,
    }));
  }

  async listMemoryPromotions(): Promise<Array<Record<string, unknown>>> {
    return (await this.memoryPromotion.list()).map((item) => ({ ...item }));
  }

  /* ── Private: verb dispatch ────────────────────────────── */

  private async dispatchVerb(
    verb: string,
    args: Record<string, unknown> | undefined,
    session: SessionState,
    state: RunState,
    collisionScopeKey: string,
    workId: string,
    worktreeRoot: string
  ): Promise<VerbResult> {
    switch (verb) {
      case "submit_execution_plan":
        return handleSubmitPlan(args, session, state);
      case "write_scratch_file":
        return handleWriteTmp(workId, args);
      case "read_file_lines":
        return handleReadRange(args, session);
      case "lookup_symbol_definition":
        return handleReadSymbol(args, this.indexing);
      case "search_codebase_text":
        return handleGrepLexeme(args, this.indexing);
      case "trace_symbol_graph":
        return handleReadNeighbors(args, this.indexing);
      case "list_scoped_files":
        return { result: { allowedFiles: listAllowedFiles(workId, session.scopeAllowlist, worktreeRoot) }, denyReasons: [] };
      case "list_directory_contents":
        return handleListDir(args, session);
      case "apply_code_patch":
        return handlePatchApply(collisionScopeKey, args, session, this.collisionGuard, state);
      case "run_sandboxed_code":
        return handleCodeRun(collisionScopeKey, args, session, this.collisionGuard, state);
      case "execute_gated_side_effect":
        return handleSideEffect(collisionScopeKey, args, session, this.collisionGuard, state);
      case "fetch_jira_ticket":
        return handleFetchJira(args, session, this.connectors);
      case "fetch_api_spec":
        return handleFetchSwagger(args, session, this.connectors);
      case "request_evidence_guidance":
        return handleEscalate(args, session, this.eventStore);
      case "get_original_prompt":
        return { result: { originalPrompt: session.originalPrompt }, denyReasons: [] };
      case "run_automation_recipe":
        return handleRunRecipe(args, session, this.eventStore, this.recipes);
      case "list_available_verbs": {
        const available = capabilitiesForState(state);
        return { result: { available, verbDescriptions: verbDescriptionsForCapabilities(available) }, denyReasons: [] };
      }
      default: {
        const allowed = capabilitiesForState(state);
        if (!allowed.includes(verb)) {
          return {
            result: {
              error: `Verb '${verb}' is not allowed in current run-state '${state}'. Allowed verbs for this state: [${allowed.join(", ")}]. Change to one of those or advance the run-state first.`,
              allowedVerbs: allowed,
              currentState: state,
            },
            denyReasons: ["PLAN_SCOPE_VIOLATION"],
          };
        }
        return {
          result: {
            error: `Verb '${verb}' is recognized and allowed in state '${state}' but has no handler implementation. This is a controller bug — report it. As a workaround, use a different verb from: [${allowed.join(", ")}].`,
            allowedVerbs: allowed,
          },
          denyReasons: [],
        };
      }
    }
  }

  /* ── Private: session helpers ──────────────────────────── */

  private ensureSession(key: string, runSessionId: string, workId: string, agentId: string): SessionState {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    return createSession(runSessionId, workId, agentId);
  }

  /* ── Private: response construction ────────────────────── */

  private makeResponse(input: {
    runSessionId: string;
    workId: string;
    agentId: string;
    scopeWorktreeRoot: string;
    state: RunState;
    strategy: StrategySelection;
    result: Record<string, unknown>;
    denyReasons: string[];
    budgetStatus: TurnResponse["budgetStatus"];
    outcome?: "pack_insufficient";
    packInsufficiency?: TurnResponse["packInsufficiency"];
  }): TurnResponse {
    const caps = capabilitiesForState(input.state);
    const response: TurnResponse = {
      runSessionId: input.runSessionId,
      workId: input.workId,
      agentId: input.agentId,
      state: input.state,
      outcome: input.outcome,
      capabilities: caps,
      verbDescriptions: verbDescriptionsForCapabilities(caps),
      scope: { worktreeRoot: input.scopeWorktreeRoot, scratchRoot: scratchRoot(input.workId) },
      result: input.result,
      denyReasons: input.denyReasons,
      knowledgeStrategy: {
        strategyId: input.strategy.strategyId,
        contextSignature: input.strategy.contextSignature as unknown as Record<string, unknown>,
        reasons: input.strategy.reasons,
      },
      budgetStatus: input.budgetStatus,
      traceRef: traceRef(),
      schemaVersion: SCHEMA_VERSION,
      subAgentHints: { recommended: true, suggestedSplits: recommendedSubAgentSplits(input.strategy.strategyId) },
      packInsufficiency: input.packInsufficiency,
    };

    // Proactive suggestion: tell the agent what to do when something is denied
    if (input.denyReasons.length > 0) {
      response.suggestedAction = deriveSuggestedAction(input.denyReasons, input.outcome);
    }

    return response;
  }

  /* ── Private: observability & memory ───────────────────── */

  private async finalizeTurn(session: SessionState, request: TurnRequest, response: TurnResponse): Promise<void> {
    await this.logTurn("turn", request.verb, response, request.args);
    await this.emitCorrectionCandidateIfNeeded(session, response);
    await this.runMemoryPromotionLane(session);
    await this.logOutput(response, request.verb);
  }

  private async emitCorrectionCandidateIfNeeded(session: SessionState, response: TurnResponse): Promise<void> {
    for (const code of response.denyReasons) {
      if ((session.rejectionCounts[code] ?? 0) >= 3) {
        await this.eventStore.append({
          ts: new Date().toISOString(), type: "pending_correction_created",
          runSessionId: session.runSessionId, workId: session.workId, agentId: session.agentId,
          payload: { rejectionCode: code, count: session.rejectionCounts[code] },
        });
        await this.memoryPromotion.createPending({
          kind: "strategy_hint", traceRef: response.traceRef,
          reason: `Repeated rejection code ${code}`,
          metadata: { rejectionCode: code, rejectionCount: session.rejectionCounts[code], strategy: response.knowledgeStrategy.strategyId },
        });
      }
    }
  }

  private async runMemoryPromotionLane(session: SessionState): Promise<void> {
    const transitioned = await this.memoryPromotion.runAutoPromotion();
    for (const item of transitioned) {
      await this.eventStore.append({
        ts: new Date().toISOString(), type: "memory_promotion_transition",
        runSessionId: session.runSessionId, workId: session.workId, agentId: session.agentId,
        payload: { id: item.id, kind: item.kind, state: item.state, traceRef: item.traceRef },
      });
    }
  }

  /* ── Private: structured logging ───────────────────────── */

  private async logInput(runSessionId: string, workId: string, agentId: string, request: TurnRequest): Promise<void> {
    await this.eventStore.append({
      ts: new Date().toISOString(), type: "input_envelope",
      runSessionId, workId, agentId,
      payload: { verb: request.verb, argsKeys: Object.keys(request.args ?? {}) },
    });
  }

  private async logRetrieval(runSessionId: string, workId: string, agentId: string, lanes: Record<string, unknown>): Promise<void> {
    await this.eventStore.append({
      ts: new Date().toISOString(), type: "retrieval_trace",
      runSessionId, workId, agentId,
      payload: Object.fromEntries(Object.entries(lanes).map(([k, v]) => [`${k}Hits`, Array.isArray(v) ? v.length : 0])),
    });
  }

  private async logTurn(type: string, verb: string, response: TurnResponse, args: Record<string, unknown> | undefined): Promise<void> {
    await this.eventStore.append({
      ts: new Date().toISOString(), type,
      runSessionId: response.runSessionId, workId: response.workId, agentId: response.agentId,
      payload: {
        verb, state: response.state, denyReasons: response.denyReasons,
        strategy: response.knowledgeStrategy.strategyId, outcome: response.outcome,
        module: moduleHint(args), packMissingAnchors: response.packInsufficiency?.missingAnchors ?? [],
      },
    });
  }

  private async logOutput(response: TurnResponse, verb: string): Promise<void> {
    await this.eventStore.append({
      ts: new Date().toISOString(), type: "output_envelope",
      runSessionId: response.runSessionId, workId: response.workId, agentId: response.agentId,
      payload: { verb, state: response.state, denyReasons: response.denyReasons, outcome: response.outcome },
    });
  }
}

/* ── Module-level helpers ────────────────────────────────── */

import type { ConnectorArtifact } from "../connectors/connectorRegistry";

/**
 * Given a set of deny reasons, tell the agent what verb to call next.
 * This is the "you should escalate" signal the spec requires.
 */
function deriveSuggestedAction(
  denyReasons: string[],
  outcome?: string,
): TurnResponse["suggestedAction"] {
  if (denyReasons.includes("PACK_INSUFFICIENT") || denyReasons.includes("PACK_REQUIRED_ANCHOR_UNRESOLVED")) {
    return {
      verb: "request_evidence_guidance",
      reason: "Context pack is insufficient — the controller cannot build a safe execution context. Call request_evidence_guidance with the blocking reasons to get targeted guidance on what evidence to gather.",
      args: { blockingReasons: denyReasons },
    };
  }
  if (denyReasons.includes("PLAN_EVIDENCE_INSUFFICIENT")) {
    return {
      verb: "request_evidence_guidance",
      reason: "Your plan was denied because it lacks sufficient evidence (minimum 2 distinct sources required). Call request_evidence_guidance to get guidance on which verbs to use for evidence gathering.",
      args: { blockingReasons: ["PLAN_EVIDENCE_INSUFFICIENT"] },
    };
  }
  if (denyReasons.includes("BUDGET_THRESHOLD_EXCEEDED")) {
    return {
      verb: "request_evidence_guidance",
      reason: "Token budget exceeded. Call request_evidence_guidance to report your progress and get next steps.",
      args: { blockingReasons: ["BUDGET_THRESHOLD_EXCEEDED"] },
    };
  }
  if (denyReasons.includes("PLAN_SCOPE_VIOLATION")) {
    return {
      verb: "list_available_verbs",
      reason: "The verb you tried is not allowed in the current run-state. Call list_available_verbs to see what verbs are available.",
    };
  }
  // Generic fallback for any other deny
  return {
    verb: "request_evidence_guidance",
    reason: `Request denied: [${denyReasons.join(", ")}]. Call request_evidence_guidance to get guidance.`,
    args: { blockingReasons: denyReasons },
  };
}

/**
 * Extract a seed for proof chain traversal from request args, lexemes, or prompt.
 * The seed is the most specific identifier we can find (symbol, file, route, etc.)
 */
function extractChainSeed(
  args: Record<string, unknown> | undefined,
  lexemes: string[],
  prompt: string,
): string | null {
  // Explicit seed from args
  if (args?.chainSeed && typeof args.chainSeed === "string") return args.chainSeed;
  if (args?.targetFile && typeof args.targetFile === "string") return args.targetFile;
  if (args?.symbol && typeof args.symbol === "string") return args.symbol;

  // Look for specific patterns in lexemes (route-like, component-like, grid-like)
  for (const lex of lexemes) {
    if (lex.includes("/") || lex.includes("component") || lex.includes("grid") || lex.includes("table")) {
      return lex;
    }
  }

  // Fall back to first non-trivial lexeme
  const substantive = lexemes.find((l) => l.length > 3 && !["the", "and", "for", "this", "that", "with"].includes(l));
  if (substantive) return substantive;

  // Last resort: use first 50 chars of prompt as search seed
  const trimmed = prompt.trim();
  return trimmed.length > 3 ? trimmed.slice(0, 50) : null;
}

/**
 * Extract the raw Jira ticket payload from session artifacts.
 * This is stored verbatim in the context pack per [REF:CP-SECTIONS] TaskSpec.
 */
function extractRawJiraTicket(
  artifacts: ConnectorArtifact[],
): Record<string, unknown> | undefined {
  const jira = artifacts.find((a) => a.source === "jira");
  if (!jira) return undefined;

  const payload = (jira.metadata as Record<string, unknown>)?.payload;
  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }

  // Return the whole metadata as fallback
  return {
    issueKey: jira.ref,
    summary: jira.summary,
    ...jira.metadata,
  };
}
