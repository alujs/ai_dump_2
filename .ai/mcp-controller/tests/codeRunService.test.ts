import test from "node:test";
import assert from "node:assert/strict";
import { executeCodeRun } from "../src/domains/code-run/codeRunService";

test("code_run rejects non-async-IIFE preflight", async () => {
  const result = await executeCodeRun({
    nodeId: "node_a",
    iife: "(() => 1)()",
    declaredInputs: {},
    timeoutMs: 1000,
    memoryCapMb: 64,
    artifactOutputRef: "artifact://out",
    expectedReturnShape: {
      type: "number"
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.rejectionCode, "PLAN_MISSING_REQUIRED_FIELDS");
});

test("code_run rejects placeholder returns", async () => {
  const result = await executeCodeRun({
    nodeId: "node_b",
    iife: "(async () => 'placeholder result')()",
    declaredInputs: {},
    timeoutMs: 1000,
    memoryCapMb: 64,
    artifactOutputRef: "artifact://out",
    expectedReturnShape: {
      type: "string"
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.rejectionCode, "PLAN_VERIFICATION_WEAK");
});
