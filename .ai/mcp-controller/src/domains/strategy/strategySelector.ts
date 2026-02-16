export type StrategyId =
  | "ui_aggrid_feature"
  | "api_contract_feature"
  | "migration_adp_to_sdf"
  | "debug_symptom_trace";

export interface StrategySelection {
  strategyId: StrategyId;
  reasons: Array<{ reason: string; evidenceRef: string }>;
}

export function selectStrategy(input: {
  originalPrompt: string;
  lexemes: string[];
}): StrategySelection {
  const fullText = `${input.originalPrompt}\n${input.lexemes.join(" ")}`.toLowerCase();

  if (matchesAny(fullText, ["adp-", "migration", "sdf-", "legacy"])) {
    return {
      strategyId: "migration_adp_to_sdf",
      reasons: [
        {
          reason: "Legacy migration lexemes detected; prioritize policy-safe migration path.",
          evidenceRef: "lexeme:migration"
        }
      ]
    };
  }

  if (matchesAny(fullText, ["error", "exception", "stack", "failed", "bug"])) {
    return {
      strategyId: "debug_symptom_trace",
      reasons: [
        {
          reason: "Debug lexemes detected; use language-pack-to-AST debugging flow.",
          evidenceRef: "lexeme:debug"
        }
      ]
    };
  }

  if (matchesAny(fullText, ["swagger", "endpoint", "api", "schema"])) {
    return {
      strategyId: "api_contract_feature",
      reasons: [
        {
          reason: "Contract lexemes detected; anchor on Swagger and symbol mappings.",
          evidenceRef: "lexeme:api_contract"
        }
      ]
    };
  }

  return {
    strategyId: "ui_aggrid_feature",
    reasons: [
      {
        reason: "Defaulting to UI feature strategy with ag-grid/federation proof-chain checks.",
        evidenceRef: "strategy:default_ui"
      }
    ]
  };
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

function matchesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
