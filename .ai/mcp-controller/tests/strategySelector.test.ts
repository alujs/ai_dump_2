import test from "node:test";
import assert from "node:assert/strict";
import { selectStrategy } from "../src/domains/strategy/strategySelector";

test("selects debug strategy for error-like prompts", () => {
  const selection = selectStrategy({
    originalPrompt: "I am getting an exception in this component",
    lexemes: ["stack", "failed"]
  });
  assert.equal(selection.strategyId, "debug_symptom_trace");
  assert.ok(selection.reasons.length > 0);
});

test("selects api contract strategy for swagger prompts", () => {
  const selection = selectStrategy({
    originalPrompt: "Add endpoint mapping from swagger",
    lexemes: ["swagger", "api"]
  });
  assert.equal(selection.strategyId, "api_contract_feature");
});
