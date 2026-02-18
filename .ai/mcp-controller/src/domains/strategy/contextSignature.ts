/**
 * ContextSignature — deterministic feature vector for strategy selection.
 * [REF:CONTEXTSIGNATURE] [REF:CONTEXTSIGNATURE-FEATURES]
 *
 * No LLM. No embeddings. Computed from lexemes, anchors, graph state,
 * and session artifacts. Strategy selection is a pure function of this vector.
 */

export interface ContextSignature {
  /** Swagger/OpenAPI lexemes or artifacts present */
  has_swagger: boolean;
  /** ag-Grid lexemes detected (column, renderer, row model, etc.) */
  mentions_aggrid: boolean;
  /** Federation lexemes or federation chain anchors present */
  behind_federation_boundary: boolean;
  /** Shadow DOM / sdf-* / web component lexemes detected */
  touches_shadow_dom: boolean;
  /** adp-* migration lexemes present */
  migration_adp_present: boolean;
  /** SDF contract index or sdf-* usage detected */
  sdf_contract_available: boolean;
  /** Test confidence: "high" | "medium" | "low" | "none" */
  test_confidence_level: "high" | "medium" | "low" | "none";
  /** Inferred task type from lexeme analysis */
  task_type_guess: "ui_feature" | "api_contract" | "migration" | "debug" | "unknown";
  /** Route guards / auth / role / permission signals detected */
  has_route_guards: boolean;
  /** Template-level custom directives detected (resolved from AST, not hardcoded) */
  has_template_directives: boolean;
}

export interface ContextSignatureInput {
  originalPrompt: string;
  lexemes: string[];
  /** Artifacts already fetched in this session (Jira, Swagger, etc.) */
  artifacts?: Array<{ source: string; ref: string; metadata?: Record<string, unknown> }>;
  /** Anchor state from context pack input */
  anchors?: {
    entrypoint?: string;
    definition?: string;
    agGridOriginChain?: string[];
    federationChain?: string[];
  };
  /** Symbol matches from indexing (if available) */
  symbolHits?: Array<{ symbol: string; kind: string; filePath: string }>;
  /** Jira ticket fields (if fetched) */
  jiraFields?: {
    issueType?: string;
    labels?: string[];
    components?: string[];
    summary?: string;
    description?: string;
  };
  /** Route guard metadata from indexer (if available) */
  guardNames?: string[];
  guardArgs?: string[];
  /** Role/permission directive metadata from indexer (if available) */
  directiveNames?: string[];
  directiveExpressions?: string[];
}

/* ── Lexeme class detectors ──────────────────────────────── */

const SWAGGER_SIGNALS = [
  "swagger", "openapi", "endpoint", "api", "schema", "dto",
  "rest", "contract", "/api/", "requestbody", "responsebody",
  "paths", "operationid"
];

const AGGRID_SIGNALS = [
  "ag-grid", "aggrid", "agGrid", "column", "columndef", "columnDef",
  "cellrenderer", "cellRenderer", "rowmodel", "rowModel", "gridoptions",
  "gridOptions", "getrows", "valuegetter", "valueGetter", "cellclass",
  "headerName", "field:", "colDef"
];

const FEDERATION_SIGNALS = [
  "federation", "federated", "remote", "module federation",
  "loadremotemodule", "loadRemoteModule", "exposes",
  "shared", "host", "micro-frontend", "microfrontend",
  "webpack.config", "remoteentry"
];

const SHADOW_DOM_SIGNALS = [
  "shadow", "shadowroot", "shadowRoot", "shadow-dom",
  "sdf-", "web-component", "webcomponent", "custom-element",
  "customElements", ":host", "::slotted", "encapsulation"
];

const MIGRATION_ADP_SIGNALS = [
  "adp-", "adp_", "migration", "migrate", "legacy",
  "deprecated", "adp2sdf", "adp-to-sdf"
];

const SDF_SIGNALS = [
  "sdf-", "sdf_", "SdfContractIndex", "sdf-button",
  "sdf-input", "sdf-select", "sdf-icon", "sdf-dialog",
  "sdf-tooltip", "sdf-table"
];

const DEBUG_SIGNALS = [
  "error", "exception", "stacktrace", "stack trace", "failed",
  "bug", "crash", "symptom", "broken", "regression", "defect",
  "fix", "hotfix", "root cause", "investigate", "debug"
];

const GUARD_SIGNALS = [
  "guard", "canactivate", "canmatch", "candeactivate", "canactivatechild",
  "authguard", "roleguard", "permissionguard", "sessionguard",
  "role", "permission", "acl", "access control", "authorize",
  "isauthorized", "hasrole", "haspermission", "roles.ts",
  "permissions.ts", "auth.guard", "role.guard"
];

// NOTE: No hardcoded DIRECTIVE_SIGNALS list.
// has_template_directives is computed from resolved indexer data
// (directiveNames/directiveExpressions), not from pattern matching.
// The guard signals above are retained because guard detection also serves
// as a prompt heuristic (before indexing runs), but directive detection is
// purely fact-driven from the AST.

const TEST_HIGH_SIGNALS = ["cypress", "e2e", "integration test", "spec.ts"];
const TEST_MED_SIGNALS = ["unit test", "jasmine", "karma", "jest", ".spec."];
const TEST_LOW_SIGNALS = ["test", "describe(", "it(", "expect("];

/* ── Core computation ────────────────────────────────────── */

/**
 * Compute a ContextSignature from available inputs.
 * Pure function — no side effects, no I/O.
 */
export function computeContextSignature(input: ContextSignatureInput): ContextSignature {
  // Build a single searchable corpus from all text sources
  const corpus = buildCorpus(input);

  const has_swagger = matchesAnySignal(corpus, SWAGGER_SIGNALS)
    || hasArtifact(input.artifacts, "swagger");

  const mentions_aggrid = matchesAnySignal(corpus, AGGRID_SIGNALS)
    || (input.anchors?.agGridOriginChain?.length ?? 0) > 0;

  const behind_federation_boundary = matchesAnySignal(corpus, FEDERATION_SIGNALS)
    || (input.anchors?.federationChain?.length ?? 0) > 0
    || hasJiraLabel(input.jiraFields, "federation");

  const touches_shadow_dom = matchesAnySignal(corpus, SHADOW_DOM_SIGNALS);

  const migration_adp_present = matchesAnySignal(corpus, MIGRATION_ADP_SIGNALS)
    || hasJiraLabel(input.jiraFields, "migration");

  const sdf_contract_available = matchesAnySignal(corpus, SDF_SIGNALS)
    || hasSdfSymbol(input.symbolHits);

  const test_confidence_level = computeTestConfidence(corpus, input.symbolHits);

  const task_type_guess = inferTaskType({
    has_swagger,
    mentions_aggrid,
    migration_adp_present,
    isDebug: matchesAnySignal(corpus, DEBUG_SIGNALS),
    jiraIssueType: input.jiraFields?.issueType,
  });

  const has_route_guards = matchesAnySignal(corpus, GUARD_SIGNALS)
    || (input.guardNames?.length ?? 0) > 0
    || hasJiraLabel(input.jiraFields, "role")
    || hasJiraLabel(input.jiraFields, "permission")
    || hasJiraLabel(input.jiraFields, "guard");

  // has_template_directives is computed purely from resolved indexer data.
  // If the indexer found custom directives in templates, this fires.
  // No hardcoded pattern list — the AST extraction is generic.
  const has_template_directives = (input.directiveNames?.length ?? 0) > 0
    || (input.directiveExpressions?.length ?? 0) > 0;

  return {
    has_swagger,
    mentions_aggrid,
    behind_federation_boundary,
    touches_shadow_dom,
    migration_adp_present,
    sdf_contract_available,
    test_confidence_level,
    task_type_guess,
    has_route_guards,
    has_template_directives,
  };
}

/* ── Internal helpers ────────────────────────────────────── */

function buildCorpus(input: ContextSignatureInput): string {
  const parts: string[] = [
    input.originalPrompt,
    ...input.lexemes,
  ];

  // Include Jira ticket text if available
  if (input.jiraFields?.summary) parts.push(input.jiraFields.summary);
  if (input.jiraFields?.description) parts.push(input.jiraFields.description);
  if (input.jiraFields?.labels) parts.push(...input.jiraFields.labels);
  if (input.jiraFields?.components) parts.push(...input.jiraFields.components);

  // Include artifact refs
  if (input.artifacts) {
    for (const a of input.artifacts) {
      parts.push(a.ref);
      if (a.metadata) {
        const keys = Object.keys(a.metadata);
        parts.push(...keys);
      }
    }
  }

  // Include symbol hit kinds/names
  if (input.symbolHits) {
    for (const s of input.symbolHits) {
      parts.push(s.symbol, s.kind, s.filePath);
    }
  }

  // Include guard metadata (names + arguments like role strings)
  if (input.guardNames) parts.push(...input.guardNames);
  if (input.guardArgs) parts.push(...input.guardArgs);

  // Include directive metadata (names + bound expressions like role strings)
  if (input.directiveNames) parts.push(...input.directiveNames);
  if (input.directiveExpressions) parts.push(...input.directiveExpressions);

  return parts.join("\n").toLowerCase();
}

function matchesAnySignal(corpus: string, signals: string[]): boolean {
  return signals.some((signal) => corpus.includes(signal.toLowerCase()));
}

function hasArtifact(
  artifacts: ContextSignatureInput["artifacts"],
  source: string
): boolean {
  if (!artifacts) return false;
  return artifacts.some((a) => a.source === source);
}

function hasJiraLabel(
  jiraFields: ContextSignatureInput["jiraFields"],
  label: string
): boolean {
  if (!jiraFields?.labels) return false;
  const lower = label.toLowerCase();
  return jiraFields.labels.some((l) => l.toLowerCase().includes(lower));
}

function hasSdfSymbol(
  symbolHits: ContextSignatureInput["symbolHits"]
): boolean {
  if (!symbolHits) return false;
  return symbolHits.some((s) =>
    s.symbol.toLowerCase().startsWith("sdf") || s.filePath.includes("sdf")
  );
}

function computeTestConfidence(
  corpus: string,
  symbolHits: ContextSignatureInput["symbolHits"]
): ContextSignature["test_confidence_level"] {
  // Check symbol hits for test files
  const hasTestFiles = symbolHits?.some((s) =>
    s.filePath.includes(".spec.") || s.filePath.includes(".test.") || s.filePath.includes("e2e")
  ) ?? false;

  if (matchesAnySignal(corpus, TEST_HIGH_SIGNALS) || hasTestFiles) {
    return "high";
  }
  if (matchesAnySignal(corpus, TEST_MED_SIGNALS)) {
    return "medium";
  }
  if (matchesAnySignal(corpus, TEST_LOW_SIGNALS)) {
    return "low";
  }
  return "none";
}

function inferTaskType(features: {
  has_swagger: boolean;
  mentions_aggrid: boolean;
  migration_adp_present: boolean;
  isDebug: boolean;
  jiraIssueType?: string;
}): ContextSignature["task_type_guess"] {
  // Jira issue type is the strongest signal when available
  const issueType = features.jiraIssueType?.toLowerCase() ?? "";
  if (issueType.includes("bug") || issueType.includes("defect") || issueType.includes("incident")) {
    return "debug";
  }

  // Priority cascade: migration > debug > api > ui
  // Migration is high-priority because it's a controlled transformation
  if (features.migration_adp_present) return "migration";
  if (features.isDebug) return "debug";
  if (features.has_swagger) return "api_contract";
  if (features.mentions_aggrid) return "ui_feature";

  return "unknown";
}
