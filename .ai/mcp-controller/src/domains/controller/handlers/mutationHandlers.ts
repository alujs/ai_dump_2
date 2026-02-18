import type { RunState } from "../../../contracts/controller";
import type { VerbResult, SessionState } from "../types";
import { canExecuteMutation } from "../../capability-gating/capabilityMatrix";
import { CollisionGuard, type IntendedEffectSet } from "../../patch-exec/collisionGuard";
import { codemodCitationToken } from "../../patch-exec/astCodemodCatalog";
import { applyStructuredPatch, type PatchApplyRequest } from "../../patch-exec/patchExecService";
import { executeCodeRun } from "../../code-run/codeRunService";
import { scopeAllowsFile, scopeAllowsSymbols } from "../../worktree-scope/worktreeScopeService";
import { writeArtifactBundle } from "../../../shared/artifacts";
import { traceRef } from "../../../shared/ids";
import { isInPack } from "./readHandlers";
import {
  parsePatchApplyRequest,
  parseCodeRunRequest,
  findChangeNode,
  findSideEffectNode,
  approvedCommitGates,
  summarizeValue,
  isRejectionCode,
  asStringArray,
} from "../turnHelpers";

/**
 * Mark a plan node as completed in the session's progress tracker.
 * Idempotent — re-completing the same nodeId is a no-op.
 */
function markNodeCompleted(session: SessionState, nodeId: string): void {
  if (!session.planGraphProgress) return;
  if (session.planGraphProgress.completedNodeIds.includes(nodeId)) return;
  session.planGraphProgress.completedNodeIds.push(nodeId);
  session.planGraphProgress.completedNodes = session.planGraphProgress.completedNodeIds.length;
  // Remove from eligible list if it was a validate node being explicitly completed
  const eligibleIdx = session.planGraphProgress.eligibleValidateNodeIds.indexOf(nodeId);
  if (eligibleIdx >= 0) session.planGraphProgress.eligibleValidateNodeIds.splice(eligibleIdx, 1);
  markEligibleValidateNodes(session);
}

/**
 * Attach an advisory to the result if there are validate nodes now eligible for explicit validation.
 * Agents must call `run_sandboxed_code` with the validate nodeId to complete them.
 */
function attachValidateAdvisory(session: SessionState, result: Record<string, unknown>): void {
  const eligible = session.planGraphProgress?.eligibleValidateNodeIds ?? [];
  if (eligible.length > 0) {
    result.pendingValidation = {
      message: "Validate nodes are eligible. Run run_sandboxed_code with each validate nodeId to complete them.",
      eligibleValidateNodeIds: [...eligible],
    };
  }
}

/**
 * Track validate nodes whose mapped change nodes are all completed.
 * Per audit #4: validate nodes must NOT be auto-completed. Instead they are
 * marked "eligible" — the agent must explicitly run validation via
 * `run_sandboxed_code` referencing the validate nodeId to complete them.
 */
function markEligibleValidateNodes(session: SessionState): void {
  if (!session.planGraph?.nodes || !session.planGraphProgress) return;
  const completed = new Set(session.planGraphProgress.completedNodeIds);
  const eligible = new Set(session.planGraphProgress.eligibleValidateNodeIds);
  for (const node of session.planGraph.nodes) {
    if ((node as any).kind !== "validate") continue;
    const nodeId = (node as any).nodeId;
    if (completed.has(nodeId) || eligible.has(nodeId)) continue;
    const mapped: string[] = (node as any).mapsToNodeIds ?? [];
    if (mapped.length === 0) continue;
    if (mapped.every((id: string) => completed.has(id))) {
      session.planGraphProgress.eligibleValidateNodeIds.push(nodeId);
      eligible.add(nodeId);
    }
  }
}

export async function handlePatchApply(
  collisionScopeKey: string,
  args: Record<string, unknown> | undefined,
  session: SessionState,
  collisionGuard: CollisionGuard,
  state: RunState
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  if (!canExecuteMutation(state) || !session.planGraph) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.error = !session.planGraph
      ? "No plan has been submitted yet. You must call verb='submit_execution_plan' with a valid PlanGraphDocument before using apply_code_patch. Current state: " + state
      : `Current state '${state}' does not allow mutations. apply_code_patch requires state PLAN_ACCEPTED. Submit and get a plan accepted first.`;
    return { result, denyReasons };
  }

  const request = parsePatchApplyRequest(args);
  if (!request) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "patch_apply requires args: { nodeId: string, targetFile: string, targetSymbols: string[], operation: 'replace_text'|'ast_codemod', find?: string, replace?: string, codemodId?: string, codemodParams?: object }. Check that all required fields are non-empty strings.";
    result.missingFields = ["nodeId", "targetFile", "targetSymbols", "operation"];
    return { result, denyReasons };
  }

  // #5: Pack-scope guard — targetFile must be in the context pack
  if (!isInPack(request.targetFile, session)) {
    denyReasons.push("PACK_SCOPE_VIOLATION");
    result.patchApplyError = `File '${request.targetFile}' is not in the current context pack. Add it via escalate before patching.`;
    return { result, denyReasons };
  }

  const node = findChangeNode(session.planGraph, request.nodeId);
  if (!node) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.error = `No 'change' node with nodeId='${request.nodeId}' exists in the accepted plan. Available change node IDs: [${session.planGraph.nodes?.filter((n: any) => n.kind === "change").map((n: any) => n.nodeId).join(", ") ?? "none"}]. Use one of these nodeIds or update the plan.`;
    return { result, denyReasons };
  }

  if (request.operation === "ast_codemod") {
    const token = codemodCitationToken(request.codemodId);
    const cited = node.citations.some((c) => c === token || c.startsWith(`${token}@`));
    if (!cited) {
      denyReasons.push("PLAN_POLICY_VIOLATION");
      result.patchApplyError = `PlanGraph citations must include '${token}' for ast_codemod execution.`;
      return { result, denyReasons };
    }
  }

  const fileScope = scopeAllowsFile({
    workId: session.workId,
    targetFile: request.targetFile,
    worktreeRoot: session.planGraph.worktreeRoot,
    allowlist: session.scopeAllowlist,
  });
  if (!fileScope.ok) {
    denyReasons.push(fileScope.rejectionCode ?? "PLAN_SCOPE_VIOLATION");
    result.patchApplyError = fileScope.reason;
    return { result, denyReasons };
  }

  const symbolScope = scopeAllowsSymbols({
    targetFile: request.targetFile,
    requestedSymbols: request.targetSymbols,
    allowlist: session.scopeAllowlist,
  });
  if (!symbolScope.ok) {
    denyReasons.push(symbolScope.rejectionCode ?? "PLAN_SCOPE_VIOLATION");
    result.patchApplyError = symbolScope.reason;
    return { result, denyReasons };
  }

  const collision = collisionGuard.assertAndReserve({
    sessionKey: collisionScopeKey,
    operationId: `patch:${request.nodeId}`,
    effects: {
      files: [request.targetFile],
      symbols: request.targetSymbols,
      graphMutations: [],
      externalSideEffects: [],
    },
    approvedExternalGates: approvedCommitGates(session.planGraph),
  });
  if (!collision.ok) {
    denyReasons.push(collision.rejectionCode);
    result.patchApplyError = collision.reason;
    return { result, denyReasons };
  }

  try {
    const patchResult = await applyStructuredPatch({
      worktreeRoot: session.planGraph.worktreeRoot,
      request,
      approvedNode: node,
    });
    const trace = traceRef();
    const bundle = await writeArtifactBundle({
      workId: session.workId,
      runSessionId: session.runSessionId,
      nodeId: request.nodeId,
      operation: "apply_code_patch",
      result: { ...patchResult },
      opLog: `apply_code_patch ${request.targetFile} replacements=${patchResult.replacements}`,
      traceRefs: [trace],
      validation: {
        nodeId: request.nodeId,
        targetFile: request.targetFile,
        targetSymbols: request.targetSymbols,
        scopeChecked: true,
      },
      diffSummary: {
        file: patchResult.targetFile,
        changed: patchResult.changed,
        replacements: patchResult.replacements,
        lineDelta: patchResult.lineDelta,
      },
    });

    result.patchApply = {
      ...patchResult,
      artifactBundleRef: bundle.bundleDir,
      resultRef: bundle.resultRef,
      diffSummaryRef: bundle.diffSummaryRef,
    };
    markNodeCompleted(session, request.nodeId);
    attachValidateAdvisory(session, result);
    return { result, denyReasons, stateOverride: "PLAN_ACCEPTED" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "PATCH_FAILED";
    result.patchApplyError = message;
    denyReasons.push(isRejectionCode(message) ? message : "PLAN_VERIFICATION_WEAK");
    return { result, denyReasons };
  }
}

export async function handleCodeRun(
  collisionScopeKey: string,
  args: Record<string, unknown> | undefined,
  session: SessionState,
  collisionGuard: CollisionGuard,
  state: RunState
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  if (!canExecuteMutation(state) || !session.planGraph) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.error = !session.planGraph
      ? "No plan has been submitted yet. You must call verb='submit_execution_plan' with a valid PlanGraphDocument before using run_sandboxed_code. Current state: " + state
      : `Current state '${state}' does not allow mutations. run_sandboxed_code requires state PLAN_ACCEPTED. Submit and get a plan accepted first.`;
    return { result, denyReasons };
  }

  const request = parseCodeRunRequest(args);
  if (!request) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "run_sandboxed_code requires args: { nodeId: string, iife: string, declaredInputs: object, timeoutMs: number, memoryCapMb: number, artifactOutputRef: string, expectedReturnShape: string }. Check that all required fields are present and non-empty.";
    result.missingFields = ["nodeId", "iife", "declaredInputs", "timeoutMs", "memoryCapMb", "artifactOutputRef", "expectedReturnShape"];
    return { result, denyReasons };
  }

  // #7: Verify nodeId exists in the accepted plan as a change or validate node
  const planNode = session.planGraph!.nodes?.find(
    (n: any) => n.nodeId === request.nodeId && (n.kind === "change" || n.kind === "validate")
  );
  if (!planNode) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.error = `No change or validate node with nodeId='${request.nodeId}' exists in the accepted plan. run_sandboxed_code must reference a valid plan node.`;
    return { result, denyReasons };
  }

  const externalSideEffects = asStringArray(args?.externalSideEffects) ?? [];
  const collision = collisionGuard.assertAndReserve({
    sessionKey: collisionScopeKey,
    operationId: `code_run:${request.nodeId}`,
    effects: {
      files: [],
      symbols: [],
      graphMutations: asStringArray(args?.graphMutations) ?? [],
      externalSideEffects,
    },
    approvedExternalGates: approvedCommitGates(session.planGraph),
  });
  if (!collision.ok) {
    denyReasons.push(collision.rejectionCode);
    result.codeRunError = collision.reason;
    return { result, denyReasons };
  }

  const execution = await executeCodeRun(request);
  if (!execution.ok) {
    denyReasons.push(execution.rejectionCode ?? "PLAN_VERIFICATION_WEAK");
    result.codeRunError = execution.reason;
    return { result, denyReasons };
  }

  const trace = traceRef();
  const bundle = await writeArtifactBundle({
    workId: session.workId,
    runSessionId: session.runSessionId,
    nodeId: request.nodeId,
    operation: "run_sandboxed_code",
    result: { artifactOutputRef: request.artifactOutputRef, value: execution.value },
    opLog: `run_sandboxed_code node=${request.nodeId} timeoutMs=${request.timeoutMs}`,
    traceRefs: [trace],
    validation: {
      preflight: "passed",
      expectedReturnShape: request.expectedReturnShape,
      artifactOutputRef: request.artifactOutputRef,
    },
  });

  result.codeRun = {
    preflight: "accepted",
    artifactOutputRef: request.artifactOutputRef,
    artifactBundleRef: bundle.bundleDir,
    resultRef: bundle.resultRef,
    valueSummary: summarizeValue(execution.value),
  };
  markNodeCompleted(session, request.nodeId);
  attachValidateAdvisory(session, result);
  return { result, denyReasons, stateOverride: "PLAN_ACCEPTED" };
}

export async function handleSideEffect(
  collisionScopeKey: string,
  args: Record<string, unknown> | undefined,
  session: SessionState,
  collisionGuard: CollisionGuard,
  state: RunState
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  if (!canExecuteMutation(state) || !session.planGraph) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.error = !session.planGraph
      ? "No plan has been submitted yet. You must call verb='submit_execution_plan' with a valid PlanGraphDocument before using execute_gated_side_effect. Current state: " + state
      : `Current state '${state}' does not allow mutations. execute_gated_side_effect requires state PLAN_ACCEPTED. Submit and get a plan accepted first.`;
    return { result, denyReasons };
  }

  const nodeId = String(args?.nodeId ?? "");
  const gateId = String(args?.commitGateId ?? "");
  if (!nodeId || !gateId) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = `execute_gated_side_effect requires both args.nodeId and args.commitGateId. Missing: ${[!nodeId && "nodeId", !gateId && "commitGateId"].filter(Boolean).join(", ")}. The nodeId must reference a side_effect node in the accepted plan, and commitGateId must match that node's gate.`;
    result.missingFields = [!nodeId && "nodeId", !gateId && "commitGateId"].filter(Boolean);
    return { result, denyReasons };
  }

  const node = findSideEffectNode(session.planGraph, nodeId);
  if (!node || node.commitGateId !== gateId) {
    denyReasons.push("EXEC_UNGATED_SIDE_EFFECT");
    result.error = !node
      ? `No side_effect node with nodeId='${nodeId}' exists in the accepted plan. Available side_effect node IDs: [${session.planGraph.nodes?.filter((n: any) => n.kind === "side_effect").map((n: any) => n.nodeId).join(", ") ?? "none"}].`
      : `commitGateId mismatch for nodeId='${nodeId}': plan expects gate='${node.commitGateId}' but received gate='${gateId}'. Use the correct commitGateId from the plan.`;
    return { result, denyReasons };
  }

  const effects: IntendedEffectSet = {
    files: asStringArray(args?.files) ?? [],
    symbols: asStringArray(args?.symbols) ?? [],
    graphMutations: asStringArray(args?.graphMutations) ?? [],
    externalSideEffects: asStringArray(args?.externalSideEffects) ?? [],
  };

  const collision = collisionGuard.assertAndReserve({
    sessionKey: collisionScopeKey,
    operationId: `side_effect:${nodeId}`,
    effects,
    approvedExternalGates: approvedCommitGates(session.planGraph),
  });
  if (!collision.ok) {
    denyReasons.push(collision.rejectionCode);
    result.sideEffectError = collision.reason;
    return { result, denyReasons };
  }

  const trace = traceRef();
  const bundle = await writeArtifactBundle({
    workId: session.workId,
    runSessionId: session.runSessionId,
    nodeId,
    operation: "execute_gated_side_effect",
    result: {
      sideEffectType: node.sideEffectType,
      sideEffectPayloadRef: node.sideEffectPayloadRef,
      commitGateId: node.commitGateId,
    },
    opLog: `execute_gated_side_effect node=${nodeId} gate=${gateId}`,
    traceRefs: [trace],
    validation: { sideEffectNode: true, commitGateChecked: true },
  });

  result.sideEffect = { accepted: true, artifactBundleRef: bundle.bundleDir };
  markNodeCompleted(session, nodeId);
  attachValidateAdvisory(session, result);
  return { result, denyReasons, stateOverride: "PLAN_ACCEPTED" };
}
