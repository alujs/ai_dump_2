import test from "node:test";
import assert from "node:assert/strict";
import { enforcePolicyRecipeRowInvariants, isPolicyOrRecipeNode, resolveConflict } from "../src/domains/graph-ops/graphOpsService";

test("policy/recipe seed row invariants reject missing version metadata", () => {
  const row = {
    kind: "node" as const,
    id: "policy:1",
    labels: ["Policy"],
    properties: {
      id: "policy:1",
      type: "policy",
      updated_at: "2026-02-16T00:00:00.000Z",
      updated_by: "tester"
    }
  };

  assert.equal(isPolicyOrRecipeNode(row), true);
  assert.throws(() => enforcePolicyRecipeRowInvariants(row), /GRAPH_SEED_INVARIANT_VIOLATION/);
});

test("non-policy rows are not treated as policy/recipe rows", () => {
  const row = {
    kind: "node" as const,
    id: "fact:1",
    labels: ["Fact"],
    properties: {
      id: "fact:1"
    }
  };

  assert.equal(isPolicyOrRecipeNode(row), false);
});

test("seed conflict resolution uses version then updated_at then updated_by", () => {
  const existing = {
    kind: "node" as const,
    id: "policy:1",
    labels: ["Policy"],
    properties: {
      id: "policy:1",
      type: "policy",
      version: 1,
      updated_at: "2026-02-15T00:00:00.000Z",
      updated_by: "alpha"
    }
  };
  const candidate = {
    kind: "node" as const,
    id: "policy:1",
    labels: ["Policy"],
    properties: {
      id: "policy:1",
      type: "policy",
      version: 2,
      updated_at: "2026-02-14T00:00:00.000Z",
      updated_by: "beta"
    }
  };

  const winner = resolveConflict(existing, candidate);
  assert.equal(winner, candidate);
});
