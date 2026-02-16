import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { ConnectorArtifact } from "../connectors/connectorRegistry";
import { EventStore } from "../observability/eventStore";
import type { IndexingService } from "../indexing/indexingService";
import { resolveRepoRoot } from "../../shared/fsPaths";
import { expandSymbolHints, normalizeAndExpandQuery, type QueryNormalizationResult } from "./glossaryNormalization";
import { rerankRetrieval, type RetrievalRerankResult } from "./retrievalReranker";

export interface RetrievalLaneResult {
  lexicalLane: Array<Record<string, unknown>>;
  symbolLane: Array<Record<string, unknown>>;
  policyLane: Array<Record<string, unknown>>;
  artifactLane: Array<Record<string, unknown>>;
  episodicMemoryLane: Array<Record<string, unknown>>;
  queryNormalization?: QueryNormalizationResult;
  rerank?: RetrievalRerankResult;
}

export async function collectRetrievalLanes(input: {
  queryText: string;
  symbolHints: string[];
  activePolicies?: string[];
  knownArtifacts: ConnectorArtifact[];
  indexing: IndexingService | null;
  events: EventStore;
}): Promise<RetrievalLaneResult> {
  const normalization = await normalizeAndExpandQuery(input.queryText);
  const expandedSymbolHints = await expandSymbolHints(input.symbolHints);

  const indexer = input.indexing;
  const lexicalLane = indexer ? buildLexicalLane(indexer, normalization) : [];

  const symbolLane = indexer
    ? expandedSymbolHints.flatMap((hint) =>
        indexer.searchSymbol(hint, 8).map((item) => ({
          symbol: item.symbol,
          filePath: item.filePath,
          kind: item.kind,
          fromAlias: !input.symbolHints.some((original) => original.toLowerCase() === hint.toLowerCase())
        }))
      )
    : [];

  const policyLane = await collectPolicyLane();
  const artifactLane = input.knownArtifacts.map((artifact) => ({
    source: artifact.source,
    ref: artifact.ref,
    summary: artifact.summary
  }));
  const episodicMemoryLane = input.events.listPendingCorrections(30).map((event) => ({
    ts: event.ts,
    type: event.type,
    payload: event.payload
  }));

  const rerank = rerankRetrieval({
    lexicalLane,
    symbolLane,
    queryNormalization: normalization,
    activePolicies: [...new Set([...(input.activePolicies ?? []), ...collectActivePolicies(policyLane)])]
  });

  return {
    lexicalLane,
    symbolLane,
    policyLane,
    artifactLane,
    episodicMemoryLane,
    queryNormalization: normalization,
    rerank: {
      ...rerank
    }
  };
}

async function collectPolicyLane(): Promise<Array<Record<string, unknown>>> {
  const policyRoot = path.join(resolveRepoRoot(), ".ai", "graph", "seed", "policy");
  const output: Array<Record<string, unknown>> = [];
  const queue = [policyRoot];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      try {
        const raw = await readFile(fullPath, "utf8");
        const firstLine = raw
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        if (!firstLine) {
          continue;
        }
        const parsed = JSON.parse(firstLine) as Record<string, unknown>;
        output.push({
          filePath: fullPath,
          id: parsed.id ?? "",
          type: parsed.type ?? "",
          version: parsed.version ?? "",
          updated_at: parsed.updated_at ?? "",
          updated_by: parsed.updated_by ?? ""
        });
      } catch {
        continue;
      }
    }
  }
  return output;
}

function buildLexicalLane(indexer: IndexingService, normalization: { normalizedTerms: string[]; expandedTerms: string[] }) {
  const primaryQuery = normalization.normalizedTerms.join(" ");
  const expandedOnly = normalization.expandedTerms.filter((term) => !normalization.normalizedTerms.includes(term));

  const primaryHits = indexer.searchLexical(primaryQuery, 12).map((item) => ({
    filePath: item.filePath,
    line: item.line,
    preview: item.preview,
    score: item.score,
    matchedByAlias: false
  }));
  if (expandedOnly.length === 0) {
    return primaryHits;
  }

  const aliasHits = indexer.searchLexical(expandedOnly.join(" "), 12).map((item) => ({
    filePath: item.filePath,
    line: item.line,
    preview: item.preview,
    score: item.score * 0.62,
    matchedByAlias: true
  }));

  const merged = new Map<string, { filePath: string; line: number; preview: string; score: number; matchedByAlias: boolean }>();
  for (const hit of [...primaryHits, ...aliasHits]) {
    const key = `${hit.filePath}:${hit.line}`;
    const existing = merged.get(key);
    if (!existing || hit.score > existing.score) {
      merged.set(key, hit);
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 12);
}

function collectActivePolicies(policyLane: Array<Record<string, unknown>>): string[] {
  const ids = policyLane.map((item) => String(item.id ?? "")).filter((item) => item.length > 0);
  return [...new Set(ids)];
}
