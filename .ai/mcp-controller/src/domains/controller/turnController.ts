import path from "node:path";
import { capabilitiesForState, canExecuteMutation } from "../capability-gating/capabilityMatrix";
import { createContextPack } from "../context-pack/contextPackService";
import { collectRetrievalLanes } from "../context-pack/retrievalLanes";
import type { ConnectorArtifact } from "../connectors/connectorRegistry";
import { ConnectorRegistry } from "../connectors/connectorRegistry";
import { executeCodeRun, type CodeRunRequest } from "../code-run/codeRunService";
import { MemoryPromotionService } from "../memory-promotion/memoryPromotionService";
import { EventStore } from "../observability/eventStore";
import { CollisionGuard, type IntendedEffectSet } from "../patch-exec/collisionGuard";
import { codemodCitationToken } from "../patch-exec/astCodemodCatalog";
import { applyStructuredPatch, listPatchApplyOptions, type PatchApplyRequest } from "../patch-exec/patchExecService";
import { validatePlanGraph } from "../plan-graph/planGraphValidator";
import { RecipeRegistry, buildRecipeUsageEvent } from "../recipes/recipeRegistry";
import { recommendedSubAgentSplits, selectStrategy, type StrategySelection } from "../strategy/strategySelector";
import {
  listAllowedFiles,
  loadScopeAllowlist,
  scopeAllowsFile,
  scopeAllowsSymbols,
  type ScopeAllowlist
} from "../worktree-scope/worktreeScopeService";
import type { RunState, TurnRequest, TurnResponse } from "../../contracts/controller";
import type { ChangePlanNode, PlanGraphDocument, SideEffectPlanNode } from "../../contracts/planGraph";
import type { IndexingService } from "../indexing/indexingService";
import { DEFAULT_BUDGET_THRESHOLD_PERCENT, DEFAULT_MAX_TOKENS, SCHEMA_VERSION } from "../../shared/constants";
import { readText, writeText } from "../../shared/fileStore";
import { normalizeSafePath, resolveTargetRepoRoot, scratchRoot, workRoot } from "../../shared/fsPaths";
import { repoSnapshotId } from "../../infrastructure/git/repoSnapshot";
import { writeArtifactBundle } from "../../shared/artifacts";
import { ensureId, traceRef } from "../../shared/ids";

interface SessionState {
  runSessionId: string;
  workId: string;
  agentId: string;
  state: RunState;
  originalPrompt: string;
  rejectionCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  usedTokens: number;
  planGraph?: PlanGraphDocument;
  scopeAllowlist: ScopeAllowlist | null;
  artifacts: ConnectorArtifact[];
}

export class TurnController {
  private readonly sessions = new Map<string, SessionState>();
  private readonly collisionGuard = new CollisionGuard();
  private readonly memoryPromotion: MemoryPromotionService;
  private readonly recipes: RecipeRegistry;

  constructor(
    private readonly eventStore: EventStore,
    private readonly connectors?: ConnectorRegistry,
    private readonly indexing: IndexingService | null = null,
    memoryPromotion?: MemoryPromotionService,
    recipes?: RecipeRegistry
  ) {
    this.memoryPromotion = memoryPromotion ?? new MemoryPromotionService();
    this.recipes = recipes ?? new RecipeRegistry();
  }

  async handleTurn(request: TurnRequest): Promise<TurnResponse> {
    const runSessionId = ensureId(request.runSessionId, "run");
    const workId = ensureId(request.workId, "work");
    const agentId = ensureId(request.agentId, "agent");
    const sessionKey = `${runSessionId}:${workId}:${agentId}`;
    const collisionScopeKey = `${runSessionId}:${workId}`;
    const current = this.ensureSessionState(sessionKey, runSessionId, workId, agentId);
    const activeWorktreeRoot = (): string => current.planGraph?.worktreeRoot ?? resolveTargetRepoRoot();

    const originalPrompt = this.resolveOriginalPrompt(current, request.originalPrompt);
    const lexemes = this.extractLexemes(request);
    const strategy = selectStrategy({ originalPrompt, lexemes });
    const budgetStatus = this.consumeBudget(current, request);

    await this.eventStore.append({
      ts: new Date().toISOString(),
      type: "input_envelope",
      runSessionId,
      workId,
      agentId,
      payload: {
        verb: request.verb,
        state: current.state,
        argsKeys: Object.keys(request.args ?? {})
      }
    });

    const retrievalLanes = await collectRetrievalLanes({
      queryText: `${originalPrompt}\n${lexemes.join(" ")}`,
      symbolHints: asStringArray(request.args?.symbolHints) ?? [],
      activePolicies: asStringArray(request.args?.activePolicies) ?? [],
      knownArtifacts: current.artifacts,
      indexing: this.indexing,
      events: this.eventStore
    });

    await this.eventStore.append({
      ts: new Date().toISOString(),
      type: "retrieval_trace",
      runSessionId,
      workId,
      agentId,
      payload: {
        lexicalHits: retrievalLanes.lexicalLane.length,
        symbolHits: retrievalLanes.symbolLane.length,
        policyHits: retrievalLanes.policyLane.length,
        artifactHits: retrievalLanes.artifactLane.length,
        episodicHits: retrievalLanes.episodicMemoryLane.length
      }
    });

    const packOutput = await createContextPack({
      runSessionId,
      workId,
      originalPrompt,
      strategyId: strategy.strategyId,
      strategyReasons: strategy.reasons,
      taskConstraints: asStringArray(request.args?.taskConstraints) ?? [],
      conflicts: asStringArray(request.args?.conflicts) ?? [],
      activePolicies: asStringArray(request.args?.activePolicies) ?? [],
      policyVersionSet: asStringRecord(request.args?.policyVersionSet),
      allowedFiles: listAllowedFiles(workId, current.scopeAllowlist, activeWorktreeRoot()),
      allowedCapabilities: capabilitiesForState(budgetStatus.blocked ? "BLOCKED_BUDGET" : current.state),
      validationPlan: asStringArray(request.args?.validationPlan) ?? [],
      missingness: asStringArray(request.args?.missingness) ?? [],
      retrievalLanes,
      executionOptions: {
        patchApply: listPatchApplyOptions()
      },
      schemaLinks: [
        ".ai/config/schema.json",
        "src/contracts/controller.ts",
        "src/contracts/planGraph.ts",
        ".ai/mcp-controller/specs/ast_codemod_policy.md"
      ],
      anchors: extractAnchors(request.args),
      requiresAgGridProof: lexemes.some((item) => item.includes("ag-grid")),
      requiresFederationProof: lexemes.some((item) => item.includes("federation"))
    });

    if (packOutput.insufficiency) {
      const response = this.makeResponse({
        runSessionId,
        workId,
        agentId,
        state: budgetStatus.blocked ? "BLOCKED_BUDGET" : "PLAN_REQUIRED",
        strategy,
        result: {
          message: "Context pack is insufficient for execution-safe planning.",
          contextPackRef: packOutput.contextPackRef,
          contextPackHash: packOutput.contextPackHash
        },
        denyReasons: ["PACK_INSUFFICIENT", "PACK_REQUIRED_ANCHOR_UNRESOLVED"],
        outcome: "pack_insufficient",
        packInsufficiency: packOutput.insufficiency,
        budgetStatus,
        scopeWorktreeRoot: activeWorktreeRoot()
      });
      await this.logTurn("pack_insufficient", request.verb, response, request.args);
      current.state = response.state;
      this.sessions.set(sessionKey, current);
      return response;
    }

    current.actionCounts[request.verb] = (current.actionCounts[request.verb] ?? 0) + 1;

    let state = budgetStatus.blocked ? "BLOCKED_BUDGET" : current.state;
    const denyReasons: string[] = [];
    const result: Record<string, unknown> = {
      contextPackRef: packOutput.contextPackRef,
      contextPackHash: packOutput.contextPackHash,
      patchApplyOptions: listPatchApplyOptions()
    };

    if (budgetStatus.blocked && !isBudgetSafeVerb(request.verb)) {
      denyReasons.push("BUDGET_THRESHOLD_EXCEEDED");
      result.message = "Token budget threshold exceeded. Use list/original_prompt/escalate.";
      const response = this.makeResponse({
        runSessionId,
        workId,
        agentId,
        state,
        strategy,
        result,
        denyReasons,
        budgetStatus,
        scopeWorktreeRoot: activeWorktreeRoot()
      });
      this.trackRejections(current, denyReasons);
      current.state = state;
      this.sessions.set(sessionKey, current);
      await this.logTurn("turn", request.verb, response, request.args);
      await this.emitCorrectionCandidateIfNeeded(current, response);
      await this.eventStore.append({
        ts: new Date().toISOString(),
        type: "output_envelope",
        runSessionId,
        workId,
        agentId,
        payload: {
          verb: request.verb,
          state: response.state,
          denyReasons: response.denyReasons,
          outcome: response.outcome
        }
      });
      return response;
    }

    switch (request.verb) {
      case "submit_plan": {
        state = await this.handleSubmitPlan(request.args, denyReasons, state, result, current);
        break;
      }
      case "write_tmp": {
        await this.handleWriteTmp(workId, request.args, denyReasons, result);
        break;
      }
      case "read_range": {
        await this.handleReadRange(request.args, current, denyReasons, result);
        break;
      }
      case "read_symbol": {
        await this.handleReadSymbol(request.args, denyReasons, result);
        break;
      }
      case "grep_lexeme": {
        await this.handleGrepLexeme(request.args, denyReasons, result);
        break;
      }
      case "read_neighbors": {
        await this.handleReadNeighbors(request.args, denyReasons, result);
        break;
      }
      case "list_allowed_files": {
        result.allowedFiles = listAllowedFiles(workId, current.scopeAllowlist, activeWorktreeRoot());
        break;
      }
      case "patch_apply": {
        state = await this.handlePatchApply(collisionScopeKey, request.args, current, denyReasons, result, state);
        break;
      }
      case "code_run": {
        state = await this.handleCodeRun(collisionScopeKey, request.args, current, denyReasons, result, state);
        break;
      }
      case "side_effect": {
        state = await this.handleSideEffect(collisionScopeKey, request.args, current, denyReasons, result, state);
        break;
      }
      case "fetch_jira": {
        await this.handleFetchJira(request.args, current, denyReasons, result);
        break;
      }
      case "fetch_swagger": {
        await this.handleFetchSwagger(request.args, current, denyReasons, result);
        break;
      }
      case "original_prompt": {
        result.originalPrompt = originalPrompt;
        break;
      }
      case "run_recipe": {
        await this.handleRunRecipe(request.args, current, denyReasons, result);
        break;
      }
      case "list": {
        result.available = capabilitiesForState(state);
        break;
      }
      default: {
        // Read-style and inspect-style commands are accepted as no-op placeholders for now.
        if (!capabilitiesForState(state).includes(request.verb)) {
          denyReasons.push("PLAN_SCOPE_VIOLATION");
        } else {
          result.message = `Verb '${request.verb}' acknowledged`;
        }
        break;
      }
    }

    this.trackRejections(current, denyReasons);
    const response = this.makeResponse({
      runSessionId,
      workId,
      agentId,
      state,
      strategy,
      result,
      denyReasons,
      budgetStatus,
      scopeWorktreeRoot: activeWorktreeRoot()
    });

    current.state = state;
    this.sessions.set(sessionKey, current);
    await this.logTurn("turn", request.verb, response, request.args);
    await this.emitCorrectionCandidateIfNeeded(current, response);
    await this.runMemoryPromotionLane(current);

    await this.eventStore.append({
      ts: new Date().toISOString(),
      type: "output_envelope",
      runSessionId,
      workId,
      agentId,
      payload: {
        verb: request.verb,
        state: response.state,
        denyReasons: response.denyReasons,
        outcome: response.outcome
      }
    });

    return response;
  }

  runSummaries(): Array<{ runSessionId: string; workId: string; agentId: string; state: RunState }> {
    return [...this.sessions.values()].map((value) => ({
      runSessionId: value.runSessionId,
      workId: value.workId,
      agentId: value.agentId,
      state: value.state
    }));
  }

  async listMemoryPromotions(): Promise<Array<Record<string, unknown>>> {
    const promotions = await this.memoryPromotion.list();
    return promotions.map((item) => ({ ...item }));
  }

  private ensureSessionState(
    key: string,
    runSessionId: string,
    workId: string,
    agentId: string
  ): SessionState {
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }
    return {
      runSessionId,
      workId,
      agentId,
      state: "PLAN_REQUIRED",
      originalPrompt: "",
      rejectionCounts: {},
      actionCounts: {},
      usedTokens: 0,
      scopeAllowlist: null,
      artifacts: []
    };
  }

  private resolveOriginalPrompt(current: SessionState, incomingPrompt: string | undefined): string {
    if (!current.originalPrompt && incomingPrompt && incomingPrompt.trim().length > 0) {
      current.originalPrompt = incomingPrompt;
      return current.originalPrompt;
    }
    if (
      current.originalPrompt &&
      incomingPrompt &&
      incomingPrompt.trim().length > 0 &&
      incomingPrompt !== current.originalPrompt
    ) {
      // Keep first prompt verbatim; mismatches are tracked as observability anomalies.
      void this.eventStore.append({
        ts: new Date().toISOString(),
        type: "prompt_mismatch",
        runSessionId: current.runSessionId,
        workId: current.workId,
        agentId: current.agentId,
        payload: {
          expectedPrompt: current.originalPrompt,
          providedPrompt: incomingPrompt
        }
      });
    }
    return current.originalPrompt;
  }

  private extractLexemes(request: TurnRequest): string[] {
    const lexemeCandidates = request.args?.lexemes;
    if (!Array.isArray(lexemeCandidates)) {
      return [];
    }
    return lexemeCandidates.map((item) => String(item).toLowerCase());
  }

  private consumeBudget(current: SessionState, request: TurnRequest): TurnResponse["budgetStatus"] {
    current.usedTokens += estimateTokenCost(request);
    const thresholdTokens = Math.floor(DEFAULT_MAX_TOKENS * DEFAULT_BUDGET_THRESHOLD_PERCENT);
    return {
      maxTokens: DEFAULT_MAX_TOKENS,
      usedTokens: current.usedTokens,
      thresholdTokens,
      blocked: current.usedTokens >= thresholdTokens
    };
  }

  private async handleSubmitPlan(
    args: Record<string, unknown> | undefined,
    denyReasons: string[],
    currentState: RunState,
    result: Record<string, unknown>,
    current: SessionState
  ): Promise<RunState> {
    const planGraph = args?.planGraph as PlanGraphDocument | undefined;
    if (!planGraph) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return currentState;
    }

    const validation = validatePlanGraph(planGraph);
    if (!validation.ok) {
      denyReasons.push(...validation.rejectionCodes);
      return "PLAN_REQUIRED";
    }

    if (planGraph.workId !== current.workId || planGraph.agentId !== current.agentId || planGraph.runSessionId !== current.runSessionId) {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
      return "PLAN_REQUIRED";
    }
    const worktreeCheck = validatePlanWorktreeRoot(planGraph.worktreeRoot, current.workId);
    if (!worktreeCheck.ok) {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
      result.planValidationError = worktreeCheck.reason;
      return "PLAN_REQUIRED";
    }

    current.planGraph = planGraph;
    current.scopeAllowlist = await loadScopeAllowlist(planGraph.scopeAllowlistRef);

    result.planValidation = "passed";
    result.repoSnapshotId = await repoSnapshotId();
    return "PLAN_ACCEPTED";
  }

  private async handleWriteTmp(
    workId: string,
    args: Record<string, unknown> | undefined,
    denyReasons: string[],
    result: Record<string, unknown>
  ): Promise<void> {
    const target = String(args?.target ?? "");
    const content = String(args?.content ?? "");
    if (!target) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return;
    }
    try {
      const root = scratchRoot(workId);
      const safe = normalizeSafePath(root, target);
      await writeText(safe, content);
      result.writeTmp = { file: safe, bytes: Buffer.byteLength(content, "utf8") };
    } catch {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
    }
  }

  private async handleReadRange(
    args: Record<string, unknown> | undefined,
    current: SessionState,
    denyReasons: string[],
    result: Record<string, unknown>
  ): Promise<void> {
    const targetFile = String(args?.targetFile ?? "");
    const startLine = Math.max(1, Number(args?.startLine ?? 1));
    const endLine = Math.max(startLine, Number(args?.endLine ?? startLine + 99));
    if (!targetFile) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return;
    }

    const readRoot = current.planGraph?.worktreeRoot ?? resolveTargetRepoRoot();
    const scopeCheck = scopeAllowsFile({
      workId: current.workId,
      targetFile,
      worktreeRoot: readRoot,
      allowlist: current.scopeAllowlist
    });
    if (!scopeCheck.ok) {
      denyReasons.push(scopeCheck.rejectionCode ?? "PLAN_SCOPE_VIOLATION");
      result.readRangeError = scopeCheck.reason;
      return;
    }

    try {
      const safePath = normalizeSafePath(readRoot, targetFile);
      const content = await readText(safePath);
      const lines = content.split("\n");
      const slice = lines.slice(startLine - 1, endLine).map((text, index) => ({
        line: startLine + index,
        text
      }));
      result.readRange = {
        targetFile,
        startLine,
        endLine,
        totalLines: lines.length,
        lines: slice
      };
    } catch (error) {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
      result.readRangeError = error instanceof Error ? error.message : "READ_RANGE_FAILED";
    }
  }

  private async handleReadSymbol(
    args: Record<string, unknown> | undefined,
    denyReasons: string[],
    result: Record<string, unknown>
  ): Promise<void> {
    const symbol = String(args?.symbol ?? "").trim();
    if (!symbol) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return;
    }
    if (!this.indexing) {
      denyReasons.push("PLAN_VERIFICATION_WEAK");
      result.readSymbolError = "Indexing service unavailable.";
      return;
    }
    const limit = Math.max(1, Number(args?.limit ?? 12));
    result.readSymbol = {
      symbol,
      matches: this.indexing.searchSymbol(symbol, limit)
    };
  }

  private async handleGrepLexeme(
    args: Record<string, unknown> | undefined,
    denyReasons: string[],
    result: Record<string, unknown>
  ): Promise<void> {
    const query = String(args?.query ?? args?.lexeme ?? "").trim();
    if (!query) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return;
    }
    if (!this.indexing) {
      denyReasons.push("PLAN_VERIFICATION_WEAK");
      result.grepLexemeError = "Indexing service unavailable.";
      return;
    }
    const limit = Math.max(1, Number(args?.limit ?? 20));
    result.grepLexeme = {
      query,
      hits: this.indexing.searchLexical(query, limit)
    };
  }

  private async handleReadNeighbors(
    args: Record<string, unknown> | undefined,
    denyReasons: string[],
    result: Record<string, unknown>
  ): Promise<void> {
    if (!this.indexing) {
      denyReasons.push("PLAN_VERIFICATION_WEAK");
      result.readNeighborsError = "Indexing service unavailable.";
      return;
    }
    const symbol = String(args?.symbol ?? "").trim();
    const targetFile = String(args?.targetFile ?? "").trim();
    const query = String(args?.query ?? "").trim();
    const limit = Math.max(1, Number(args?.limit ?? 12));

    if (!symbol && !targetFile && !query) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return;
    }

    const symbolMatches = symbol ? this.indexing.searchSymbol(symbol, limit) : [];
    const lexicalQuery = query || symbol || path.basename(targetFile);
    const lexicalMatches = this.indexing.searchLexical(lexicalQuery, limit);
    result.readNeighbors = {
      anchor: symbol || targetFile || query,
      symbolMatches,
      lexicalMatches
    };
  }

  private async handlePatchApply(
    collisionScopeKey: string,
    args: Record<string, unknown> | undefined,
    current: SessionState,
    denyReasons: string[],
    result: Record<string, unknown>,
    state: RunState
  ): Promise<RunState> {
    if (!canExecuteMutation(state) || !current.planGraph) {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
      return state;
    }

    const request = parsePatchApplyRequest(args);
    if (!request) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return state;
    }

    const node = findChangeNode(current.planGraph, request.nodeId);
    if (!node) {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
      return state;
    }
    if (request.operation === "ast_codemod") {
      const token = codemodCitationToken(request.codemodId);
      const cited = node.citations.some((item) => item === token || item.startsWith(`${token}@`));
      if (!cited) {
        denyReasons.push("PLAN_POLICY_VIOLATION");
        result.patchApplyError = `PlanGraph citations must include '${token}' for ast_codemod execution.`;
        return state;
      }
    }

    const fileScope = scopeAllowsFile({
      workId: current.workId,
      targetFile: request.targetFile,
      worktreeRoot: current.planGraph.worktreeRoot,
      allowlist: current.scopeAllowlist
    });
    if (!fileScope.ok) {
      denyReasons.push(fileScope.rejectionCode ?? "PLAN_SCOPE_VIOLATION");
      result.patchApplyError = fileScope.reason;
      return state;
    }

    const symbolScope = scopeAllowsSymbols({
      targetFile: request.targetFile,
      requestedSymbols: request.targetSymbols,
      allowlist: current.scopeAllowlist
    });
    if (!symbolScope.ok) {
      denyReasons.push(symbolScope.rejectionCode ?? "PLAN_SCOPE_VIOLATION");
      result.patchApplyError = symbolScope.reason;
      return state;
    }

    const collision = this.collisionGuard.assertAndReserve({
      sessionKey: collisionScopeKey,
      operationId: `patch:${request.nodeId}`,
      effects: {
        files: [request.targetFile],
        symbols: request.targetSymbols,
        graphMutations: [],
        externalSideEffects: []
      },
      approvedExternalGates: approvedCommitGates(current.planGraph)
    });
    if (!collision.ok) {
      denyReasons.push(collision.rejectionCode);
      result.patchApplyError = collision.reason;
      return state;
    }

    try {
      const patchResult = await applyStructuredPatch({
        worktreeRoot: current.planGraph.worktreeRoot,
        request,
        approvedNode: node
      });
      const trace = traceRef();
      const bundle = await writeArtifactBundle({
        workId: current.workId,
        runSessionId: current.runSessionId,
        nodeId: request.nodeId,
        operation: "patch_apply",
        result: { ...patchResult },
        opLog: `patch_apply ${request.targetFile} replacements=${patchResult.replacements}`,
        traceRefs: [trace],
        validation: {
          nodeId: request.nodeId,
          targetFile: request.targetFile,
          targetSymbols: request.targetSymbols,
          scopeChecked: true
        },
        diffSummary: {
          file: patchResult.targetFile,
          changed: patchResult.changed,
          replacements: patchResult.replacements,
          lineDelta: patchResult.lineDelta
        }
      });

      result.patchApply = {
        ...patchResult,
        artifactBundleRef: bundle.bundleDir,
        resultRef: bundle.resultRef,
        diffSummaryRef: bundle.diffSummaryRef
      };
      return "EXECUTION_ENABLED";
    } catch (error) {
      const message = error instanceof Error ? error.message : "PATCH_FAILED";
      result.patchApplyError = message;
      if (isRejectionCode(message)) {
        denyReasons.push(message);
      } else {
        denyReasons.push("PLAN_VERIFICATION_WEAK");
      }
      return state;
    }
  }

  private async handleCodeRun(
    collisionScopeKey: string,
    args: Record<string, unknown> | undefined,
    current: SessionState,
    denyReasons: string[],
    result: Record<string, unknown>,
    state: RunState
  ): Promise<RunState> {
    if (!canExecuteMutation(state) || !current.planGraph) {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
      return state;
    }

    const request = parseCodeRunRequest(args);
    if (!request) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return state;
    }

    const externalSideEffects = asStringArray(args?.externalSideEffects) ?? [];
    const collision = this.collisionGuard.assertAndReserve({
      sessionKey: collisionScopeKey,
      operationId: `code_run:${request.nodeId}`,
      effects: {
        files: [],
        symbols: [],
        graphMutations: asStringArray(args?.graphMutations) ?? [],
        externalSideEffects
      },
      approvedExternalGates: approvedCommitGates(current.planGraph)
    });
    if (!collision.ok) {
      denyReasons.push(collision.rejectionCode);
      result.codeRunError = collision.reason;
      return state;
    }

    const execution = await executeCodeRun(request);
    if (!execution.ok) {
      denyReasons.push(execution.rejectionCode ?? "PLAN_VERIFICATION_WEAK");
      result.codeRunError = execution.reason;
      return state;
    }

    const trace = traceRef();
    const bundle = await writeArtifactBundle({
      workId: current.workId,
      runSessionId: current.runSessionId,
      nodeId: request.nodeId,
      operation: "code_run",
      result: {
        artifactOutputRef: request.artifactOutputRef,
        value: execution.value
      },
      opLog: `code_run node=${request.nodeId} timeoutMs=${request.timeoutMs}`,
      traceRefs: [trace],
      validation: {
        preflight: "passed",
        expectedReturnShape: request.expectedReturnShape,
        artifactOutputRef: request.artifactOutputRef
      }
    });

    result.codeRun = {
      preflight: "accepted",
      artifactOutputRef: request.artifactOutputRef,
      artifactBundleRef: bundle.bundleDir,
      resultRef: bundle.resultRef,
      valueSummary: summarizeValue(execution.value)
    };
    return "EXECUTION_ENABLED";
  }

  private async handleSideEffect(
    collisionScopeKey: string,
    args: Record<string, unknown> | undefined,
    current: SessionState,
    denyReasons: string[],
    result: Record<string, unknown>,
    state: RunState
  ): Promise<RunState> {
    if (!canExecuteMutation(state) || !current.planGraph) {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
      return state;
    }

    const nodeId = String(args?.nodeId ?? "");
    const gateId = String(args?.commitGateId ?? "");
    if (!nodeId || !gateId) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return state;
    }

    const node = findSideEffectNode(current.planGraph, nodeId);
    if (!node || node.commitGateId !== gateId) {
      denyReasons.push("EXEC_UNGATED_SIDE_EFFECT");
      return state;
    }

    const effects: IntendedEffectSet = {
      files: asStringArray(args?.files) ?? [],
      symbols: asStringArray(args?.symbols) ?? [],
      graphMutations: asStringArray(args?.graphMutations) ?? [],
      externalSideEffects: asStringArray(args?.externalSideEffects) ?? []
    };

    const collision = this.collisionGuard.assertAndReserve({
      sessionKey: collisionScopeKey,
      operationId: `side_effect:${nodeId}`,
      effects,
      approvedExternalGates: approvedCommitGates(current.planGraph)
    });
    if (!collision.ok) {
      denyReasons.push(collision.rejectionCode);
      result.sideEffectError = collision.reason;
      return state;
    }

    const trace = traceRef();
    const bundle = await writeArtifactBundle({
      workId: current.workId,
      runSessionId: current.runSessionId,
      nodeId,
      operation: "side_effect",
      result: {
        sideEffectType: node.sideEffectType,
        sideEffectPayloadRef: node.sideEffectPayloadRef,
        commitGateId: node.commitGateId
      },
      opLog: `side_effect node=${nodeId} gate=${gateId}`,
      traceRefs: [trace],
      validation: {
        sideEffectNode: true,
        commitGateChecked: true
      }
    });

    result.sideEffect = {
      accepted: true,
      artifactBundleRef: bundle.bundleDir
    };
    return "EXECUTION_ENABLED";
  }

  private async handleFetchJira(
    args: Record<string, unknown> | undefined,
    current: SessionState,
    denyReasons: string[],
    result: Record<string, unknown>
  ): Promise<void> {
    if (!this.connectors) {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
      return;
    }
    const issueKey = String(args?.issueKey ?? "");
    if (!issueKey) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return;
    }
    try {
      const artifact = await this.connectors.fetchJiraIssue(issueKey);
      this.recordArtifact(current, artifact);
      result.jira = artifact;
    } catch (error) {
      denyReasons.push("PLAN_MISSING_CONTRACT_ANCHOR");
      result.jiraError = error instanceof Error ? error.message : "JIRA_FETCH_FAILED";
    }
  }

  private async handleFetchSwagger(
    args: Record<string, unknown> | undefined,
    current: SessionState,
    denyReasons: string[],
    result: Record<string, unknown>
  ): Promise<void> {
    if (!this.connectors) {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
      return;
    }
    const swaggerRef = String(args?.swaggerRef ?? "");
    if (!swaggerRef) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return;
    }
    try {
      const artifact = await this.connectors.registerSwaggerRef(swaggerRef);
      this.recordArtifact(current, artifact);
      result.swagger = artifact;
    } catch (error) {
      denyReasons.push("PLAN_MISSING_CONTRACT_ANCHOR");
      result.swaggerError = error instanceof Error ? error.message : "SWAGGER_FETCH_FAILED";
    }
  }

  private async handleRunRecipe(
    args: Record<string, unknown> | undefined,
    current: SessionState,
    denyReasons: string[],
    result: Record<string, unknown>
  ): Promise<void> {
    const recipeId = String(args?.recipeId ?? "");
    const planNodeId = String(args?.planNodeId ?? "");
    const validatedParams = isRecord(args?.validatedParams) ? args?.validatedParams : {};
    const artifactBundleRef = String(args?.artifactBundleRef ?? "");
    const diffSummaryRef = String(args?.diffSummaryRef ?? "");

    if (!recipeId || !planNodeId || !artifactBundleRef || !diffSummaryRef) {
      denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
      return;
    }

    const validation = this.recipes.validate(recipeId, validatedParams);
    if (!validation.ok) {
      denyReasons.push("PLAN_POLICY_VIOLATION");
      result.recipeError = validation.reason;
      return;
    }

    const usageEvent = buildRecipeUsageEvent({
      recipeId,
      validatedParams,
      workId: current.workId,
      runSessionId: current.runSessionId,
      planNodeId,
      artifactBundleRef,
      diffSummaryRef,
      validationOutcome: "passed"
    });
    await this.eventStore.append({
      ts: new Date().toISOString(),
      type: "recipe_usage",
      runSessionId: current.runSessionId,
      workId: current.workId,
      agentId: current.agentId,
      payload: { ...usageEvent }
    });

    result.recipe = {
      accepted: true,
      recipeId,
      planNodeId
    };
  }

  private recordArtifact(current: SessionState, artifact: ConnectorArtifact): void {
    if (current.artifacts.some((existing) => existing.ref === artifact.ref)) {
      return;
    }
    current.artifacts.push(artifact);
  }

  private trackRejections(current: SessionState, denyReasons: string[]): void {
    for (const code of denyReasons) {
      current.rejectionCounts[code] = (current.rejectionCounts[code] ?? 0) + 1;
    }
  }

  private async emitCorrectionCandidateIfNeeded(current: SessionState, response: TurnResponse): Promise<void> {
    for (const code of response.denyReasons) {
      if ((current.rejectionCounts[code] ?? 0) >= 3) {
        await this.eventStore.append({
          ts: new Date().toISOString(),
          type: "pending_correction_created",
          runSessionId: current.runSessionId,
          workId: current.workId,
          agentId: current.agentId,
          payload: {
            rejectionCode: code,
            count: current.rejectionCounts[code]
          }
        });

        await this.memoryPromotion.createPending({
          kind: "strategy_hint",
          traceRef: response.traceRef,
          reason: `Repeated rejection code ${code}`,
          metadata: {
            rejectionCode: code,
            rejectionCount: current.rejectionCounts[code],
            strategy: response.knowledgeStrategy.strategyId
          }
        });
      }
    }
  }

  private async runMemoryPromotionLane(current: SessionState): Promise<void> {
    const transitioned = await this.memoryPromotion.runAutoPromotion();
    for (const item of transitioned) {
      await this.eventStore.append({
        ts: new Date().toISOString(),
        type: "memory_promotion_transition",
        runSessionId: current.runSessionId,
        workId: current.workId,
        agentId: current.agentId,
        payload: {
          id: item.id,
          kind: item.kind,
          state: item.state,
          traceRef: item.traceRef
        }
      });
    }
  }

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
    return {
      runSessionId: input.runSessionId,
      workId: input.workId,
      agentId: input.agentId,
      state: input.state,
      outcome: input.outcome,
      capabilities: capabilitiesForState(input.state),
      scope: {
        worktreeRoot: input.scopeWorktreeRoot,
        scratchRoot: scratchRoot(input.workId)
      },
      result: input.result,
      denyReasons: input.denyReasons,
      knowledgeStrategy: {
        strategyId: input.strategy.strategyId,
        reasons: input.strategy.reasons
      },
      budgetStatus: input.budgetStatus,
      traceRef: traceRef(),
      schemaVersion: SCHEMA_VERSION,
      subAgentHints: {
        recommended: true,
        suggestedSplits: recommendedSubAgentSplits(input.strategy.strategyId)
      },
      packInsufficiency: input.packInsufficiency
    };
  }

  private async logTurn(
    type: string,
    verb: string,
    response: TurnResponse,
    args: Record<string, unknown> | undefined
  ): Promise<void> {
    await this.eventStore.append({
      ts: new Date().toISOString(),
      type,
      runSessionId: response.runSessionId,
      workId: response.workId,
      agentId: response.agentId,
      payload: {
        verb,
        state: response.state,
        denyReasons: response.denyReasons,
        strategy: response.knowledgeStrategy.strategyId,
        outcome: response.outcome,
        module: moduleHint(args),
        packMissingAnchors: response.packInsufficiency?.missingAnchors ?? []
      }
    });
  }
}

function extractAnchors(args: Record<string, unknown> | undefined): {
  entrypoint?: string;
  definition?: string;
  agGridOriginChain?: string[];
  federationChain?: string[];
} {
  const anchorInput = args?.anchors as Record<string, unknown> | undefined;
  if (!anchorInput) {
    return {};
  }
  return {
    entrypoint: asOptionalString(anchorInput.entrypoint),
    definition: asOptionalString(anchorInput.definition),
    agGridOriginChain: asStringArray(anchorInput.agGridOriginChain),
    federationChain: asStringArray(anchorInput.federationChain)
  };
}

function parsePatchApplyRequest(args: Record<string, unknown> | undefined): PatchApplyRequest | null {
  if (!args) {
    return null;
  }
  const nodeId = String(args.nodeId ?? "");
  const targetFile = String(args.targetFile ?? "");
  const targetSymbols = asStringArray(args.targetSymbols) ?? [];
  const operationRaw = String(args.operation ?? "replace_text");

  if (!nodeId || !targetFile) {
    return null;
  }

  if (operationRaw === "replace_text") {
    const find = String(args.find ?? "");
    const replace = String(args.replace ?? "");
    if (!find) {
      return null;
    }
    return {
      nodeId,
      targetFile,
      targetSymbols,
      operation: "replace_text",
      find,
      replace
    };
  }

  if (operationRaw !== "ast_codemod") {
    return null;
  }
  const codemodId = String(args.codemodId ?? "").trim();
  const codemodParams = isRecord(args.codemodParams) ? args.codemodParams : {};
  if (!codemodId) {
    return null;
  }

  return {
    nodeId,
    targetFile,
    targetSymbols,
    operation: "ast_codemod",
    codemodId,
    codemodParams
  };
}

function parseCodeRunRequest(args: Record<string, unknown> | undefined): CodeRunRequest | null {
  if (!args) {
    return null;
  }

  const nodeId = String(args.nodeId ?? "");
  const iife = String(args.iife ?? "");
  const artifactOutputRef = String(args.artifactOutputRef ?? "");
  const timeoutMs = Number(args.timeoutMs ?? 0);
  const memoryCapMb = Number(args.memoryCapMb ?? 0);
  const declaredInputs = isRecord(args.declaredInputs) ? args.declaredInputs : {};
  const expected = isRecord(args.expectedReturnShape)
    ? args.expectedReturnShape
    : { type: "object", requiredKeys: [] };
  const expectedType = String(expected.type ?? "");
  const requiredKeys = asStringArray(expected.requiredKeys) ?? [];

  if (!nodeId || !iife || !artifactOutputRef || timeoutMs <= 0 || memoryCapMb <= 0) {
    return null;
  }
  if (!isExpectedType(expectedType)) {
    return null;
  }

  return {
    nodeId,
    iife,
    declaredInputs,
    timeoutMs,
    memoryCapMb,
    artifactOutputRef,
    expectedReturnShape: {
      type: expectedType,
      requiredKeys
    }
  };
}

function isExpectedType(value: string): value is CodeRunRequest["expectedReturnShape"]["type"] {
  return value === "object" || value === "string" || value === "number" || value === "array" || value === "boolean";
}

function findChangeNode(plan: PlanGraphDocument, nodeId: string): ChangePlanNode | null {
  for (const node of plan.nodes) {
    if (node.nodeId === nodeId && node.kind === "change") {
      return node;
    }
  }
  return null;
}

function findSideEffectNode(plan: PlanGraphDocument, nodeId: string): SideEffectPlanNode | null {
  for (const node of plan.nodes) {
    if (node.nodeId === nodeId && node.kind === "side_effect") {
      return node;
    }
  }
  return null;
}

function approvedCommitGates(plan: PlanGraphDocument): string[] {
  return plan.nodes
    .filter((node): node is SideEffectPlanNode => node.kind === "side_effect")
    .map((node) => node.commitGateId);
}

function validatePlanWorktreeRoot(
  worktreeRoot: string,
  workId: string
): { ok: true } | { ok: false; reason: string } {
  if (!worktreeRoot || worktreeRoot.trim().length === 0) {
    return {
      ok: false,
      reason: "Plan worktreeRoot is required."
    };
  }

  const resolved = path.resolve(worktreeRoot);
  const targetRoot = path.resolve(resolveTargetRepoRoot());
  const scopedWorkRoot = path.resolve(workRoot(workId));

  if (isPathWithin(resolved, targetRoot) || isPathWithin(resolved, scopedWorkRoot)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "Plan worktreeRoot must stay within MCP target repo root or .ai scoped work root."
  };
}

function isPathWithin(candidate: string, root: string): boolean {
  if (candidate === root) {
    return true;
  }
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    return value.slice(0, 160);
  }
  try {
    return JSON.stringify(value).slice(0, 160);
  } catch {
    return "[unserializable result]";
  }
}

function isBudgetSafeVerb(verb: string): boolean {
  return verb === "list" || verb === "original_prompt" || verb === "escalate";
}

function estimateTokenCost(request: TurnRequest): number {
  let serialized = "";
  try {
    serialized = JSON.stringify({
      verb: request.verb,
      originalPrompt: request.originalPrompt ?? "",
      args: request.args ?? {}
    });
  } catch {
    serialized = request.verb;
  }
  return Math.max(1, Math.ceil(serialized.length / 4));
}

function isRejectionCode(value: string): boolean {
  return value.startsWith("PLAN_") || value.startsWith("EXEC_") || value.startsWith("PACK_");
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => String(item));
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function moduleHint(args: Record<string, unknown> | undefined): string {
  if (!args) {
    return "unknown_module";
  }
  const explicit = String(args.module ?? "");
  if (explicit) {
    return explicit;
  }
  const targetFile = String(args.targetFile ?? "");
  if (targetFile.includes("/")) {
    const parts = targetFile.split("/");
    return parts.slice(0, Math.max(1, parts.length - 1)).join("/");
  }
  return targetFile || "unknown_module";
}
