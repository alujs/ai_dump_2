/**
 * Strategy selection — deterministic from ContextSignature.
 * [REF:STRATEGY-DEF] [REF:STRATEGY-SELECTION] [REF:CONTEXTSIGNATURE]
 */
import {
  computeContextSignature,
  type ContextSignature,
  type ContextSignatureInput,
} from "./contextSignature";

export type StrategyId =
  | "ui_aggrid_feature"
  | "api_contract_feature"
  | "migration_adp_to_sdf"
  | "debug_symptom_trace";

export interface StrategySelection {
  strategyId: StrategyId;
  contextSignature: ContextSignature;
  reasons: Array<{ reason: string; evidenceRef: string }>;
}

/**
 * Select a strategy deterministically from the ContextSignature feature vector.
 * Accepts the full ContextSignatureInput so the signature is computed in one place.
 *
 * Backward-compatible: callers that only pass { originalPrompt, lexemes } still work.
 */
export function selectStrategy(input: ContextSignatureInput): StrategySelection {
  const sig = computeContextSignature(input);
  const reasons: Array<{ reason: string; evidenceRef: string }> = [];

  /* ── Decision table (deterministic from feature vector) ── */

  // Migration takes priority — it's a controlled transformation [REF:MIGRATION-FEATURE]
  if (sig.migration_adp_present) {
    reasons.push({
      reason: "ContextSignature.migration_adp_present=true; adp→sdf migration lexemes or Jira labels detected.",
      evidenceRef: "[REF:MIGRATION-FEATURE]",
    });
    if (sig.touches_shadow_dom) {
      reasons.push({
        reason: "ContextSignature.touches_shadow_dom=true; shadow DOM testing confidence rules apply.",
        evidenceRef: "[REF:POLICY-SHADOW]",
      });
    }
    if (sig.sdf_contract_available) {
      reasons.push({
        reason: "ContextSignature.sdf_contract_available=true; SDF contract index can validate legal props.",
        evidenceRef: "[REF:SDF-INDEX-RULE]",
      });
    }
    return { strategyId: "migration_adp_to_sdf", contextSignature: sig, reasons };
  }

  // Debug — Jira bug type or strong debug signals [REF:DEBUG-FEATURE]
  if (sig.task_type_guess === "debug") {
    reasons.push({
      reason: `ContextSignature.task_type_guess=debug; symptom→behavior chain→candidates flow activated.`,
      evidenceRef: "[REF:DEBUG-FEATURE]",
    });
    if (sig.test_confidence_level === "low" || sig.test_confidence_level === "none") {
      reasons.push({
        reason: `ContextSignature.test_confidence_level=${sig.test_confidence_level}; validation plan will require additional test generation.`,
        evidenceRef: "[REF:PG-SHADOW-VERIFY]",
      });
    }
    return { strategyId: "debug_symptom_trace", contextSignature: sig, reasons };
  }

  // API contract — swagger artifacts or strong API signals [REF:API-FEATURE]
  if (sig.has_swagger || sig.task_type_guess === "api_contract") {
    reasons.push({
      reason: "ContextSignature.has_swagger=true; anchor on Swagger endpoints and DTO symbol mappings.",
      evidenceRef: "[REF:API-FEATURE]",
    });
    if (sig.behind_federation_boundary) {
      reasons.push({
        reason: "ContextSignature.behind_federation_boundary=true; federation proof chain required.",
        evidenceRef: "[REF:POLICY-FED-PROOF]",
      });
    }
    return { strategyId: "api_contract_feature", contextSignature: sig, reasons };
  }

  // Default: UI/ag-Grid feature [REF:UI-FEATURE]
  reasons.push({
    reason: "ContextSignature defaulted to UI feature strategy.",
    evidenceRef: "[REF:UI-FEATURE]",
  });
  if (sig.mentions_aggrid) {
    reasons.push({
      reason: "ContextSignature.mentions_aggrid=true; ag-Grid origin proof chain required.",
      evidenceRef: "[REF:CHAIN-AGGRID]",
    });
  }
  if (sig.behind_federation_boundary) {
    reasons.push({
      reason: "ContextSignature.behind_federation_boundary=true; federation proof chain required.",
      evidenceRef: "[REF:CHAIN-FEDERATION]",
    });
  }
  if (sig.touches_shadow_dom) {
    reasons.push({
      reason: "ContextSignature.touches_shadow_dom=true; shadow-aware verification hooks needed.",
      evidenceRef: "[REF:PG-SHADOW-VERIFY]",
    });
  }

  return { strategyId: "ui_aggrid_feature", contextSignature: sig, reasons };
}

export function recommendedSubAgentSplits(strategyId: StrategyId): string[] {
  switch (strategyId) {
    case "migration_adp_to_sdf":
      return ["policy-review", "selector-audit", "migration-examples"];
    case "debug_symptom_trace":
      return ["error-trace-mapping", "symbol-root-cause", "targeted-validation"];
    case "api_contract_feature":
      return ["swagger-anchoring", "dto-symbol-mapping", "e2e-contract-validation"];
    case "ui_aggrid_feature":
    default:
      return ["origin-proof-chain", "component-layer-separation", "e2e-shadow-a11y"];
  }
}
