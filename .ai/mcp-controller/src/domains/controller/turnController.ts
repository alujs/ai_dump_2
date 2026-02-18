import { capabilitiesForState } from "../capability-gating/capabilityMatrix";
import { ConnectorRegistry } from "../connectors/connectorRegistry";
import { MemoryService } from "../memory/memoryService";
import { EventStore } from "../observability/eventStore";
import { CollisionGuard } from "../patch-exec/collisionGuard";
import { RecipeRegistry } from "../recipes/recipeRegistry";
import { recommendedSubAgentSplits, selectStrategy, type StrategySelection, type StrategyId } from "../strategy/strategySelector";
import { ProofChainBuilder } from "../proof-chains/proofChainBuilder";
import type { RunState, TurnRequest, TurnResponse } from "../../contracts/controller";
import type { IndexingService } from "../indexing/indexingService";
import { SCHEMA_VERSION } from "../../shared/constants";
import { resolveTargetRepoRoot, scratchRoot } from "../../shared/fsPaths";
import { ensureId, traceRef } from "../../shared/ids";
import { verbDescriptionsForCapabilities } from "../../shared/verbCatalog";

import type { SessionState, VerbResult } from "./types";
import { createSession, resolveOriginalPrompt, extractLexemes, trackRejections, resolveAgentId } from "./session";
import { consumeBudget, isBudgetSafeVerb } from "./budget";
import { extractAnchors, asStringArray, moduleHint } from "./turnHelpers";
import { handleReadRange, handleReadSymbol, handleGrepLexeme, handleReadNeighbors } from "./handlers/readHandlers";
import { handleSubmitPlan, handleWriteTmp } from "./handlers/planHandlers";
import { handlePatchApply, handleCodeRun, handleSideEffect } from "./handlers/mutationHandlers";
import { handleRunRecipe } from "./handlers/recipeHandler";
import { handleEscalate } from "./handlers/escalateHandler";
import { handleSignalTaskComplete } from "./handlers/retrospectiveHandler";
import { handleInitializeWork } from "./handlers/initializeWorkHandler";

export class TurnController {
  private readonly sessions = new Map<string, SessionState>();
  private readonly collisionGuard = new CollisionGuard();
  private readonly memoryService: MemoryService;
  private readonly recipes: RecipeRegistry;
  private readonly proofChainBuilder: ProofChainBuilder | null;

  constructor(
    private readonly eventStore: EventStore,
    private readonly connectors?: ConnectorRegistry,
    private readonly indexing: IndexingService | null = null,
    memoryService?: MemoryService,
    recipes?: RecipeRegistry,
    private readonly neo4jConfig?: { uri: string; username: string; password: string; database: string },
  ) {
    this.memoryService = memoryService ?? new MemoryService();
    this.recipes = recipes ?? new RecipeRegistry();
    this.proofChainBuilder = neo4jConfig
      ? new ProofChainBuilder({ neo4j: neo4jConfig }, indexing)
      : null;
  }

  /* ── Main dispatch ─────────────────────────────────────── */

  async handleTurn(request: TurnRequest): Promise<TurnResponse> {
    const runSessionId = ensureId(request.runSessionId, "run");
    const workId = ensureId(request.workId, "work");
    const agentId = resolveAgentId(request.agentId) || ensureId(request.agentId, "agent");
    const sessionKey = `${runSessionId}:${workId}:${agentId}`;
    const collisionScopeKey = `${runSessionId}:${workId}`;
    const session = this.ensureSession(sessionKey, runSessionId, workId, agentId, collisionScopeKey);
    const worktreeRoot = (): string => session.planGraph?.worktreeRoot ?? resolveTargetRepoRoot();

    const originalPrompt = resolveOriginalPrompt(session, request.originalPrompt, this.eventStore);
    const lexemes = extractLexemes(request);

    // Strategy selection — used for response envelope (initialize_work does its own)
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

    session.actionCounts[request.verb] = (session.actionCounts[request.verb] ?? 0) + 1;

    /* ── Budget gate ──────────────────────────────────────── */
    if (budgetStatus.blocked && !isBudgetSafeVerb(request.verb)) {
      const response = this.makeResponse({
        runSessionId, workId, agentId,
        state: "BLOCKED_BUDGET", strategy,
        result: { message: "Token budget threshold exceeded. Use escalate or signal_task_complete." },
        denyReasons: ["BUDGET_THRESHOLD_EXCEEDED"],
        budgetStatus, scopeWorktreeRoot: worktreeRoot(),
        session,
        verb: request.verb,
        previousState: session.state,
      });
      trackRejections(session, response.denyReasons);
      session.state = "BLOCKED_BUDGET";
      this.sessions.set(sessionKey, session);
      await this.finalizeTurn(session, request, response);
      return response;
    }

    /* ── Verb dispatch ────────────────────────────────────── */
    const state = budgetStatus.blocked ? "BLOCKED_BUDGET" : session.state;
    const verbResult = await this.dispatchVerb(request.verb, request.args, session, state, collisionScopeKey, workId, worktreeRoot(), this.memoryService);

    const mergedResult: Record<string, unknown> = { ...verbResult.result };

    // #15 fix: If budget is blocked, clamp state to BLOCKED_BUDGET unless terminal (COMPLETED/FAILED)
    let finalState = verbResult.stateOverride ?? state;
    if (budgetStatus.blocked && finalState !== "COMPLETED" && finalState !== "FAILED") {
      finalState = "BLOCKED_BUDGET";
    }
    trackRejections(session, verbResult.denyReasons);

    // #12 fix: For initialize_work, use the handler's strategy (single source of truth)
    // instead of the pre-computed envelope strategy that doesn't include overrides
    const responseStrategy = (request.verb === "initialize_work" && mergedResult.strategy)
      ? {
          strategyId: (mergedResult.strategy as Record<string, unknown>).strategyId as StrategyId,
          contextSignature: strategy.contextSignature,
          reasons: strategy.reasons,
        }
      : strategy;

    const response = this.makeResponse({
      runSessionId, workId, agentId,
      state: finalState, strategy: responseStrategy,
      result: mergedResult,
      denyReasons: verbResult.denyReasons,
      budgetStatus, scopeWorktreeRoot: worktreeRoot(),
      session,
      verb: request.verb,
      previousState: state,
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
    return (await this.memoryService.listAll()).map((item) => ({ ...item } as Record<string, unknown>));
  }

  /* ── Private: verb dispatch ────────────────────────────── */

  private async dispatchVerb(
    verb: string,
    args: Record<string, unknown> | undefined,
    session: SessionState,
    state: RunState,
    collisionScopeKey: string,
    workId: string,
    worktreeRoot: string,
    memoryService?: MemoryService,
  ): Promise<VerbResult> {
    /* ── Hard capability gate (Architecture v2 invariant #1 + #3) ── */
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

    switch (verb) {
      case "initialize_work":
        return handleInitializeWork(args, session, {
          eventStore: this.eventStore,
          indexing: this.indexing,
          memoryService: this.memoryService,
          connectors: this.connectors,
          proofChainBuilder: this.proofChainBuilder,
        });
      case "submit_execution_plan":
        return handleSubmitPlan(args, session, state, memoryService);
      case "write_scratch_file":
        return handleWriteTmp(workId, args);
      case "read_file_lines":
        return handleReadRange(args, session);
      case "lookup_symbol_definition":
        return handleReadSymbol(args, this.indexing, session);
      case "search_codebase_text":
        return handleGrepLexeme(args, this.indexing, session);
      case "trace_symbol_graph":
        return handleReadNeighbors(args, this.indexing, this.memoryService, session);
      case "apply_code_patch":
        return handlePatchApply(collisionScopeKey, args, session, this.collisionGuard, state);
      case "run_sandboxed_code":
        return handleCodeRun(collisionScopeKey, args, session, this.collisionGuard, state);
      case "execute_gated_side_effect":
        return handleSideEffect(collisionScopeKey, args, session, this.collisionGuard, state);
      case "escalate":
        return handleEscalate(args, session, { eventStore: this.eventStore, indexing: this.indexing });
      case "run_automation_recipe":
        return handleRunRecipe(args, session, this.eventStore, this.recipes);
      case "signal_task_complete":
        return handleSignalTaskComplete(args, session, this.eventStore, this.memoryService);
      default: {
        // Pre-gate already confirmed the verb is allowed in current state,
        // so reaching here means the verb is valid but has no handler implementation.
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

  private ensureSession(key: string, runSessionId: string, workId: string, agentId: string, workScopeKey?: string): SessionState {
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const session = createSession(runSessionId, workId, agentId);

    // Phase 7: Share contextPack and planGraph from sibling agents in the same workId
    if (workScopeKey) {
      for (const [siblingKey, siblingSession] of this.sessions) {
        if (siblingKey.startsWith(workScopeKey + ":") && siblingKey !== key) {
          // Copy shared state from sibling (contextPack, planGraph, planGraphProgress, state, originalPrompt)
          if (siblingSession.contextPack) session.contextPack = siblingSession.contextPack;
          if (siblingSession.planGraph) session.planGraph = siblingSession.planGraph;
          if (siblingSession.planGraphProgress) session.planGraphProgress = { ...siblingSession.planGraphProgress };
          if (siblingSession.originalPrompt) session.originalPrompt = siblingSession.originalPrompt;
          if (siblingSession.scopeAllowlist) session.scopeAllowlist = siblingSession.scopeAllowlist;
          // Inherit state progression — new agent shouldn't start at UNINITIALIZED if work is already initialized
          if (siblingSession.state !== "UNINITIALIZED") session.state = siblingSession.state;
          break; // Only need one sibling
        }
      }
    }

    return session;
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
    session?: SessionState;
    verb?: string;
    previousState?: RunState;
  }): TurnResponse {
    const caps = capabilitiesForState(input.state);

    // High-signal: only include full verbDescriptions on initialize_work
    // and state transitions — subsequent same-state turns don't need the catalog repeated
    const stateChanged = input.previousState !== undefined && input.previousState !== input.state;
    const isInit = input.verb === "initialize_work";
    const verbDescriptions = (isInit || stateChanged)
      ? verbDescriptionsForCapabilities(caps)
      : {};

    // Compute progress from session's planGraphProgress
    const pgProgress = input.session?.planGraphProgress;
    const totalNodes = pgProgress?.totalNodes ?? 0;
    const completedNodes = pgProgress?.completedNodes ?? 0;

    // Compute pending validations from plan graph
    const pendingValidations: Array<{ nodeId: string; status: string }> = [];
    if (input.session?.planGraph?.nodes && pgProgress) {
      const completedSet = new Set(pgProgress.completedNodeIds);
      for (const node of input.session.planGraph.nodes) {
        if (node.kind === "validate" && !completedSet.has(node.nodeId)) {
          pendingValidations.push({ nodeId: node.nodeId, status: "not_started" });
        }
      }
    }

    const progress: TurnResponse["progress"] = {
      totalNodes,
      completedNodes,
      remainingNodes: Math.max(0, totalNodes - completedNodes),
      pendingValidations,
    };

    const response: TurnResponse = {
      runSessionId: input.runSessionId,
      workId: input.workId,
      agentId: input.agentId,
      state: input.state,
      outcome: input.outcome,
      capabilities: caps,
      verbDescriptions,
      scope: { worktreeRoot: input.scopeWorktreeRoot, scratchRoot: scratchRoot(input.workId) },
      result: input.result,
      denyReasons: input.denyReasons,
      originalPrompt: input.session?.originalPrompt ?? "",
      knowledgeStrategy: {
        strategyId: input.strategy.strategyId,
        contextSignature: input.strategy.contextSignature as unknown as Record<string, unknown>,
        reasons: input.strategy.reasons,
      },
      progress,
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

        // Derive domain anchors from the session's scope
        const domainAnchorIds = session.scopeAllowlist
          ? Object.keys(session.scopeAllowlist).slice(0, 5).map((f) => {
              const parts = f.replace(/\\/g, "/").split("/");
              return parts.length > 1 ? `anchor:${parts.slice(0, 2).join("/")}` : `anchor:${parts[0]}`;
            })
          : [];

        await this.memoryService.createFromFriction({
          trigger: "rejection_pattern",
          phase: response.state === "PLAN_ACCEPTED" ? "execution" : "planning",
          domainAnchorIds,
          rejectionCodes: [code],
          originStrategyId: response.knowledgeStrategy.strategyId,
          enforcementType: "strategy_signal",
          strategySignal: {
            featureFlag: `friction_${code.toLowerCase()}`,
            value: true,
            reason: `Repeated rejection code ${code} (${session.rejectionCounts[code]}x)`,
          },
          traceRef: response.traceRef,
          sessionId: session.runSessionId,
          workId: session.workId,
          agentId: session.agentId,
          metadata: { rejectionCode: code, rejectionCount: session.rejectionCounts[code] },
        });
      }
    }
  }

  private async runMemoryPromotionLane(session: SessionState): Promise<void> {
    const transitioned = await this.memoryService.runAutoPromotion();
    for (const item of transitioned) {
      await this.eventStore.append({
        ts: new Date().toISOString(), type: "memory_promotion_transition",
        runSessionId: session.runSessionId, workId: session.workId, agentId: session.agentId,
        payload: { id: item.id, enforcementType: item.enforcementType, state: item.state, traceRef: item.traceRef },
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
      verb: "escalate",
      reason: "Context pack is insufficient. Call escalate with your need to request additional context.",
      args: { need: denyReasons.join("; "), type: "pack_rebuild" },
    };
  }
  if (denyReasons.includes("PACK_SCOPE_VIOLATION")) {
    return {
      verb: "escalate",
      reason: "The file you requested is not in the contextPack. Call escalate to request it be added.",
      args: { need: "File not in pack", type: "scope_expand" },
    };
  }
  if (denyReasons.includes("PLAN_EVIDENCE_INSUFFICIENT")) {
    return {
      verb: "escalate",
      reason: "Your plan was denied because it lacks sufficient evidence (minimum 2 distinct sources required). Call escalate to request more context.",
      args: { need: "More evidence sources needed", type: "artifact_fetch" },
    };
  }
  if (denyReasons.includes("PLAN_MIGRATION_RULE_MISSING")) {
    return {
      verb: "escalate",
      reason: "Migration strategy requires every change node to cite a MigrationRule in policyRefs (prefix 'migration:'). Add migration rule citations or escalate with type='artifact_fetch' to find the applicable MigrationRule.",
      args: { need: "MigrationRule citation for change nodes", type: "artifact_fetch" },
    };
  }
  if (denyReasons.includes("BUDGET_THRESHOLD_EXCEEDED")) {
    return {
      verb: "signal_task_complete",
      reason: "Token budget exceeded. Call signal_task_complete to wrap up.",
    };
  }
  if (denyReasons.includes("PLAN_SCOPE_VIOLATION")) {
    return {
      verb: "escalate",
      reason: "The verb you tried is not allowed in the current run-state. Check capabilities in the response envelope.",
    };
  }
  // Generic fallback
  return {
    verb: "escalate",
    reason: `Request denied: [${denyReasons.join(", ")}]. Call escalate to request guidance.`,
    args: { need: denyReasons.join("; ") },
  };
}
