import test from "node:test";
import assert from "node:assert/strict";
import { selectStrategy } from "../src/domains/strategy/strategySelector";
import { computeContextSignature } from "../src/domains/strategy/contextSignature";

test("selects debug strategy for error-like prompts", () => {
  const selection = selectStrategy({
    originalPrompt: "I am getting an exception in this component",
    lexemes: ["stack", "failed"]
  });
  assert.equal(selection.strategyId, "debug_symptom_trace");
  assert.ok(selection.reasons.length > 0);
  // Verify ContextSignature is populated
  assert.ok(selection.contextSignature, "contextSignature must be present");
  assert.equal(selection.contextSignature.task_type_guess, "debug");
});

test("selects api contract strategy for swagger prompts", () => {
  const selection = selectStrategy({
    originalPrompt: "Add endpoint mapping from swagger",
    lexemes: ["swagger", "api"]
  });
  assert.equal(selection.strategyId, "api_contract_feature");
  assert.ok(selection.contextSignature.has_swagger);
});

test("selects migration strategy for adp lexemes", () => {
  const selection = selectStrategy({
    originalPrompt: "Migrate adp-date-picker to sdf-date-picker",
    lexemes: ["adp-", "sdf-", "migration"]
  });
  assert.equal(selection.strategyId, "migration_adp_to_sdf");
  assert.ok(selection.contextSignature.migration_adp_present);
});

test("selects ui_aggrid_feature by default", () => {
  const selection = selectStrategy({
    originalPrompt: "Add a new dashboard widget",
    lexemes: ["widget"]
  });
  assert.equal(selection.strategyId, "ui_aggrid_feature");
});

test("ContextSignature detects ag-grid signals", () => {
  const sig = computeContextSignature({
    originalPrompt: "Add a column to the ag-grid table with a custom cellRenderer",
    lexemes: ["ag-grid", "column", "cellRenderer"]
  });
  assert.equal(sig.mentions_aggrid, true);
  assert.equal(sig.task_type_guess, "ui_feature");
});

test("ContextSignature detects federation signals", () => {
  const sig = computeContextSignature({
    originalPrompt: "The microfrontend uses module federation to load the remote dashboard",
    lexemes: ["federation", "remote", "loadRemoteModule"]
  });
  assert.equal(sig.behind_federation_boundary, true);
});

test("ContextSignature detects shadow DOM signals", () => {
  const sig = computeContextSignature({
    originalPrompt: "The sdf-button component uses shadow DOM encapsulation",
    lexemes: ["sdf-button", "shadow", "encapsulation"]
  });
  assert.equal(sig.touches_shadow_dom, true);
  assert.equal(sig.sdf_contract_available, true);
});

test("ContextSignature uses Jira issue type for task_type_guess", () => {
  const sig = computeContextSignature({
    originalPrompt: "Fix the issue in the dashboard",
    lexemes: [],
    jiraFields: {
      issueType: "Bug",
      labels: [],
      components: [],
      summary: "Dashboard crashes on load",
      description: "When opening the dashboard, it throws an error"
    }
  });
  assert.equal(sig.task_type_guess, "debug");
});

test("ContextSignature enriched with artifacts", () => {
  const sig = computeContextSignature({
    originalPrompt: "Implement the new account endpoint",
    lexemes: [],
    artifacts: [{ source: "swagger", ref: "swagger:https://api.example.com/swagger.json" }]
  });
  assert.equal(sig.has_swagger, true);
});
