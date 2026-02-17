/**
 * Evaluation Harness — golden tasks + metrics for retrieval/planning quality.
 * [REF:SEC-14] [REF:EVAL-TASKS] [REF:EVAL-METRICS]
 *
 * Defines golden tasks, runs them through the controller, and computes
 * quality metrics. This is the Phase 3 eval loop per [REF:ROADMAP-PHASES].
 */

/* ── Golden task definitions ─────────────────────────────── */

export interface GoldenTask {
  /** Unique name */
  id: string;
  /** Category per [REF:EVAL-TASKS] */
  category: "ui_table_flow" | "api_contract_change" | "migration_slice" | "debug_slice";
  /** Simulated prompt (as if from a Jira ticket) */
  prompt: string;
  /** Lexemes that should be detected */
  expectedLexemes: string[];
  /** Expected strategy ID */
  expectedStrategy: string;
  /** Expected anchors (entrypoint, definition) */
  expectedAnchors: {
    entrypoint?: string;
    definition?: string;
  };
  /** Whether proof chains are required */
  requiresAgGridProof: boolean;
  requiresFederationProof: boolean;
  /** Minimum expected anchor hit count */
  minAnchorHits: number;
  /** Whether the pack should be sufficient (no insufficiency) */
  expectPackSufficient: boolean;
}

export const GOLDEN_TASKS: GoldenTask[] = [
  {
    id: "golden-ui-table-flow",
    category: "ui_table_flow",
    prompt: "Add a new column to the TransactionHistoryTable ag-Grid that shows the transaction status with a custom CellRenderer. Clicking the status should navigate to /transactions/:id/detail.",
    expectedLexemes: ["ag-grid", "column", "cellrenderer", "transaction", "route"],
    expectedStrategy: "ui_aggrid_feature",
    expectedAnchors: { entrypoint: "TransactionHistoryTable" },
    requiresAgGridProof: true,
    requiresFederationProof: false,
    minAnchorHits: 1,
    expectPackSufficient: false, // Likely insufficient without graph data
  },
  {
    id: "golden-api-contract",
    category: "api_contract_change",
    prompt: "Update the /api/v2/accounts endpoint to include a new field 'preferredCurrency' in the AccountDTO schema. The Swagger spec at https://api.internal.com/swagger.json needs to match.",
    expectedLexemes: ["swagger", "endpoint", "api", "schema", "dto"],
    expectedStrategy: "api_contract_feature",
    expectedAnchors: { definition: "AccountDTO" },
    requiresAgGridProof: false,
    requiresFederationProof: false,
    minAnchorHits: 1,
    expectPackSufficient: false,
  },
  {
    id: "golden-migration-slice",
    category: "migration_slice",
    prompt: "Migrate the adp-date-picker component to sdf-date-picker across the KYC module. Ensure shadow DOM styling is updated and the FormBuilder validators are preserved.",
    expectedLexemes: ["adp-", "sdf-", "migration", "shadow", "formbuilder"],
    expectedStrategy: "migration_adp_to_sdf",
    expectedAnchors: {},
    requiresAgGridProof: false,
    requiresFederationProof: false,
    minAnchorHits: 0,
    expectPackSufficient: false,
  },
  {
    id: "golden-debug-slice",
    category: "debug_slice",
    prompt: "Users report an error 'Cannot read properties of undefined (reading map)' when clicking the Export button on the ReportsPage. The stack trace points to reports.service.ts line 142.",
    expectedLexemes: ["error", "stack", "undefined"],
    expectedStrategy: "debug_symptom_trace",
    expectedAnchors: { entrypoint: "ReportsPage" },
    requiresAgGridProof: false,
    requiresFederationProof: false,
    minAnchorHits: 0,
    expectPackSufficient: false,
  },
];

/* ── Eval run result ─────────────────────────────────────── */

export interface EvalTaskResult {
  taskId: string;
  category: GoldenTask["category"];
  /** Whether the correct strategy was selected */
  strategyCorrect: boolean;
  /** Selected strategy ID */
  actualStrategy: string;
  /** Whether any entrypoint anchor was found */
  anchorHit: boolean;
  /** Number of anchor hits */
  anchorHitCount: number;
  /** Whether federation proof was present when required */
  federationProofPresent: boolean;
  /** Whether ag-Grid origin chain was present when required */
  originChainPresent: boolean;
  /** Whether the pack was sufficient */
  packSufficient: boolean;
  /** Number of deny reasons */
  denyCount: number;
  /** Planning attempt count (how many turns before a plan could be submitted) */
  attemptCount: number;
  /** Errors encountered */
  errors: string[];
}

export interface EvalMetrics {
  /** % of tasks where correct strategy was selected */
  strategyAccuracy: number;
  /** % of tasks where entrypoint + definition anchors were found */
  anchorHitRate: number;
  /** % of federation-required tasks with federation proof */
  federationProofRate: number;
  /** % of ag-grid tasks with origin chain */
  originChainFoundRate: number;
  /** % of tasks where pack was sufficient (no insufficiency) */
  packSufficiencyRate: number;
  /** Average deny reasons per task */
  avgDenyCount: number;
  /** Total tasks evaluated */
  totalTasks: number;
  /** Per-category breakdown */
  perCategory: Record<string, {
    count: number;
    strategyAccuracy: number;
    anchorHitRate: number;
    packSufficiencyRate: number;
  }>;
}

/* ── Metrics computation ─────────────────────────────────── */

/**
 * Compute aggregate metrics from eval task results.
 * [REF:EVAL-METRICS]
 */
export function computeEvalMetrics(results: EvalTaskResult[]): EvalMetrics {
  if (results.length === 0) {
    return {
      strategyAccuracy: 0,
      anchorHitRate: 0,
      federationProofRate: 0,
      originChainFoundRate: 0,
      packSufficiencyRate: 0,
      avgDenyCount: 0,
      totalTasks: 0,
      perCategory: {},
    };
  }

  const total = results.length;
  const strategyCorrectCount = results.filter((r) => r.strategyCorrect).length;
  const anchorHitCount = results.filter((r) => r.anchorHit).length;
  const packSufficientCount = results.filter((r) => r.packSufficient).length;
  const totalDenyCount = results.reduce((sum, r) => sum + r.denyCount, 0);

  // Federation proof rate (only for tasks that require it)
  const fedRequired = results.filter((r) => {
    const golden = GOLDEN_TASKS.find((g) => g.id === r.taskId);
    return golden?.requiresFederationProof;
  });
  const fedPresent = fedRequired.filter((r) => r.federationProofPresent).length;
  const federationProofRate = fedRequired.length > 0 ? fedPresent / fedRequired.length : 1;

  // Origin chain rate (only for ag-grid tasks)
  const originRequired = results.filter((r) => {
    const golden = GOLDEN_TASKS.find((g) => g.id === r.taskId);
    return golden?.requiresAgGridProof;
  });
  const originPresent = originRequired.filter((r) => r.originChainPresent).length;
  const originChainFoundRate = originRequired.length > 0 ? originPresent / originRequired.length : 1;

  // Per-category breakdown
  const categories = [...new Set(results.map((r) => r.category))];
  const perCategory: EvalMetrics["perCategory"] = {};
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    perCategory[cat] = {
      count: catResults.length,
      strategyAccuracy: catResults.filter((r) => r.strategyCorrect).length / catResults.length,
      anchorHitRate: catResults.filter((r) => r.anchorHit).length / catResults.length,
      packSufficiencyRate: catResults.filter((r) => r.packSufficient).length / catResults.length,
    };
  }

  return {
    strategyAccuracy: strategyCorrectCount / total,
    anchorHitRate: anchorHitCount / total,
    federationProofRate,
    originChainFoundRate,
    packSufficiencyRate: packSufficientCount / total,
    avgDenyCount: totalDenyCount / total,
    totalTasks: total,
    perCategory,
  };
}

/**
 * Run a single golden task through a TurnController instance and collect evaluation data.
 * This is called by the eval harness script.
 */
export function evaluateResponse(
  task: GoldenTask,
  response: {
    knowledgeStrategy: { strategyId: string };
    result: Record<string, unknown>;
    denyReasons: string[];
    packInsufficiency?: { missingAnchors: Array<{ anchorType: string }> };
  },
  attemptCount: number = 1,
): EvalTaskResult {
  const actualStrategy = response.knowledgeStrategy.strategyId;
  const packSufficient = !response.packInsufficiency;

  // Check anchor hits
  const resultStr = JSON.stringify(response.result).toLowerCase();
  const entrypointHit = task.expectedAnchors.entrypoint
    ? resultStr.includes(task.expectedAnchors.entrypoint.toLowerCase())
    : false;
  const definitionHit = task.expectedAnchors.definition
    ? resultStr.includes(task.expectedAnchors.definition.toLowerCase())
    : false;
  const anchorHit = entrypointHit || definitionHit;
  const anchorHitCount = (entrypointHit ? 1 : 0) + (definitionHit ? 1 : 0);

  // Check proof chains
  const originChainPresent = !task.requiresAgGridProof || resultStr.includes("aggridoriginchain");
  const federationProofPresent = !task.requiresFederationProof || resultStr.includes("federationchain");

  const errors: string[] = [];
  if (response.result.error) errors.push(String(response.result.error));

  return {
    taskId: task.id,
    category: task.category,
    strategyCorrect: actualStrategy === task.expectedStrategy,
    actualStrategy,
    anchorHit,
    anchorHitCount,
    federationProofPresent,
    originChainPresent,
    packSufficient,
    denyCount: response.denyReasons.length,
    attemptCount,
    errors,
  };
}
