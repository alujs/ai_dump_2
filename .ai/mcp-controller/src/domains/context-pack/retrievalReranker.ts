import type { QueryNormalizationResult } from "./glossaryNormalization";

export interface RankedLexicalCandidate {
  filePath: string;
  line: number;
  preview: string;
  score: number;
  rerankScore: number;
  reasons: string[];
}

export interface RankedSymbolCandidate {
  symbol: string;
  filePath: string;
  kind: string;
  rerankScore: number;
  reasons: string[];
}

export interface RetrievalRerankResult {
  algorithmId: string;
  selectedAnchors: {
    entrypointCandidate?: {
      lane: "lexical" | "symbol";
      filePath: string;
      line?: number;
      symbol?: string;
      score: number;
      reasons: string[];
    };
    definitionCandidate?: {
      lane: "lexical" | "symbol";
      filePath: string;
      line?: number;
      symbol?: string;
      score: number;
      reasons: string[];
    };
    testCandidate?: {
      lane: "lexical" | "symbol";
      filePath: string;
      line?: number;
      symbol?: string;
      score: number;
      reasons: string[];
    };
  };
  topLexical: RankedLexicalCandidate[];
  topSymbol: RankedSymbolCandidate[];
}

export function rerankRetrieval(input: {
  lexicalLane: Array<Record<string, unknown>>;
  symbolLane: Array<Record<string, unknown>>;
  queryNormalization: QueryNormalizationResult;
  activePolicies: string[];
}): RetrievalRerankResult {
  const queryTerms = new Set(input.queryNormalization.expandedTerms);
  const hasNoAdpPolicy = input.activePolicies.some((item) => item.includes("no_adp"));

  const lexical = input.lexicalLane
    .map((candidate) => scoreLexicalCandidate(candidate, queryTerms, hasNoAdpPolicy))
    .sort(compareLexical);
  const symbols = input.symbolLane
    .map((candidate) => scoreSymbolCandidate(candidate, queryTerms, hasNoAdpPolicy))
    .sort(compareSymbol);

  return {
    algorithmId: "deterministic_lexical_graph_v1",
    selectedAnchors: {
      entrypointCandidate: selectEntrypoint(lexical, symbols),
      definitionCandidate: selectDefinition(symbols, lexical),
      testCandidate: selectTestAnchor(lexical, symbols)
    },
    topLexical: lexical.slice(0, 8),
    topSymbol: symbols.slice(0, 8)
  };
}

function scoreLexicalCandidate(
  candidate: Record<string, unknown>,
  queryTerms: Set<string>,
  hasNoAdpPolicy: boolean
): RankedLexicalCandidate {
  const filePath = String(candidate.filePath ?? "");
  const line = Number(candidate.line ?? 0);
  const preview = String(candidate.preview ?? "");
  const base = Number(candidate.score ?? 0);
  const reasons: string[] = [`base_lexical=${base.toFixed(3)}`];
  let score = base;

  const pathLower = filePath.toLowerCase();
  const previewLower = preview.toLowerCase();
  const combined = `${pathLower} ${previewLower}`;

  if (isHubFile(pathLower)) {
    score -= 0.28;
    reasons.push("hub_penalty");
  }
  if (looksLikeUtilityBoilerplate(combined)) {
    score -= 0.14;
    reasons.push("utility_noise_penalty");
  }
  if (looksLikeTailwindNoise(previewLower)) {
    score -= 0.18;
    reasons.push("tailwind_noise_penalty");
  }

  if (isRouteAdjacent(pathLower)) {
    score += 0.22;
    reasons.push("route_or_nav_boost");
  }
  if (pathLower.endsWith(".spec.ts")) {
    score += 0.2;
    reasons.push("test_adjacency_boost");
  }

  if (hasQueryTerm(queryTerms, ["ag", "grid", "aggrid"]) && matchesAny(combined, ["ag-grid", "grid", "coldef", "cellrenderer"])) {
    score += 0.18;
    reasons.push("ag_grid_proof_boost");
  }
  if (hasQueryTerm(queryTerms, ["federation", "microfrontend", "mfe"]) && matchesAny(combined, ["federation", "remote", "host", "exposes"])) {
    score += 0.2;
    reasons.push("federation_coherence_boost");
  }

  if (hasNoAdpPolicy) {
    if (matchesAny(combined, ["adp", "adp-"])) {
      score -= 0.33;
      reasons.push("policy_no_adp_penalty");
    }
    if (matchesAny(combined, ["sdf", "sdf-"])) {
      score += 0.14;
      reasons.push("policy_sdf_prior_boost");
    }
  }

  if (Boolean(candidate.matchedByAlias)) {
    score -= 0.12;
    reasons.push("alias_suggestion_penalty");
  }

  return {
    filePath,
    line: Number.isFinite(line) ? line : 0,
    preview,
    score: base,
    rerankScore: Number(score.toFixed(6)),
    reasons
  };
}

function scoreSymbolCandidate(
  candidate: Record<string, unknown>,
  queryTerms: Set<string>,
  hasNoAdpPolicy: boolean
): RankedSymbolCandidate {
  const symbol = String(candidate.symbol ?? "");
  const filePath = String(candidate.filePath ?? "");
  const kind = String(candidate.kind ?? "");
  const reasons: string[] = [];

  let score = kindBoost(kind);
  reasons.push(`kind_boost=${score.toFixed(3)}`);

  const pathLower = filePath.toLowerCase();
  const symbolLower = symbol.toLowerCase();
  const combined = `${pathLower} ${symbolLower}`;

  if (isHubFile(pathLower)) {
    score -= 0.2;
    reasons.push("hub_penalty");
  }
  if (isRouteAdjacent(pathLower)) {
    score += 0.16;
    reasons.push("route_or_nav_boost");
  }
  if (pathLower.endsWith(".spec.ts")) {
    score += 0.14;
    reasons.push("test_adjacency_boost");
  }
  if (queryTerms.has(symbolLower)) {
    score += 0.25;
    reasons.push("exact_symbol_match_boost");
  }

  if (hasQueryTerm(queryTerms, ["federation", "microfrontend", "mfe"]) && matchesAny(combined, ["federation", "remote", "host"])) {
    score += 0.14;
    reasons.push("federation_coherence_boost");
  }
  if (hasNoAdpPolicy) {
    if (matchesAny(combined, ["adp", "adp-"])) {
      score -= 0.25;
      reasons.push("policy_no_adp_penalty");
    }
    if (matchesAny(combined, ["sdf", "sdf-"])) {
      score += 0.12;
      reasons.push("policy_sdf_prior_boost");
    }
  }
  if (Boolean(candidate.fromAlias)) {
    score -= 0.08;
    reasons.push("alias_suggestion_penalty");
  }

  return {
    symbol,
    filePath,
    kind,
    rerankScore: Number(score.toFixed(6)),
    reasons
  };
}

function selectEntrypoint(
  lexical: RankedLexicalCandidate[],
  symbols: RankedSymbolCandidate[]
): RetrievalRerankResult["selectedAnchors"]["entrypointCandidate"] | undefined {
  const lexicalRoute = lexical.find((item) => isRouteAdjacent(item.filePath.toLowerCase())) ?? lexical[0];
  if (lexicalRoute) {
    return {
      lane: "lexical",
      filePath: lexicalRoute.filePath,
      line: lexicalRoute.line,
      score: lexicalRoute.rerankScore,
      reasons: lexicalRoute.reasons
    };
  }
  const symbolRoute = symbols.find((item) => isRouteAdjacent(item.filePath.toLowerCase())) ?? symbols[0];
  if (!symbolRoute) {
    return undefined;
  }
  return {
    lane: "symbol",
    filePath: symbolRoute.filePath,
    symbol: symbolRoute.symbol,
    score: symbolRoute.rerankScore,
    reasons: symbolRoute.reasons
  };
}

function selectDefinition(
  symbols: RankedSymbolCandidate[],
  lexical: RankedLexicalCandidate[]
): RetrievalRerankResult["selectedAnchors"]["definitionCandidate"] | undefined {
  const preferred = symbols.find((item) => item.kind === "class" || item.kind === "interface" || item.kind === "type") ?? symbols[0];
  if (preferred) {
    return {
      lane: "symbol",
      filePath: preferred.filePath,
      symbol: preferred.symbol,
      score: preferred.rerankScore,
      reasons: preferred.reasons
    };
  }
  const lexicalFallback = lexical[0];
  if (!lexicalFallback) {
    return undefined;
  }
  return {
    lane: "lexical",
    filePath: lexicalFallback.filePath,
    line: lexicalFallback.line,
    score: lexicalFallback.rerankScore,
    reasons: lexicalFallback.reasons
  };
}

function selectTestAnchor(
  lexical: RankedLexicalCandidate[],
  symbols: RankedSymbolCandidate[]
): RetrievalRerankResult["selectedAnchors"]["testCandidate"] | undefined {
  const lexicalTest = lexical.find((item) => item.filePath.toLowerCase().endsWith(".spec.ts"));
  if (lexicalTest) {
    return {
      lane: "lexical",
      filePath: lexicalTest.filePath,
      line: lexicalTest.line,
      score: lexicalTest.rerankScore,
      reasons: lexicalTest.reasons
    };
  }
  const symbolTest = symbols.find((item) => item.filePath.toLowerCase().endsWith(".spec.ts"));
  if (!symbolTest) {
    return undefined;
  }
  return {
    lane: "symbol",
    filePath: symbolTest.filePath,
    symbol: symbolTest.symbol,
    score: symbolTest.rerankScore,
    reasons: symbolTest.reasons
  };
}

function kindBoost(kind: string): number {
  switch (kind) {
    case "class":
      return 0.45;
    case "interface":
    case "type":
      return 0.4;
    case "function":
      return 0.34;
    case "enum":
      return 0.32;
    case "variable":
      return 0.24;
    default:
      return 0.2;
  }
}

function compareLexical(a: RankedLexicalCandidate, b: RankedLexicalCandidate): number {
  if (b.rerankScore !== a.rerankScore) {
    return b.rerankScore - a.rerankScore;
  }
  if (a.filePath !== b.filePath) {
    return a.filePath.localeCompare(b.filePath);
  }
  return a.line - b.line;
}

function compareSymbol(a: RankedSymbolCandidate, b: RankedSymbolCandidate): number {
  if (b.rerankScore !== a.rerankScore) {
    return b.rerankScore - a.rerankScore;
  }
  if (a.filePath !== b.filePath) {
    return a.filePath.localeCompare(b.filePath);
  }
  return a.symbol.localeCompare(b.symbol);
}

function isHubFile(pathLower: string): boolean {
  return (
    pathLower.includes("/shared/") ||
    pathLower.includes("/common/") ||
    pathLower.includes("/utils/") ||
    pathLower.includes("/helpers/")
  );
}

function isRouteAdjacent(pathLower: string): boolean {
  return (
    pathLower.includes("route") ||
    pathLower.includes("routing") ||
    pathLower.includes("router") ||
    pathLower.includes("navigation") ||
    pathLower.includes("nav") ||
    pathLower.includes("app.module")
  );
}

function looksLikeUtilityBoilerplate(value: string): boolean {
  return matchesAny(value, ["generated", "index.ts", "barrel", "constants", "types.ts"]);
}

function looksLikeTailwindNoise(previewLower: string): boolean {
  const hits = [" flex ", " grid ", " px-", " py-", " text-", " bg-", " gap-", " items-", " justify-"].filter((token) =>
    previewLower.includes(token.trim())
  ).length;
  return hits >= 4;
}

function matchesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function hasQueryTerm(queryTerms: Set<string>, terms: string[]): boolean {
  return terms.some((term) => queryTerms.has(term));
}
