export type PlanNodeKind = "change" | "validate" | "escalate" | "side_effect";

export interface AtomicityBoundary {
  inScopeAcceptanceCriteriaIds: string[];
  outOfScopeAcceptanceCriteriaIds: string[];
  inScopeModules: string[];
  outOfScopeModules: string[];
}

export interface BasePlanNode {
  nodeId: string;
  kind: PlanNodeKind;
  dependsOn: string[];
  atomicityBoundary: AtomicityBoundary;
  expectedFailureSignatures: string[];
  correctionCandidateOnFail: boolean;
}

export interface ChangePlanNode extends BasePlanNode {
  kind: "change";
  operation: "create" | "modify" | "delete";
  targetFile: string;
  targetSymbols: string[];
  whyThisFile: string;
  editIntent: string;
  escalateIf: string[];
  citations: string[];
  codeEvidence: string[];
  artifactRefs: string[];
  policyRefs: string[];
  verificationHooks: string[];
  fewShotRefs?: string[];
  recipeRefs?: string[];
  lowEvidenceGuard?: boolean;
  uncertaintyNote?: string;
  requiresHumanReview?: boolean;
}

export interface ValidatePlanNode extends BasePlanNode {
  kind: "validate";
  verificationHooks: string[];
  mapsToNodeIds: string[];
  successCriteria: string;
}

export interface EscalatePlanNode extends BasePlanNode {
  kind: "escalate";
  requestedEvidence: Array<{
    type: "artifact_fetch" | "graph_expand" | "pack_rebuild";
    detail: string;
  }>;
  blockingReasons: string[];
  proposedNextStrategyId?: string;
}

export interface SideEffectPlanNode extends BasePlanNode {
  kind: "side_effect";
  sideEffectType: string;
  sideEffectPayloadRef: string;
  commitGateId: string;
}

export type PlanNode = ChangePlanNode | ValidatePlanNode | EscalatePlanNode | SideEffectPlanNode;

export interface EvidencePolicy {
  minRequirementSources: number;
  minCodeEvidenceSources: number;
  minPolicySources: number;
  allowSingleSourceWithGuard: boolean;
  lowEvidenceGuardRules: string[];
  distinctSourceDefinition: string;
}

export interface PlanGraphDocument {
  workId: string;
  agentId: string;
  runSessionId: string;
  repoSnapshotId: string;
  worktreeRoot: string;
  contextPackRef: string;
  contextPackHash: string;
  policyVersionSet: Record<string, string>;
  scopeAllowlistRef: string;
  knowledgeStrategyId: string;
  knowledgeStrategyReasons: Array<{ reason: string; evidenceRef: string }>;
  evidencePolicy: EvidencePolicy;
  planFingerprint: string;
  sourceTraceRefs: string[];
  schemaVersion: string;
  nodes: PlanNode[];
}
