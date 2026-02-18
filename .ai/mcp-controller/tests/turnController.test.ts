import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventStore } from "../src/domains/observability/eventStore";
import { TurnController } from "../src/domains/controller/turnController";
import type { PlanGraphDocument } from "../src/contracts/planGraph";
import { readText, writeText } from "../src/shared/fileStore";
import { workRoot } from "../src/shared/fsPaths";

function validPlan(input: { workId: string; runSessionId: string; agentId: string; targetFile: string }): PlanGraphDocument {
  return {
    workId: input.workId,
    agentId: input.agentId,
    runSessionId: input.runSessionId,
    repoSnapshotId: "snap_test",
    worktreeRoot: workRoot(input.workId),
    contextPackRef: "/tmp/context_pack.json",
    contextPackHash: "hash_test",
    policyVersionSet: { core: "1" },
    scopeAllowlistRef: "/tmp/missing_allowlist.json",
    knowledgeStrategyId: "ui_aggrid_feature",
    knowledgeStrategyReasons: [{ reason: "default", evidenceRef: "lexeme:default" }],
    evidencePolicy: {
      minRequirementSources: 1,
      minCodeEvidenceSources: 1,
      minPolicySources: 0,
      allowSingleSourceWithGuard: true,
      lowEvidenceGuardRules: ["guard"],
      distinctSourceDefinition: "artifact-or-file"
    },
    planFingerprint: "fp_test",
    sourceTraceRefs: ["trace_test"],
    schemaVersion: "1.0.0",
    nodes: [
      {
        nodeId: "node_change",
        kind: "change",
        dependsOn: [],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac1"],
          outOfScopeAcceptanceCriteriaIds: ["ac2"],
          inScopeModules: ["m1"],
          outOfScopeModules: ["m2"]
        },
        expectedFailureSignatures: ["sig_a"],
        correctionCandidateOnFail: true,
        operation: "modify",
        targetFile: input.targetFile,
        targetSymbols: ["TargetSymbol"],
        whyThisFile: "contains target",
        editIntent: "replace token",
        escalateIf: ["symbol_missing"],
        citations: ["jira:123"],
        codeEvidence: ["src:TargetSymbol"],
        artifactRefs: ["jira:123"],
        policyRefs: [],
        verificationHooks: ["npm test"]
      },
      {
        nodeId: "node_validate",
        kind: "validate",
        dependsOn: ["node_change"],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac1"],
          outOfScopeAcceptanceCriteriaIds: ["ac2"],
          inScopeModules: ["m1"],
          outOfScopeModules: ["m2"]
        },
        expectedFailureSignatures: ["sig_b"],
        correctionCandidateOnFail: true,
        verificationHooks: ["npm test"],
        mapsToNodeIds: ["node_change"],
        successCriteria: "tests pass"
      }
    ]
  };
}

function anchors() {
  return {
    anchors: {
      entrypoint: "src/app/component.ts",
      definition: "AppComponent"
    }
  };
}

/** Helper: bootstrap a session by calling initialize_work first */
async function initSession(controller: TurnController, ids: { runSessionId: string; workId: string; agentId: string; prompt?: string }) {
  return controller.handleTurn({
    runSessionId: ids.runSessionId,
    workId: ids.workId,
    agentId: ids.agentId,
    originalPrompt: ids.prompt ?? "test task",
    verb: "initialize_work",
    args: { ...anchors(), lexemes: ["test"] },
  });
}

test("stores original prompt verbatim and resists prompt replacement", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  const first = await controller.handleTurn({
    runSessionId: "run_a",
    workId: "work_a",
    agentId: "agent_a",
    originalPrompt: "original prompt",
    verb: "initialize_work",
    args: { ...anchors(), lexemes: ["test"] }
  });
  // originalPrompt is now on the response envelope, not result
  assert.equal(first.originalPrompt, "original prompt");

  const second = await controller.handleTurn({
    runSessionId: "run_a",
    workId: "work_a",
    agentId: "agent_a",
    originalPrompt: "tampered prompt",
    verb: "read_file_lines",
    args: { ...anchors(), targetFile: "nonexistent.ts" }
  });
  assert.equal(second.originalPrompt, "original prompt");
});

test("blocks mutation before plan acceptance", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  const response = await controller.handleTurn({
    runSessionId: "run_b",
    workId: "work_b",
    agentId: "agent_b",
    originalPrompt: "quick task",
    verb: "apply_code_patch",
    args: {
      ...anchors(),
      nodeId: "node_change",
      targetFile: "target.txt",
      targetSymbols: ["TargetSymbol"],
      operation: "replace_text",
      find: "A",
      replace: "B"
    }
  });

  assert.ok(response.denyReasons.includes("PLAN_SCOPE_VIOLATION"));
});

test("pre-plan scratch write enforces scoped scratch root", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  const response = await controller.handleTurn({
    runSessionId: "run_scope",
    workId: "work_scope",
    agentId: "agent_scope",
    originalPrompt: "scratch write",
    verb: "write_tmp",
    args: {
      ...anchors(),
      target: "../outside.txt",
      content: "data"
    }
  });

  assert.ok(response.denyReasons.includes("PLAN_SCOPE_VIOLATION"));
});

test("patch_apply rejects symbols outside approved change node scope", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  const runSessionId = "run_patch_scope";
  const workId = "work_patch_scope";
  const agentId = "agent_patch_scope";
  const targetFile = "target.txt";
  await writeText(path.join(workRoot(workId), targetFile), "const token = 'A';\n");

  // Bootstrap session first
  await initSession(controller, { runSessionId, workId, agentId });

  const plan = validPlan({ workId, runSessionId, agentId, targetFile });
  await controller.handleTurn({
    runSessionId,
    workId,
    agentId,
    originalPrompt: "submit plan",
    verb: "submit_execution_plan",
    args: {
      ...anchors(),
      planGraph: plan
    }
  });

  const response = await controller.handleTurn({
    runSessionId,
    workId,
    agentId,
    originalPrompt: "apply patch",
    verb: "apply_code_patch",
    args: {
      ...anchors(),
      nodeId: "node_change",
      targetFile,
      targetSymbols: ["OtherSymbol"],
      operation: "replace_text",
      find: "A",
      replace: "B"
    }
  });

  assert.ok(response.denyReasons.includes("PLAN_SCOPE_VIOLATION"));
});

test("repeated failures create pending correction candidates", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  // Bootstrap session
  await initSession(controller, { runSessionId: "run_fails", workId: "work_fails", agentId: "agent_fails", prompt: "force rejection" });

  for (let i = 0; i < 3; i += 1) {
    await controller.handleTurn({
      runSessionId: "run_fails",
      workId: "work_fails",
      agentId: "agent_fails",
      originalPrompt: "force rejection",
      verb: "apply_code_patch",
      args: {
        ...anchors(),
        nodeId: "node_change",
        targetFile: "target.txt",
        targetSymbols: ["TargetSymbol"],
        operation: "replace_text",
        find: "A",
        replace: "B"
      }
    });
  }

  assert.ok(events.listPendingCorrections(10).length > 0);
});

test("recipe usage emits episodic event with required refs", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  // Bootstrap session first
  await initSession(controller, { runSessionId: "run_recipe", workId: "work_recipe", agentId: "agent_recipe", prompt: "run recipe" });

  const response = await controller.handleTurn({
    runSessionId: "run_recipe",
    workId: "work_recipe",
    agentId: "agent_recipe",
    originalPrompt: "run recipe",
    verb: "run_automation_recipe",
    args: {
      ...anchors(),
      recipeId: "replace_lexeme_in_file",
      planNodeId: "node_change",
      validatedParams: {
        targetFile: "src/app.ts",
        find: "A",
        replace: "B"
      },
      artifactBundleRef: "artifact://bundle",
      diffSummaryRef: "artifact://bundle/diff.summary.json"
    }
  });

  assert.equal(response.denyReasons.length, 0);
  const recent = events.listRecent(20);
  const usage = recent.find((event) => event.type === "recipe_usage");
  assert.ok(usage);
  assert.equal(String(usage?.payload.recipeId ?? ""), "replace_lexeme_in_file");
  assert.equal(String(usage?.payload.artifactBundleRef ?? ""), "artifact://bundle");
  assert.equal(String(usage?.payload.diffSummaryRef ?? ""), "artifact://bundle/diff.summary.json");
});

test("read_range returns scoped file content lines", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  const workId = "work_read_range";
  const relative = `.ai/tmp/work/${workId}/read-target.txt`;
  await writeText(path.join(workRoot(workId), "read-target.txt"), "line1\nline2\nline3\n");

  // Bootstrap session first
  await initSession(controller, { runSessionId: "run_read_range", workId, agentId: "agent_read_range", prompt: "read file slice" });

  const response = await controller.handleTurn({
    runSessionId: "run_read_range",
    workId,
    agentId: "agent_read_range",
    originalPrompt: "read file slice",
    verb: "read_file_lines",
    args: {
      ...anchors(),
      targetFile: relative,
      startLine: 2,
      endLine: 3
    }
  });

  assert.equal(response.denyReasons.length, 0);
  const readRange = response.result.readRange as
    | { targetFile?: string; lines?: Array<{ text?: string }> }
    | undefined;
  assert.equal(readRange?.targetFile, relative);
  assert.equal(Array.isArray(readRange?.lines), true);
  assert.equal(readRange?.lines?.[0]?.text, "line2");
});

test("ast codemod patch_apply requires codemod citation in plan node", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  const runSessionId = "run_ast_codemod_policy";
  const workId = "work_ast_codemod_policy";
  const agentId = "agent_ast_codemod_policy";
  const targetFile = "target.ts";
  await writeText(path.join(workRoot(workId), targetFile), "const TargetSymbol = 1;\n");

  // Bootstrap session first
  await initSession(controller, { runSessionId, workId, agentId });

  const plan = validPlan({ workId, runSessionId, agentId, targetFile });
  await controller.handleTurn({
    runSessionId,
    workId,
    agentId,
    originalPrompt: "submit plan",
    verb: "submit_execution_plan",
    args: {
      ...anchors(),
      planGraph: plan
    }
  });

  const response = await controller.handleTurn({
    runSessionId,
    workId,
    agentId,
    originalPrompt: "apply ast codemod",
    verb: "apply_code_patch",
    args: {
      ...anchors(),
      nodeId: "node_change",
      targetFile,
      targetSymbols: ["TargetSymbol"],
      operation: "ast_codemod",
      codemodId: "rename_identifier_in_file",
      codemodParams: {
        from: "TargetSymbol",
        to: "RenamedSymbol"
      }
    }
  });

  assert.ok(response.denyReasons.includes("PLAN_POLICY_VIOLATION"));
});

test("ast codemod patch_apply executes when citation is present", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  const runSessionId = "run_ast_codemod_ok";
  const workId = "work_ast_codemod_ok";
  const agentId = "agent_ast_codemod_ok";
  const targetFile = "target.ts";
  await writeText(path.join(workRoot(workId), targetFile), "const TargetSymbol = 1;\n");

  // Bootstrap session first
  await initSession(controller, { runSessionId, workId, agentId });

  const plan = validPlan({ workId, runSessionId, agentId, targetFile });
  const change = plan.nodes[0];
  if (change.kind === "change") {
    change.citations.push("codemod:rename_identifier_in_file");
  }
  await controller.handleTurn({
    runSessionId,
    workId,
    agentId,
    originalPrompt: "submit plan",
    verb: "submit_execution_plan",
    args: {
      ...anchors(),
      planGraph: plan
    }
  });

  const response = await controller.handleTurn({
    runSessionId,
    workId,
    agentId,
    originalPrompt: "apply ast codemod",
    verb: "apply_code_patch",
    args: {
      ...anchors(),
      nodeId: "node_change",
      targetFile,
      targetSymbols: ["TargetSymbol"],
      operation: "ast_codemod",
      codemodId: "rename_identifier_in_file",
      codemodParams: {
        from: "TargetSymbol",
        to: "RenamedSymbol"
      }
    }
  });

  assert.equal(response.denyReasons.length, 0);
  const updated = await readText(path.join(workRoot(workId), targetFile));
  assert.ok(updated.includes("RenamedSymbol"));
});

test("budget gate blocks non-safe verbs after threshold is exceeded", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  const blocked = await controller.handleTurn({
    runSessionId: "run_budget",
    workId: "work_budget",
    agentId: "agent_budget",
    originalPrompt: `p${"x".repeat(260_000)}`,
    verb: "apply_code_patch",
    args: {
      ...anchors(),
      nodeId: "node_change",
      targetFile: "sample.txt",
      targetSymbols: ["TargetSymbol"],
      operation: "replace_text",
      find: "foo",
      replace: "bar"
    }
  });

  assert.equal(blocked.state, "BLOCKED_BUDGET");
  assert.equal(blocked.budgetStatus.blocked, true);
  assert.ok(blocked.denyReasons.includes("BUDGET_THRESHOLD_EXCEEDED"));

  const safeVerb = await controller.handleTurn({
    runSessionId: "run_budget",
    workId: "work_budget",
    agentId: "agent_budget",
    originalPrompt: "safe follow-up",
    verb: "escalate",
    args: { ...anchors(), blockingReasons: ["budget exceeded, need guidance"] }
  });
  assert.equal(safeVerb.state, "BLOCKED_BUDGET");
  assert.equal(safeVerb.denyReasons.length, 0);
});

/* ── Phase 4 tests ───────────────────────────────────────── */

test("initialize_work returns symbols array (Phase 4)", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  const response = await initSession(controller, {
    runSessionId: "run_p4_sym",
    workId: "work_p4_sym",
    agentId: "agent_p4_sym",
    prompt: "test symbols",
  });

  assert.equal(response.denyReasons.length, 0);
  const contextPack = response.result.contextPack as Record<string, unknown>;
  assert.ok(contextPack);
  assert.ok(Array.isArray(contextPack.symbols));
});

/* ── Phase 5 tests ───────────────────────────────────────── */

test("enforcement bundle validates graph policy rules (Phase 5)", async () => {
  const { computeEnforcementBundle } = await import("../src/domains/plan-graph/enforcementBundle");
  const { validatePlanGraph } = await import("../src/domains/plan-graph/planGraphValidator");

  const bundle = computeEnforcementBundle(
    [], // no memory records
    [
      {
        id: "constraint:test_policy",
        type: "macro_constraint",
        grounded: true,
        condition: "All plans must include a validate step",
        enforcement: "hard_deny",
      },
    ],
    [], // no migration rules
  );

  assert.equal(bundle.graphPolicyRules.length, 1);
  assert.equal(bundle.advisoryPolicies.length, 0);

  // A plan with a validate node should satisfy the constraint
  const plan = validPlan({
    workId: "work_p5",
    runSessionId: "run_p5",
    agentId: "agent_p5",
    targetFile: "test.ts",
  });

  const result = validatePlanGraph(plan, [], bundle);
  // The plan already has a validate node, so the macro constraint should be satisfied
  assert.ok(!result.rejectionCodes.includes("PLAN_POLICY_VIOLATION") || result.graphPolicyResults?.some((r) => r.satisfied));
});

test("ungrounded graph policies are advisory-only (Phase 5)", async () => {
  const { computeEnforcementBundle } = await import("../src/domains/plan-graph/enforcementBundle");

  const bundle = computeEnforcementBundle(
    [],
    [
      {
        id: "intent:ungrounded",
        type: "ui_intent",
        grounded: false, // NOT grounded — no UsageExample link
        condition: "Use sdf-table for data display",
        enforcement: "hard_deny",
        requiredComponents: ["sdf-table"],
        forbiddenComponents: ["adp-table"],
      },
    ],
    [],
  );

  // Ungrounded policies should NOT produce enforceable rules
  assert.equal(bundle.graphPolicyRules.length, 0);
  assert.equal(bundle.advisoryPolicies.length, 1);
  assert.equal(bundle.advisoryPolicies[0].id, "intent:ungrounded");
});

/* ── Phase 6 tests ───────────────────────────────────────── */

test("plan denied if attachment citation lacks matching artifactRef (Phase 6)", async () => {
  const { validatePlanGraph } = await import("../src/domains/plan-graph/planGraphValidator");

  const plan = validPlan({
    workId: "work_p6",
    runSessionId: "run_p6",
    agentId: "agent_p6",
    targetFile: "test.ts",
  });

  // Add an attachment citation without a matching artifactRef
  const changeNode = plan.nodes[0];
  if (changeNode.kind === "change") {
    changeNode.citations.push("inbox:design-spec.pdf");
    // Do NOT add it to artifactRefs
  }

  const result = validatePlanGraph(plan, []);
  assert.ok(result.rejectionCodes.includes("PLAN_MISSING_ARTIFACT_REF"));
});

test("plan passes when attachment citation has matching artifactRef (Phase 6)", async () => {
  const { validatePlanGraph } = await import("../src/domains/plan-graph/planGraphValidator");

  const plan = validPlan({
    workId: "work_p6_ok",
    runSessionId: "run_p6_ok",
    agentId: "agent_p6_ok",
    targetFile: "test.ts",
  });

  // Add an attachment citation WITH matching artifactRef
  const changeNode = plan.nodes[0];
  if (changeNode.kind === "change") {
    changeNode.citations.push("inbox:design-spec.pdf");
    changeNode.artifactRefs.push("inbox:design-spec.pdf");
  }

  const result = validatePlanGraph(plan, []);
  assert.ok(!result.rejectionCodes.includes("PLAN_MISSING_ARTIFACT_REF"));
});

test("initialize_work includes attachment artifacts in response (Phase 6)", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  const response = await controller.handleTurn({
    runSessionId: "run_p6_att",
    workId: "work_p6_att",
    agentId: "agent_p6_att",
    originalPrompt: "test attachments",
    verb: "initialize_work",
    args: {
      ...anchors(),
      lexemes: ["test"],
      attachments: [
        { name: "spec.pdf", caption: "Product specification" },
      ],
    },
  });

  assert.equal(response.denyReasons.length, 0);
  const contextPack = response.result.contextPack as Record<string, unknown>;
  assert.ok(contextPack);
  assert.ok(Array.isArray(contextPack.attachments));
  const attachments = contextPack.attachments as Array<{ ref: string; caption: string }>;
  assert.ok(attachments.length > 0);
});

/* ── Phase 7 tests ───────────────────────────────────────── */

test("sub-agents share contextPack within same workId (Phase 7)", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  // Agent 1 initializes the session
  const init = await initSession(controller, {
    runSessionId: "run_p7",
    workId: "work_p7",
    agentId: "agent_p7_main",
    prompt: "multi-agent work",
  });
  assert.equal(init.state, "PLANNING");

  // Agent 2 joins the same workId — should inherit PLANNING state and contextPack
  const subAgent = await controller.handleTurn({
    runSessionId: "run_p7",
    workId: "work_p7",
    agentId: "agent_p7_sub",
    originalPrompt: "sub-agent task",
    verb: "read_file_lines",
    args: {
      ...anchors(),
      targetFile: "nonexistent.ts",
    },
  });

  // Sub-agent should be in PLANNING state (inherited), not UNINITIALIZED
  assert.notEqual(subAgent.state, "UNINITIALIZED");
});

test("auto-assign agentId when missing (Phase 7)", async () => {
  const { resolveAgentId } = await import("../src/domains/controller/session");

  const autoId = resolveAgentId(undefined);
  assert.ok(autoId.length > 0);
  assert.ok(autoId.startsWith("agent_"));

  const autoIdEmpty = resolveAgentId("");
  assert.ok(autoIdEmpty.length > 0);

  const explicit = resolveAgentId("my_agent_123");
  assert.equal(explicit, "my_agent_123");
});

test("per-agent action tracking is independent (Phase 7)", async () => {
  const events = new EventStore();
  const controller = new TurnController(events);

  // Initialize with agent 1
  await initSession(controller, {
    runSessionId: "run_p7_track",
    workId: "work_p7_track",
    agentId: "agent_p7_a",
    prompt: "tracking test",
  });

  // Agent 2 calls a verb
  await controller.handleTurn({
    runSessionId: "run_p7_track",
    workId: "work_p7_track",
    agentId: "agent_p7_b",
    originalPrompt: "tracking test",
    verb: "escalate",
    args: { ...anchors(), need: "more context" },
  });

  // Verify both agents are tracked
  const summaries = controller.runSummaries();
  const agents = summaries.filter((s) => s.workId === "work_p7_track");
  assert.ok(agents.length >= 2);
  assert.ok(agents.some((a) => a.agentId === "agent_p7_a"));
  assert.ok(agents.some((a) => a.agentId === "agent_p7_b"));
});
