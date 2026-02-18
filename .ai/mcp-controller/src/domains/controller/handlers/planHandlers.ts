import type { RunState } from "../../../contracts/controller";
import type { PlanGraphDocument } from "../../../contracts/planGraph";
import type { VerbResult, SessionState } from "../types";
import { validatePlanGraph } from "../../plan-graph/planGraphValidator";
import type { MemoryService } from "../../memory/memoryService";
import { loadScopeAllowlist } from "../../worktree-scope/worktreeScopeService";
import { repoSnapshotId } from "../../../infrastructure/git/repoSnapshot";
import { normalizeSafePath, scratchRoot } from "../../../shared/fsPaths";
import { writeText } from "../../../shared/fileStore";
import { validatePlanWorktreeRoot } from "../turnHelpers";
import { computePackHash } from "../../context-pack/contextPackService";

/**
 * Maps each plan rejection code to a concrete, actionable fix instruction.
 * This is what the agent sees — it should tell them exactly what to change.
 */
function planRejectionFix(code: string): string {
  switch (code) {
    case "PLAN_MISSING_REQUIRED_FIELDS":
      return "One or more required fields are empty. Ensure every node has: nodeId, dependsOn[], atomicityBoundary (with inScopeAcceptanceCriteriaIds, inScopeModules), expectedFailureSignatures[]. Change nodes also need: operation, targetFile, whyThisFile, editIntent, escalateIf[], citations[], codeEvidence[], artifactRefs[], verificationHooks[].";
    case "PLAN_NOT_ATOMIC":
      return "Graph integrity issue: either duplicate nodeIds, a dependency cycle, dangling dependsOn references, or a change node has no corresponding validate node with mapsToNodeIds pointing to it. Every change node needs a validate node.";
    case "PLAN_SCOPE_VIOLATION":
      return "A change node references targetSymbols that are empty (and this isn't a 'create' + 'symbol-creation' intent). Add the target symbols this change affects.";
    case "PLAN_STRATEGY_MISMATCH":
      return "knowledgeStrategyReasons is empty or has entries missing .reason or .evidenceRef. Each reason must have both fields populated.";
    case "PLAN_EVIDENCE_INSUFFICIENT":
      return "Change node needs at least 2 distinct sources across citations[], codeEvidence[], and policyRefs[]. If you only have 1 source, set lowEvidenceGuard=true, uncertaintyNote, and requiresHumanReview=true.";
    case "PLAN_VERIFICATION_WEAK":
      return "Validate node is missing verificationHooks[], mapsToNodeIds[], or successCriteria. All three are required.";
    case "PLAN_POLICY_VIOLATION":
      return "A codemod citation references an unsupported codemod ID. Check the citation format: 'codemod:<id>@<version>' and ensure the codemod ID is in the supported catalog.";
    case "EXEC_UNGATED_SIDE_EFFECT":
      return "side_effect node needs sideEffectType, sideEffectPayloadRef, commitGateId, and must depend on at least one validate node.";
    case "PLAN_MISSING_ARTIFACT_REF":
      return "A change node cites an attachment (inbox:* or attachment:*) but the same ref is not in artifactRefs[]. Add matching entries to artifactRefs.";
    case "PLAN_MIGRATION_RULE_MISSING":
      return "Strategy is migration_adp_to_sdf but a change node has no MigrationRule citation. Add a policyRef or citation with prefix 'migration:' (e.g., 'migration:MR-001').";
    default:
      return `Rejection code '${code}' — check the plan schema and resubmit.`;
  }
}

export async function handleSubmitPlan(
  args: Record<string, unknown> | undefined,
  session: SessionState,
  currentState: RunState,
  memoryService?: MemoryService,
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

  // Query active memories for plan rule validation [REF:MEMORY-PLAN-RULES]
  let activeMemories: import("../../../contracts/memoryRecord").MemoryRecord[] = [];
  if (memoryService) {
    try {
      // Derive anchor IDs from plan's target files
      const targetFiles = planGraph.nodes
        .filter((n): n is import("../../../contracts/planGraph").ChangePlanNode => n.kind === "change")
        .map((n) => n.targetFile);
      const anchorIds = [...new Set(targetFiles.map((f) => {
        const parts = f.replace(/\\/g, "/").split("/");
        return parts.length > 1 ? `anchor:${parts.slice(0, 2).join("/")}` : `anchor:${parts[0]}`;
      }))];
      activeMemories = await memoryService.findActiveForAnchors(anchorIds);
    } catch {
      // Memory query failures are non-fatal
    }
  }

  // Use enforcement bundle computed during initialize_work (now a proper SessionState field)
  const enforcementBundle = session.enforcementBundle;

  const validation = validatePlanGraph(planGraph, activeMemories, enforcementBundle);
  if (!validation.ok) {
    denyReasons.push(...validation.rejectionCodes);
    result.error = `Plan rejected: ${validation.rejectionCodes.length} issue(s). See result.fixes for what to change.`;
    result.fixes = validation.rejectionCodes.map((code) => ({
      code,
      fix: planRejectionFix(code),
    }));
    if (validation.memoryRuleResults?.some((r) => !r.satisfied)) {
      result.failedMemoryRules = validation.memoryRuleResults
        .filter((r) => !r.satisfied)
        .map((r) => ({ memoryId: r.memoryId, condition: r.condition, denyCode: r.denyCode }));
    }
    if (validation.graphPolicyResults?.some((r) => !r.satisfied)) {
      result.failedGraphPolicies = validation.graphPolicyResults
        .filter((r) => !r.satisfied)
        .map((r) => ({ sourceNodeId: r.sourceNodeId, condition: r.condition, denyCode: r.denyCode }));
    }
    return { result, denyReasons, stateOverride: "PLANNING" };
  }

  // #25: Verify contextPackHash — plan must reference the current pack snapshot
  if (session.contextPack?.hash) {
    const planPackHash = planGraph.contextPackHash;
    if (planPackHash && planPackHash !== session.contextPack.hash) {
      denyReasons.push("PLAN_SCOPE_VIOLATION");
      result.error = `Plan contextPackHash ('${planPackHash}') does not match current session pack hash ('${session.contextPack.hash}'). The context pack may have been updated via escalate since the plan was drafted. Re-fetch the context pack and resubmit.`;
      return { result, denyReasons, stateOverride: "PLANNING" };
    }
  }

  /* ── Identity check (Architecture v2: workId is the permission key) ── */
  // workId and runSessionId MUST match — they scope the permission boundary.
  // agentId is tracking-only — sub-agents sharing a workId can submit plans.
  if (
    planGraph.workId !== session.workId ||
    planGraph.runSessionId !== session.runSessionId
  ) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.error = "Plan envelope workId and runSessionId must match the current session. "
      + "(agentId may differ — sub-agents sharing a workId are allowed to submit plans.)";
    result.mismatch = {
      expected: { workId: session.workId, runSessionId: session.runSessionId },
      received: { workId: planGraph.workId, runSessionId: planGraph.runSessionId },
    };
    return { result, denyReasons, stateOverride: "PLANNING" };
  }

  // Soft-log agentId mismatch for observability (not a hard gate)
  if (planGraph.agentId !== session.agentId) {
    result.agentIdNote = `Plan submitted by agent '${planGraph.agentId}' into session owned by '${session.agentId}'. This is allowed for sub-agent collaboration.`;
  }

  const worktreeCheck = validatePlanWorktreeRoot(planGraph.worktreeRoot, session.workId);
  if (!worktreeCheck.ok) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.planValidationError = worktreeCheck.reason;
    return { result, denyReasons, stateOverride: "PLANNING" };
  }

  session.planGraph = planGraph;
  session.scopeAllowlist = await loadScopeAllowlist(planGraph.scopeAllowlistRef);

  // Initialize progress tracking (Architecture v2 §8)
  const actionableNodes = planGraph.nodes.filter(
    (n: { kind: string }) => n.kind === "change" || n.kind === "validate" || n.kind === "side_effect"
  );
  session.planGraphProgress = {
    totalNodes: actionableNodes.length,
    completedNodes: 0,
    completedNodeIds: [],
  };

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
    result.error = `write_scratch_file failed: ${error instanceof Error ? error.message : "path escapes scratch scope"}. Ensure args.target is a relative path within the work scratch directory. Absolute paths and '..' traversals are forbidden.`;
  }

  return { result, denyReasons };
}
