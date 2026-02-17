import test from "node:test";
import assert from "node:assert/strict";
import {
  GOLDEN_TASKS,
  computeEvalMetrics,
  evaluateResponse,
  type EvalTaskResult,
} from "../src/domains/evaluation/evaluationHarness";

test("GOLDEN_TASKS has all 4 required categories", () => {
  const categories = new Set(GOLDEN_TASKS.map((t) => t.category));
  assert.ok(categories.has("ui_table_flow"), "Missing ui_table_flow golden task");
  assert.ok(categories.has("api_contract_change"), "Missing api_contract_change golden task");
  assert.ok(categories.has("migration_slice"), "Missing migration_slice golden task");
  assert.ok(categories.has("debug_slice"), "Missing debug_slice golden task");
});

test("evaluateResponse detects correct strategy match", () => {
  const task = GOLDEN_TASKS.find((t) => t.category === "debug_slice")!;
  const result = evaluateResponse(task, {
    knowledgeStrategy: { strategyId: "debug_symptom_trace" },
    result: {},
    denyReasons: [],
  });
  assert.equal(result.strategyCorrect, true);
  assert.equal(result.actualStrategy, "debug_symptom_trace");
});

test("evaluateResponse detects incorrect strategy", () => {
  const task = GOLDEN_TASKS.find((t) => t.category === "debug_slice")!;
  const result = evaluateResponse(task, {
    knowledgeStrategy: { strategyId: "ui_aggrid_feature" },
    result: {},
    denyReasons: ["PLAN_STRATEGY_MISMATCH"],
  });
  assert.equal(result.strategyCorrect, false);
  assert.equal(result.denyCount, 1);
});

test("evaluateResponse detects pack insufficiency", () => {
  const task = GOLDEN_TASKS.find((t) => t.category === "ui_table_flow")!;
  const result = evaluateResponse(task, {
    knowledgeStrategy: { strategyId: "ui_aggrid_feature" },
    result: {},
    denyReasons: ["PACK_INSUFFICIENT"],
    packInsufficiency: {
      missingAnchors: [{ anchorType: "entrypoint" }],
    },
  });
  assert.equal(result.packSufficient, false);
});

test("computeEvalMetrics produces valid metrics", () => {
  const results: EvalTaskResult[] = [
    {
      taskId: "golden-ui-table-flow",
      category: "ui_table_flow",
      strategyCorrect: true,
      actualStrategy: "ui_aggrid_feature",
      anchorHit: true,
      anchorHitCount: 1,
      federationProofPresent: true,
      originChainPresent: false,
      packSufficient: false,
      denyCount: 2,
      attemptCount: 1,
      errors: [],
    },
    {
      taskId: "golden-debug-slice",
      category: "debug_slice",
      strategyCorrect: true,
      actualStrategy: "debug_symptom_trace",
      anchorHit: false,
      anchorHitCount: 0,
      federationProofPresent: true,
      originChainPresent: true,
      packSufficient: true,
      denyCount: 0,
      attemptCount: 1,
      errors: [],
    },
  ];

  const metrics = computeEvalMetrics(results);
  assert.equal(metrics.totalTasks, 2);
  assert.equal(metrics.strategyAccuracy, 1.0);
  assert.equal(metrics.anchorHitRate, 0.5);
  assert.equal(metrics.packSufficiencyRate, 0.5);
  assert.ok(metrics.perCategory["ui_table_flow"]);
  assert.ok(metrics.perCategory["debug_slice"]);
});

test("computeEvalMetrics handles empty results", () => {
  const metrics = computeEvalMetrics([]);
  assert.equal(metrics.totalTasks, 0);
  assert.equal(metrics.strategyAccuracy, 0);
  assert.equal(metrics.anchorHitRate, 0);
});
