import test from "node:test";
import assert from "node:assert/strict";
import { validatePlanGraph } from "../src/domains/plan-graph/planGraphValidator";
import type { PlanGraphDocument } from "../src/contracts/planGraph";

function validPlan(): PlanGraphDocument {
  return {
    workId: "work_x",
    agentId: "agent_x",
    runSessionId: "run_x",
    repoSnapshotId: "snap_x",
    worktreeRoot: "/tmp/worktree",
    contextPackRef: "/tmp/pack.json",
    contextPackHash: "abc",
    policyVersionSet: { core: "1" },
    scopeAllowlistRef: "/tmp/allowlist.json",
    knowledgeStrategyId: "ui_aggrid_feature",
    knowledgeStrategyReasons: [{ reason: "default", evidenceRef: "lexeme:default" }],
    evidencePolicy: {
      minRequirementSources: 1,
      minCodeEvidenceSources: 1,
      minPolicySources: 0,
      allowSingleSourceWithGuard: true,
      lowEvidenceGuardRules: ["require review"],
      distinctSourceDefinition: "artifact-or-file-identity"
    },
    planFingerprint: "fp_x",
    sourceTraceRefs: ["trace_x"],
    schemaVersion: "1.0.0",
    nodes: [
      {
        nodeId: "node_1",
        kind: "change",
        dependsOn: [],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac1"],
          outOfScopeAcceptanceCriteriaIds: ["ac2"],
          inScopeModules: ["modA"],
          outOfScopeModules: ["modB"]
        },
        expectedFailureSignatures: ["sig_a"],
        correctionCandidateOnFail: true,
        operation: "modify",
        targetFile: "src/app.ts",
        targetSymbols: ["AppComponent"],
        whyThisFile: "contains target binding",
        editIntent: "update selector mapping",
        escalateIf: ["symbol_not_found"],
        citations: ["jira:1"],
        codeEvidence: ["sym:AppComponent"],
        artifactRefs: ["jira:1"],
        policyRefs: ["policy:no_adp"],
        verificationHooks: ["npm test -- app.spec.ts"]
      },
      {
        nodeId: "node_validate",
        kind: "validate",
        dependsOn: ["node_1"],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac1"],
          outOfScopeAcceptanceCriteriaIds: ["ac2"],
          inScopeModules: ["modA"],
          outOfScopeModules: ["modB"]
        },
        expectedFailureSignatures: ["sig_val"],
        correctionCandidateOnFail: true,
        verificationHooks: ["npm test -- app.spec.ts"],
        mapsToNodeIds: ["node_1"],
        successCriteria: "tests pass"
      },
      {
        nodeId: "node_side",
        kind: "side_effect",
        dependsOn: ["node_validate"],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac1"],
          outOfScopeAcceptanceCriteriaIds: ["ac2"],
          inScopeModules: ["modA"],
          outOfScopeModules: ["modB"]
        },
        expectedFailureSignatures: ["sig_side"],
        correctionCandidateOnFail: false,
        sideEffectType: "external_call",
        sideEffectPayloadRef: "artifact:side_effect",
        commitGateId: "gate_1"
      }
    ]
  };
}

test("valid plan passes", () => {
  const result = validatePlanGraph(validPlan());
  assert.equal(result.ok, true);
  assert.equal(result.rejectionCodes.length, 0);
});

test("missing evidence fails with rejection code", () => {
  const plan = validPlan();
  const changeNode = plan.nodes[0];
  if (changeNode.kind === "change") {
    changeNode.citations = [];
  }
  const result = validatePlanGraph(plan);
  assert.equal(result.ok, false);
  assert.ok(result.rejectionCodes.includes("PLAN_EVIDENCE_INSUFFICIENT"));
});

test("feature plans reject when code evidence category is missing", () => {
  const plan = validPlan();
  const changeNode = plan.nodes[0];
  if (changeNode.kind === "change") {
    changeNode.codeEvidence = [];
  }
  const result = validatePlanGraph(plan);
  assert.equal(result.ok, false);
  assert.ok(result.rejectionCodes.includes("PLAN_EVIDENCE_INSUFFICIENT"));
});

test("strategy reasons require evidence refs", () => {
  const plan = validPlan();
  plan.knowledgeStrategyReasons = [{ reason: "free text", evidenceRef: "" }];
  const result = validatePlanGraph(plan);
  assert.equal(result.ok, false);
  assert.ok(result.rejectionCodes.includes("PLAN_STRATEGY_MISMATCH"));
});

test("single-source evidence path rejects when low-evidence guard is missing", () => {
  const plan = validPlan();
  const changeNode = plan.nodes[0];
  if (changeNode.kind === "change") {
    changeNode.citations = ["same:file#1"];
    changeNode.codeEvidence = ["same:file#2"];
    changeNode.policyRefs = [];
    changeNode.lowEvidenceGuard = undefined;
    changeNode.uncertaintyNote = undefined;
    changeNode.requiresHumanReview = undefined;
  }
  const result = validatePlanGraph(plan);
  assert.equal(result.ok, false);
  assert.ok(result.rejectionCodes.includes("PLAN_EVIDENCE_INSUFFICIENT"));
});

test("side effect node must depend on validate nodes", () => {
  const plan = validPlan();
  const sideNode = plan.nodes[2];
  if (sideNode.kind === "side_effect") {
    sideNode.dependsOn = ["node_1"];
  }
  const result = validatePlanGraph(plan);
  assert.equal(result.ok, false);
  assert.ok(result.rejectionCodes.includes("EXEC_UNGATED_SIDE_EFFECT"));
});

test("escalate nodes require typed requestedEvidence entries", () => {
  const plan = validPlan();
  plan.nodes.push({
    nodeId: "node_escalate",
    kind: "escalate",
    dependsOn: ["node_validate"],
    atomicityBoundary: {
      inScopeAcceptanceCriteriaIds: ["ac1"],
      outOfScopeAcceptanceCriteriaIds: ["ac2"],
      inScopeModules: ["modA"],
      outOfScopeModules: ["modB"]
    },
    expectedFailureSignatures: ["sig_esc"],
    correctionCandidateOnFail: true,
    requestedEvidence: [
      {
        type: "artifact_fetch",
        detail: "fetch source"
      }
    ],
    blockingReasons: ["missing anchor"]
  });
  const result = validatePlanGraph(plan);
  assert.equal(result.ok, true);
});

test("rejects graph cycles as non-atomic", () => {
  const plan = validPlan();
  const change = plan.nodes[0];
  if (change.kind === "change") {
    change.dependsOn = ["node_validate"];
  }
  const result = validatePlanGraph(plan);
  assert.equal(result.ok, false);
  assert.ok(result.rejectionCodes.includes("PLAN_NOT_ATOMIC"));
});

test("rejects validate mappings that do not map to change nodes", () => {
  const plan = validPlan();
  const validate = plan.nodes[1];
  if (validate.kind === "validate") {
    validate.mapsToNodeIds = ["node_validate"];
  }
  const result = validatePlanGraph(plan);
  assert.equal(result.ok, false);
  assert.ok(result.rejectionCodes.includes("PLAN_NOT_ATOMIC"));
});

test("rejects change nodes with no validate mapping", () => {
  const plan = validPlan();
  const validate = plan.nodes[1];
  if (validate.kind === "validate") {
    validate.mapsToNodeIds = [];
  }
  const result = validatePlanGraph(plan);
  assert.equal(result.ok, false);
  assert.ok(result.rejectionCodes.includes("PLAN_NOT_ATOMIC"));
});

test("rejects unknown codemod citations", () => {
  const plan = validPlan();
  const change = plan.nodes[0];
  if (change.kind === "change") {
    change.citations.push("codemod:invented_custom_transform");
  }
  const result = validatePlanGraph(plan);
  assert.equal(result.ok, false);
  assert.ok(result.rejectionCodes.includes("PLAN_POLICY_VIOLATION"));
});
