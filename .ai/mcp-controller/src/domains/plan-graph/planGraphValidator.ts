import type { PlanGraphDocument, PlanNode, ChangePlanNode } from "../../contracts/planGraph";
import { validateChangeEvidencePolicy } from "../evidence-policy/evidencePolicyService";
import { isSupportedAstCodemodId } from "../patch-exec/astCodemodCatalog";

export interface ValidationResult {
  ok: boolean;
  rejectionCodes: string[];
}

export function validatePlanGraph(plan: PlanGraphDocument): ValidationResult {
  const rejectionCodes: string[] = [];

  validateEnvelope(plan, rejectionCodes);
  const graphFacts = validateNodeGraph(plan.nodes, rejectionCodes);
  validateStrategyReasons(plan, rejectionCodes);
  validateNodes(plan.nodes, plan.evidencePolicy, graphFacts, rejectionCodes);

  return {
    ok: rejectionCodes.length === 0,
    rejectionCodes: dedupe(rejectionCodes)
  };
}

function validateEnvelope(plan: PlanGraphDocument, rejectionCodes: string[]): void {
  const requiredStrings: Array<keyof PlanGraphDocument> = [
    "workId",
    "agentId",
    "runSessionId",
    "repoSnapshotId",
    "worktreeRoot",
    "contextPackRef",
    "contextPackHash",
    "scopeAllowlistRef",
    "knowledgeStrategyId",
    "planFingerprint",
    "schemaVersion"
  ];

  for (const key of requiredStrings) {
    const value = plan[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      rejectionCodes.push("PLAN_MISSING_REQUIRED_FIELDS");
      return;
    }
  }

  if (!plan.sourceTraceRefs.length) {
    rejectionCodes.push("PLAN_MISSING_REQUIRED_FIELDS");
  }
  if (!plan.knowledgeStrategyReasons.length) {
    rejectionCodes.push("PLAN_STRATEGY_MISMATCH");
  }
}

function validateStrategyReasons(plan: PlanGraphDocument, rejectionCodes: string[]): void {
  for (const reason of plan.knowledgeStrategyReasons) {
    if (!reason.reason || !reason.evidenceRef) {
      rejectionCodes.push("PLAN_STRATEGY_MISMATCH");
      return;
    }
  }
}

function validateNodes(
  nodes: PlanNode[],
  evidencePolicy: PlanGraphDocument["evidencePolicy"],
  graphFacts: {
    nodeIds: Set<string>;
    changeNodeIds: Set<string>;
    validateNodeIds: Set<string>;
  },
  rejectionCodes: string[]
): void {
  if (!nodes.length) {
    rejectionCodes.push("PLAN_MISSING_REQUIRED_FIELDS");
    return;
  }
  const mappedChangeIds = new Set<string>();

  for (const node of nodes) {
    if (!validateCommonNodeFields(node)) {
      rejectionCodes.push("PLAN_MISSING_REQUIRED_FIELDS");
      continue;
    }

    if (!node.dependsOn.every((dependency) => graphFacts.nodeIds.has(dependency))) {
      rejectionCodes.push("PLAN_NOT_ATOMIC");
    }

    switch (node.kind) {
      case "change":
        validateChangeNode(node, evidencePolicy, rejectionCodes);
        break;
      case "validate":
        if (!node.verificationHooks.length || !node.mapsToNodeIds.length || !node.successCriteria) {
          rejectionCodes.push("PLAN_VERIFICATION_WEAK");
        } else {
          for (const targetId of node.mapsToNodeIds) {
            if (!graphFacts.changeNodeIds.has(targetId)) {
              rejectionCodes.push("PLAN_NOT_ATOMIC");
            } else {
              mappedChangeIds.add(targetId);
            }
          }
        }
        break;
      case "escalate":
        if (!node.requestedEvidence.length || !node.blockingReasons.length) {
          rejectionCodes.push("PLAN_MISSING_REQUIRED_FIELDS");
          break;
        }
        if (
          node.requestedEvidence.some(
            (item) => item.type !== "artifact_fetch" && item.type !== "graph_expand" && item.type !== "pack_rebuild"
          )
        ) {
          rejectionCodes.push("PLAN_MISSING_REQUIRED_FIELDS");
        }
        break;
      case "side_effect":
        if (!node.sideEffectType || !node.sideEffectPayloadRef || !node.commitGateId) {
          rejectionCodes.push("EXEC_UNGATED_SIDE_EFFECT");
          break;
        }
        if (!node.dependsOn.some((dependency) => graphFacts.validateNodeIds.has(dependency))) {
          rejectionCodes.push("EXEC_UNGATED_SIDE_EFFECT");
        }
        break;
      default:
        rejectionCodes.push("PLAN_MISSING_REQUIRED_FIELDS");
        break;
    }
  }

  for (const changeNodeId of graphFacts.changeNodeIds) {
    if (!mappedChangeIds.has(changeNodeId)) {
      rejectionCodes.push("PLAN_NOT_ATOMIC");
    }
  }
}

function validateCommonNodeFields(node: PlanNode): boolean {
  if (!node.nodeId || !Array.isArray(node.dependsOn) || !Array.isArray(node.expectedFailureSignatures)) {
    return false;
  }

  const boundary = node.atomicityBoundary;
  if (!boundary) {
    return false;
  }

  if (
    !Array.isArray(boundary.inScopeAcceptanceCriteriaIds) ||
    !Array.isArray(boundary.outOfScopeAcceptanceCriteriaIds) ||
    !Array.isArray(boundary.inScopeModules) ||
    !Array.isArray(boundary.outOfScopeModules)
  ) {
    return false;
  }

  if (!boundary.inScopeAcceptanceCriteriaIds.length || !boundary.inScopeModules.length) {
    return false;
  }

  return true;
}

function validateNodeGraph(
  nodes: PlanNode[],
  rejectionCodes: string[]
): {
  nodeIds: Set<string>;
  changeNodeIds: Set<string>;
  validateNodeIds: Set<string>;
} {
  const nodeIds = new Set<string>();
  const changeNodeIds = new Set<string>();
  const validateNodeIds = new Set<string>();

  for (const node of nodes) {
    if (nodeIds.has(node.nodeId)) {
      rejectionCodes.push("PLAN_NOT_ATOMIC");
    }
    nodeIds.add(node.nodeId);
    if (node.kind === "change") {
      changeNodeIds.add(node.nodeId);
    }
    if (node.kind === "validate") {
      validateNodeIds.add(node.nodeId);
    }
  }

  if (hasDependencyCycle(nodes)) {
    rejectionCodes.push("PLAN_NOT_ATOMIC");
  }

  return {
    nodeIds,
    changeNodeIds,
    validateNodeIds
  };
}

function hasDependencyCycle(nodes: PlanNode[]): boolean {
  const deps = new Map<string, string[]>();
  for (const node of nodes) {
    deps.set(node.nodeId, node.dependsOn);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const node of nodes) {
    if (visit(node.nodeId, deps, visiting, visited)) {
      return true;
    }
  }
  return false;
}

function visit(
  nodeId: string,
  deps: Map<string, string[]>,
  visiting: Set<string>,
  visited: Set<string>
): boolean {
  if (visited.has(nodeId)) {
    return false;
  }
  if (visiting.has(nodeId)) {
    return true;
  }
  visiting.add(nodeId);
  for (const dependency of deps.get(nodeId) ?? []) {
    if (visit(dependency, deps, visiting, visited)) {
      return true;
    }
  }
  visiting.delete(nodeId);
  visited.add(nodeId);
  return false;
}

function validateChangeNode(
  node: ChangePlanNode,
  evidencePolicy: PlanGraphDocument["evidencePolicy"],
  rejectionCodes: string[]
): void {
  const requiredStrings = [node.operation, node.targetFile, node.whyThisFile, node.editIntent];
  if (requiredStrings.some((item) => !item || item.trim().length === 0)) {
    rejectionCodes.push("PLAN_MISSING_REQUIRED_FIELDS");
  }

  const hasSymbolCreationIntent = node.operation === "create" && node.editIntent.toLowerCase().includes("symbol-creation");
  if (!hasSymbolCreationIntent && !node.targetSymbols.length) {
    rejectionCodes.push("PLAN_SCOPE_VIOLATION");
  }

  if (!node.escalateIf.length || !node.artifactRefs.length || !node.verificationHooks.length) {
    rejectionCodes.push("PLAN_MISSING_REQUIRED_FIELDS");
  }

  const evidenceResult = validateChangeEvidencePolicy(node, evidencePolicy);
  if (!evidenceResult.ok) {
    rejectionCodes.push(...evidenceResult.rejectionCodes);
  }

  if (!node.citations.length || !node.codeEvidence.length) {
    rejectionCodes.push("PLAN_EVIDENCE_INSUFFICIENT");
  }
  validateCodemodCitations(node, rejectionCodes);

  const sourceCount = node.citations.length + node.codeEvidence.length + node.policyRefs.length;
  if (sourceCount < 2) {
    if (!evidencePolicy.allowSingleSourceWithGuard) {
      rejectionCodes.push("PLAN_EVIDENCE_INSUFFICIENT");
      return;
    }
    if (!node.lowEvidenceGuard || !node.uncertaintyNote || !node.requiresHumanReview) {
      rejectionCodes.push("PLAN_EVIDENCE_INSUFFICIENT");
    }
  }
}

function validateCodemodCitations(node: ChangePlanNode, rejectionCodes: string[]): void {
  for (const citation of node.citations) {
    if (!citation.startsWith("codemod:")) {
      continue;
    }
    const payload = citation.slice("codemod:".length);
    const codemodId = payload.split("@")[0]?.trim() ?? "";
    if (!codemodId || !isSupportedAstCodemodId(codemodId)) {
      rejectionCodes.push("PLAN_POLICY_VIOLATION");
    }
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
