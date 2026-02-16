import test from "node:test";
import assert from "node:assert/strict";
import { createContextPack } from "../src/domains/context-pack/contextPackService";

test("returns pack insufficiency when required anchors are missing", async () => {
  const output = await createContextPack({
    runSessionId: "run_test",
    workId: "work_test",
    originalPrompt: "Build a new ag-grid flow",
    strategyId: "ui_aggrid_feature",
    strategyReasons: [{ reason: "default", evidenceRef: "lexeme:default" }],
    taskConstraints: [],
    conflicts: [],
    activePolicies: [],
    policyVersionSet: {},
    allowedFiles: [],
    allowedCapabilities: [],
    validationPlan: [],
    missingness: [],
    requiresAgGridProof: true,
    requiresFederationProof: false
  });
  assert.ok(output.insufficiency);
  assert.ok(output.insufficiency?.missingAnchors.length);
});
