import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { resolveRepoRoot } from "../../shared/fsPaths";
import { replaceWithGuard } from "../../shared/replaceGuard";

interface AliasEntry {
  aliases: string[];
  negativeAliases: string[];
  domain?: string;
  source: "builtin" | "policy_seed" | "memory_alias";
}

export interface QueryNormalizationResult {
  originalQuery: string;
  expandedQuery: string;
  normalizedTerms: string[];
  expandedTerms: string[];
  expansions: Array<{
    trigger: string;
    source: "builtin" | "policy_seed" | "memory_alias";
    domain?: string;
    aliases: string[];
    negativeAliases: string[];
  }>;
}

const BUILTIN_ALIAS_GROUPS = [
  ["ag-grid", "ag grid", "aggrid"],
  ["module federation", "federation", "microfrontend", "mfe"],
  ["dto", "contract", "schema"],
  ["selector", "component selector", "template selector"],
  ["route", "routing", "navigation", "nav"]
] as const;

let aliasCache: {
  loadedAt: number;
  map: Map<string, AliasEntry>;
} | null = null;

const CACHE_TTL_MS = 5_000;

export async function normalizeAndExpandQuery(queryText: string): Promise<QueryNormalizationResult> {
  const aliasMap = await loadAliasMap();
  const normalizedTerms = tokenize(queryText);
  const expandedTerms = new Set(normalizedTerms);
  const expansions: QueryNormalizationResult["expansions"] = [];

  const queryKey = normalizeKey(queryText);
  for (const [key, value] of aliasMap.entries()) {
    if (!queryKey.includes(key)) {
      continue;
    }
    const negativeMatched = value.negativeAliases.some((alias) => queryKey.includes(normalizeKey(alias)));
    if (negativeMatched) {
      continue;
    }
    const aliasTerms = value.aliases.flatMap((item) => tokenize(item));
    if (aliasTerms.length === 0) {
      continue;
    }
    for (const aliasTerm of aliasTerms) {
      expandedTerms.add(aliasTerm);
    }
    expansions.push({
      trigger: key,
      source: value.source,
      domain: value.domain,
      aliases: [...new Set(aliasTerms)].sort((a, b) => a.localeCompare(b)),
      negativeAliases: value.negativeAliases
    });
  }

  const sortedTerms = [...expandedTerms].sort((a, b) => a.localeCompare(b));
  return {
    originalQuery: queryText,
    expandedQuery: sortedTerms.join(" "),
    normalizedTerms: [...new Set(normalizedTerms)].sort((a, b) => a.localeCompare(b)),
    expandedTerms: sortedTerms,
    expansions
  };
}

export async function expandSymbolHints(symbolHints: string[]): Promise<string[]> {
  const aliasMap = await loadAliasMap();
  const expanded = new Set<string>();
  for (const hint of symbolHints) {
    const normalized = normalizeKey(hint);
    for (const term of tokenize(hint)) {
      expanded.add(term);
    }
    const aliases = aliasMap.get(normalized)?.aliases ?? [];
    for (const alias of aliases) {
      for (const term of tokenize(alias)) {
        expanded.add(term);
      }
    }
  }
  return [...expanded].sort((a, b) => a.localeCompare(b));
}

async function loadAliasMap(): Promise<Map<string, AliasEntry>> {
  if (aliasCache && Date.now() - aliasCache.loadedAt <= CACHE_TTL_MS) {
    return aliasCache.map;
  }

  const map = new Map<string, AliasEntry>();
  for (const group of BUILTIN_ALIAS_GROUPS) {
    registerAliasGroup(map, [...group], "builtin");
  }

  const seedAliases = await readSeedAliases();
  for (const group of seedAliases) {
    registerAliasGroup(map, group.terms, "policy_seed", {
      domain: group.domain,
      negativeAliases: group.negativeAliases
    });
  }

  const memoryAliases = await readMemoryAliases();
  for (const group of memoryAliases) {
    registerAliasGroup(map, group.terms, "memory_alias", {
      domain: group.domain,
      negativeAliases: group.negativeAliases
    });
  }

  aliasCache = {
    loadedAt: Date.now(),
    map
  };
  return map;
}

function registerAliasGroup(
  map: Map<string, AliasEntry>,
  group: string[],
  source: "builtin" | "policy_seed" | "memory_alias",
  metadata?: { domain?: string; negativeAliases?: string[] }
): void {
  const normalizedGroup = [...new Set(group.map((item) => normalizeKey(item)).filter((item) => item.length > 0))];
  if (normalizedGroup.length <= 1) {
    return;
  }
  const negativeAliases = (metadata?.negativeAliases ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  for (const key of normalizedGroup) {
    const aliases = normalizedGroup.filter((entry) => entry !== key);
    if (aliases.length === 0) {
      continue;
    }
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        aliases,
        negativeAliases,
        domain: metadata?.domain,
        source
      });
      continue;
    }
    const merged = [...new Set([...existing.aliases, ...aliases])].sort((a, b) => a.localeCompare(b));
    const mergedNegative = [...new Set([...existing.negativeAliases, ...negativeAliases])].sort((a, b) =>
      a.localeCompare(b)
    );
    map.set(key, {
      aliases: merged,
      negativeAliases: mergedNegative,
      domain: existing.domain ?? metadata?.domain,
      source:
        existing.source === "memory_alias" || source === "memory_alias"
          ? "memory_alias"
          : existing.source === "policy_seed" || source === "policy_seed"
            ? "policy_seed"
            : "builtin"
    });
  }
}

async function readSeedAliases(): Promise<Array<{ terms: string[]; domain?: string; negativeAliases: string[] }>> {
  const policyRoot = path.join(resolveRepoRoot(), ".ai", "graph", "seed", "policy");
  const groups: Array<{ terms: string[]; domain?: string; negativeAliases: string[] }> = [];
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
      const lines = (await readFile(fullPath, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          const rowKind = String(row.kind ?? "");
          if (rowKind !== "node") {
            continue;
          }
          const props = asRecord(row.properties);
          const type = String(props.type ?? "");
          if (type !== "lexeme_alias") {
            continue;
          }
          const canonical = String(props.canonical ?? props.term ?? "").trim();
          const aliases = asStringArray(props.aliases) ?? [];
          const singleAlias = String(props.alias ?? "").trim();
          if (singleAlias) {
            aliases.push(singleAlias);
          }
          const negativeAliases = asStringArray(props.negative_aliases) ?? [];
          const terms = [canonical, ...aliases].map((item) => item.trim()).filter((item) => item.length > 0);
          if (terms.length <= 1) {
            continue;
          }
          groups.push({
            terms,
            domain: String(props.domain ?? "").trim() || undefined,
            negativeAliases
          });
        } catch {
          continue;
        }
      }
    }
  }
  return groups;
}

async function readMemoryAliases(): Promise<Array<{ terms: string[]; domain?: string; negativeAliases: string[] }>> {
  const memoryPath = path.join(resolveRepoRoot(), ".ai", "tmp", "memory", "promotion_items.json");
  try {
    const raw = await readFile(memoryPath, "utf8");
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    const groups: Array<{ terms: string[]; domain?: string; negativeAliases: string[] }> = [];
    for (const item of parsed) {
      if (String(item.kind ?? "") !== "lexeme_alias") {
        continue;
      }
      const state = String(item.state ?? "");
      if (state !== "approved" && state !== "provisional") {
        continue;
      }
      const metadata = asRecord(item.metadata);
      const canonical = String(metadata.canonical ?? metadata.term ?? "").trim();
      const aliases = asStringArray(metadata.aliases) ?? [];
      const singleAlias = String(metadata.alias ?? "").trim();
      if (singleAlias) {
        aliases.push(singleAlias);
      }
      const terms = [canonical, ...aliases].map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (terms.length > 1) {
        groups.push({
          terms,
          domain: String(metadata.domain ?? "").trim() || undefined,
          negativeAliases: asStringArray(metadata.negative_aliases) ?? []
        });
      }
    }
    return groups;
  } catch {
    return [];
  }
}

function tokenize(value: string): string[] {
  return normalizeKey(value)
    .split(" ")
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function normalizeKey(value: string): string {
  const lower = value.toLowerCase();
  return replaceWithGuard(lower, /[^a-z0-9]+/g, " ", "GlossaryNormalization:normalizeKey").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((item) => String(item));
}
