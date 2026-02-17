import type { RunState } from "../../../contracts/controller";
import type { PlanGraphDocument } from "../../../contracts/planGraph";
import type { VerbResult, SessionState } from "../types";
import { validatePlanGraph } from "../../plan-graph/planGraphValidator";
import { loadScopeAllowlist } from "../../worktree-scope/worktreeScopeService";
import { repoSnapshotId } from "../../../infrastructure/git/repoSnapshot";
import { normalizeSafePath, scratchRoot } from "../../../shared/fsPaths";
import { writeText } from "../../../shared/fileStore";
import { validatePlanWorktreeRoot } from "../turnHelpers";

export async function handleSubmitPlan(
  args: Record<string, unknown> | undefined,
  session: SessionState,
  currentState: RunState
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const planGraph = args?.planGraph as PlanGraphDocument | undefined;
  if (!planGraph) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "args.planGraph is required but was missing or empty. Supply a complete PlanGraphDocument object in args.planGraph with all required fields (workId, agentId, runSessionId, worktreeRoot, nodes, etc.).";
    result.missingFields = ["planGraph"];
    return { result, denyReasons, stateOverride: currentState };
  }

  const validation = validatePlanGraph(planGraph);
  if (!validation.ok) {
    denyReasons.push(...validation.rejectionCodes);
    result.error = "Plan graph validation failed. See result.validationDiagnostics for the specific issues to fix.";
    result.validationDiagnostics = validation.diagnostics ?? validation.rejectionCodes;
    return { result, denyReasons, stateOverride: "PLAN_REQUIRED" };
  }

  if (
    planGraph.workId !== session.workId ||
    planGraph.agentId !== session.agentId ||
    planGraph.runSessionId !== session.runSessionId
  ) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.error = "Plan envelope identity fields do not match the current session. The planGraph.workId, planGraph.agentId, and planGraph.runSessionId must exactly match the values from this session.";
    result.mismatch = {
      expected: { workId: session.workId, agentId: session.agentId, runSessionId: session.runSessionId },
      received: { workId: planGraph.workId, agentId: planGraph.agentId, runSessionId: planGraph.runSessionId },
    };
    return { result, denyReasons, stateOverride: "PLAN_REQUIRED" };
  }

  const worktreeCheck = validatePlanWorktreeRoot(planGraph.worktreeRoot, session.workId);
  if (!worktreeCheck.ok) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.planValidationError = worktreeCheck.reason;
    return { result, denyReasons, stateOverride: "PLAN_REQUIRED" };
  }

  session.planGraph = planGraph;
  session.scopeAllowlist = await loadScopeAllowlist(planGraph.scopeAllowlistRef);

  result.planValidation = "passed";
  result.repoSnapshotId = await repoSnapshotId();
  return { result, denyReasons, stateOverride: "PLAN_ACCEPTED" };
}

export async function handleWriteTmp(
  workId: string,
  args: Record<string, unknown> | undefined
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const target = String(args?.target ?? "");
  const content = String(args?.content ?? "");
  if (!target) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "args.target is required but was missing or empty. Supply a file path relative to the scratch directory (e.g., 'notes/analysis.md').";
    result.missingFields = ["target"];
    return { result, denyReasons };
  }

  try {
    const root = scratchRoot(workId);
    const safe = normalizeSafePath(root, target);
    await writeText(safe, content);
    result.writeTmp = { file: safe, bytes: Buffer.byteLength(content, "utf8") };
  } catch (error) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.error = `write_tmp failed: ${error instanceof Error ? error.message : "path escapes scratch scope"}. Ensure args.target is a relative path within the work scratch directory. Absolute paths and '..' traversals are forbidden.`;
  }

  return { result, denyReasons };
}
