import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAndExpandQuery } from "../src/domains/context-pack/glossaryNormalization";
import { rerankRetrieval } from "../src/domains/context-pack/retrievalReranker";

test("glossary expansion applies seed aliases conservatively", async () => {
  const expanded = await normalizeAndExpandQuery("org payroll toggle");
  assert.ok(expanded.expandedTerms.includes("organization"));
  assert.ok(expanded.expandedTerms.includes("legal"));
  assert.ok(expanded.expandedTerms.includes("entity"));
  assert.ok(expanded.expansions.some((item) => item.source === "policy_seed"));
});

test("negative alias suppresses unsafe expansion", async () => {
  const expanded = await normalizeAndExpandQuery("org leave balance");
  assert.equal(expanded.expandedTerms.includes("organization"), false);
});

test("reranker penalizes hub gravity and keeps deterministic ordering", () => {
  const reranked = rerankRetrieval({
    lexicalLane: [
      {
        filePath: "src/app/shared/utils.ts",
        line: 10,
        preview: "export const organizationBalance = ...",
        score: 0.95
      },
      {
        filePath: "src/app/payroll/org-balance-routing.module.ts",
        line: 8,
        preview: "const routes: Routes = [{ path: 'balance' }]",
        score: 0.72
      }
    ],
    symbolLane: [],
    queryNormalization: {
      originalQuery: "org balance route",
      expandedQuery: "balance org organization route routing",
      normalizedTerms: ["balance", "org", "route"],
      expandedTerms: ["balance", "org", "organization", "route", "routing"],
      expansions: []
    },
    activePolicies: ["policy:core:no_adp"]
  });

  assert.equal(reranked.topLexical[0].filePath, "src/app/payroll/org-balance-routing.module.ts");
  assert.ok(reranked.topLexical[0].reasons.includes("route_or_nav_boost"));
  assert.ok(reranked.topLexical[1].reasons.includes("hub_penalty"));
});
