import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { GatewayConfig } from "../../config/types";
import { LexicalIndex, type LexicalHit } from "../../infrastructure/lexical-index/lexicalIndex";
import { resolveRepoRoot, resolveTargetRepoRoot } from "../../shared/fsPaths";
import { replaceWithGuard } from "../../shared/replaceGuard";
import { createTsMorphProject, parseAngularTemplate, parseAngularTemplateUsage } from "./astTooling";

export interface SymbolHit {
  symbol: string;
  filePath: string;
  kind: "class" | "function" | "interface" | "enum" | "type" | "variable";
}

/** High-signal symbol extracted during indexing — suitable for graph ingestion */
export interface SymbolHeader {
  symbol: string;
  filePath: string;
  kind: SymbolHit["kind"];
  /** True for route-boundary components, key services, DTOs, etc. */
  highSignal: boolean;
}

/** Component tag usage fact extracted from Angular templates */
export interface TemplateUsageFact {
  tag: string;
  filePath: string;
  line: number;
  attributes: string[];
  /** Whether the tag is from the ADP library */
  isAdp: boolean;
  /** Whether the tag is from the SDF library */
  isSdf: boolean;
}

export interface IndexingFailure {
  filePath: string;
  reason: string;
}

const HARD_EXCLUDED_PATH_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".angular",
  ".git",
  ".next",
  ".cache",
  "coverage",
  "build",
  "tmp"
]);

const INGESTION_ALLOWED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".html",
  ".json",
  ".yaml",
  ".yml"
];

export class IndexingService {
  private readonly lexicalIndex = new LexicalIndex();
  private readonly symbolMap = new Map<string, SymbolHit[]>();
  private readonly failures: IndexingFailure[] = [];
  private readonly templateUsageFacts: TemplateUsageFact[] = [];
  private indexedAt = "";

  constructor(private readonly config: GatewayConfig) {}

  async rebuild(repoRoot = resolveTargetRepoRoot()): Promise<void> {
    this.lexicalIndex.clear();
    this.symbolMap.clear();
    this.failures.length = 0;
    this.templateUsageFacts.length = 0;

    const roots = resolveIngestionRoots(repoRoot, this.config);
    const files = await collectFilesAcrossRoots(roots, this.config.ingestion.excludes);
    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf8");
        this.lexicalIndex.addDocument(filePath, content);
        if (filePath.endsWith(".html")) {
          const template = parseAngularTemplate(content);
          if (template.errors.length > 0) {
            this.failures.push({
              filePath,
              reason: template.errors.join(" | ")
            });
          }
          // Phase 4: Extract component usage facts from templates
          const usageFacts = parseAngularTemplateUsage(content, filePath);
          this.templateUsageFacts.push(...usageFacts);
        }
      } catch (error) {
        this.failures.push({
          filePath,
          reason: error instanceof Error ? error.message : "READ_FAILED"
        });
      }
    }

    await this.rebuildSymbolIndex(repoRoot, files.filter((item) => item.endsWith(".ts") || item.endsWith(".js")));
    this.indexedAt = new Date().toISOString();
  }

  searchLexical(query: string, limit = 20): LexicalHit[] {
    return this.lexicalIndex.searchLexeme(query, limit);
  }

  searchSymbol(query: string, limit = 20): SymbolHit[] {
    const key = query.trim().toLowerCase();
    if (!key) {
      return [];
    }
    const exact = this.symbolMap.get(key) ?? [];
    if (exact.length >= limit) {
      return exact.slice(0, limit);
    }
    const fuzzy: SymbolHit[] = [];
    for (const [symbol, hits] of this.symbolMap.entries()) {
      if (!symbol.includes(key) || symbol === key) {
        continue;
      }
      fuzzy.push(...hits);
      if (exact.length + fuzzy.length >= limit) {
        break;
      }
    }
    return [...exact, ...fuzzy].slice(0, limit);
  }

  getFailures(limit = 100): IndexingFailure[] {
    return this.failures.slice(0, Math.max(1, limit));
  }

  getIndexedAt(): string {
    return this.indexedAt;
  }

  /**
   * Phase 4: Returns high-signal symbol headers suitable for graph ingestion.
   * High-signal = interfaces, types, DTOs, route-boundary components, key services.
   */
  getSymbolHeaders(limit = 500): SymbolHeader[] {
    const headers: SymbolHeader[] = [];
    const HIGH_SIGNAL_KINDS = new Set<SymbolHit["kind"]>(["interface", "type", "enum"]);
    const HIGH_SIGNAL_SUFFIXES = ["Component", "Service", "Module", "Directive", "Pipe", "Guard", "Resolver", "Store", "DTO", "Model", "Entity"];

    for (const [, hits] of this.symbolMap) {
      for (const hit of hits) {
        const highSignal = HIGH_SIGNAL_KINDS.has(hit.kind)
          || HIGH_SIGNAL_SUFFIXES.some((s) => hit.symbol.endsWith(s));
        headers.push({
          symbol: hit.symbol,
          filePath: hit.filePath,
          kind: hit.kind,
          highSignal,
        });
        if (headers.length >= limit) return headers;
      }
    }
    return headers;
  }

  /**
   * Phase 4: Returns component usage facts from Angular templates.
   * Includes adp and sdf tag usage with file/line/attribute data.
   */
  getTemplateUsageFacts(limit = 1000): TemplateUsageFact[] {
    return this.templateUsageFacts.slice(0, limit);
  }

  private async rebuildSymbolIndex(repoRoot: string, files: string[]): Promise<void> {
    const project = createTsMorphProject(resolveTsConfigPath(repoRoot));
    for (const filePath of files) {
      try {
        const sourceFile = project.addSourceFileAtPathIfExists(filePath);
        if (!sourceFile) {
          continue;
        }
        const classNames = sourceFile.getClasses().map((item) => item.getName()).filter(isString);
        const functionNames = sourceFile
          .getFunctions()
          .map((item) => item.getName())
          .filter(isString);
        const interfaceNames = sourceFile.getInterfaces().map((item) => item.getName()).filter(isString);
        const enumNames = sourceFile.getEnums().map((item) => item.getName()).filter(isString);
        const typeAliases = sourceFile.getTypeAliases().map((item) => item.getName()).filter(isString);
        const variableNames = sourceFile
          .getVariableDeclarations()
          .map((item) => item.getName())
          .filter(isString);

        addSymbols(this.symbolMap, classNames, filePath, "class");
        addSymbols(this.symbolMap, functionNames, filePath, "function");
        addSymbols(this.symbolMap, interfaceNames, filePath, "interface");
        addSymbols(this.symbolMap, enumNames, filePath, "enum");
        addSymbols(this.symbolMap, typeAliases, filePath, "type");
        addSymbols(this.symbolMap, variableNames, filePath, "variable");
      } catch (error) {
        this.failures.push({
          filePath,
          reason: error instanceof Error ? error.message : "SYMBOL_INDEX_FAILED"
        });
      }
    }
  }
}

function resolveTsConfigPath(repoRoot: string): string {
  const primary = path.join(repoRoot, "tsconfig.json");
  if (existsSync(primary)) {
    return primary;
  }
  const mcpTsConfig = path.join(resolveRepoRoot(), ".ai", "mcp-controller", "tsconfig.json");
  if (existsSync(mcpTsConfig)) {
    return mcpTsConfig;
  }
  return primary;
}

async function collectFiles(root: string, excludes: string[]): Promise<string[]> {
  const output: string[] = [];
  const queue = [root];
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
      const normalized = normalizeSlashes(fullPath);
      if (shouldHardExcludePath(normalized)) {
        continue;
      }
      if (excludes.some((pattern) => matchLooseGlob(normalized, pattern))) {
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        if (!isIngestionAllowedFile(fullPath)) {
          continue;
        }
        output.push(fullPath);
      }
    }
  }
  return output;
}

async function collectFilesAcrossRoots(roots: string[], excludes: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const root of roots) {
    const scoped = await collectFiles(root, excludes);
    for (const filePath of scoped) {
      files.add(filePath);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function resolveIngestionRoots(repoRoot: string, config: GatewayConfig): string[] {
  const candidates = new Set<string>();
  candidates.add(path.join(repoRoot, "src"));

  for (const value of [
    ...config.hints.angularRoots,
    ...config.parserTargets.typescript,
    ...config.parserTargets.templates,
    ...config.parserTargets.json,
    ...config.parserTargets.yaml
  ]) {
    const root = globRoot(value);
    if (!root) {
      continue;
    }
    candidates.add(path.resolve(repoRoot, root));
  }

  for (const pattern of config.ingestion.includes) {
    const root = globRoot(pattern);
    if (!root) {
      continue;
    }
    candidates.add(path.resolve(repoRoot, root));
  }

  return [...candidates].filter((candidate) => existsSync(candidate));
}

function globRoot(value: string): string | null {
  if (!value || value.trim().length === 0) {
    return null;
  }
  const normalized = replaceWithGuard(
    normalizeSlashes(value),
    /^\.\//,
    "",
    "IndexingService:globRoot:strip-leading-dot-slash"
  );
  const segments = normalized.split("/");
  const stable: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (hasGlobToken(segment)) {
      break;
    }
    stable.push(segment);
  }
  if (stable.length === 0) {
    return null;
  }
  return stable.join("/");
}

function hasGlobToken(segment: string): boolean {
  return (
    segment.includes("*") ||
    segment.includes("?") ||
    segment.includes("[") ||
    segment.includes("]") ||
    segment.includes("{") ||
    segment.includes("}")
  );
}

function matchLooseGlob(value: string, globPattern: string): boolean {
  const withoutDoubleStar = replaceWithGuard(
    globPattern,
    /\*\*/g,
    "",
    "IndexingService:matchLooseGlob:strip-double-star"
  );
  const withoutStar = replaceWithGuard(
    withoutDoubleStar,
    /\*/g,
    "",
    "IndexingService:matchLooseGlob:strip-star"
  );
  const token = replaceWithGuard(
    withoutStar,
    /\\/g,
    "/",
    "IndexingService:matchLooseGlob:normalize-backslash"
  ).trim();
  if (!token) {
    return false;
  }
  return value.includes(token);
}

function normalizeSlashes(value: string): string {
  return replaceWithGuard(value, /\\/g, "/", "IndexingService:normalizeSlashes");
}

function shouldHardExcludePath(value: string): boolean {
  const normalized = normalizeSlashes(value).toLowerCase();
  const segments = normalized.split("/");
  return segments.some((segment) => HARD_EXCLUDED_PATH_SEGMENTS.has(segment));
}

function isIngestionAllowedFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return INGESTION_ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function addSymbols(
  map: Map<string, SymbolHit[]>,
  names: string[],
  filePath: string,
  kind: SymbolHit["kind"]
): void {
  for (const name of names) {
    const key = name.toLowerCase();
    const current = map.get(key) ?? [];
    current.push({
      symbol: name,
      filePath,
      kind
    });
    map.set(key, current);
  }
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
