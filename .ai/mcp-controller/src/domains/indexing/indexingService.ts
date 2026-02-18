import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { GatewayConfig } from "../../config/types";
import { LexicalIndex, type LexicalHit } from "../../infrastructure/lexical-index/lexicalIndex";
import { resolveRepoRoot, resolveTargetRepoRoot } from "../../shared/fsPaths";
import { loadGitignoreFilterWithAncestors, type GitignoreFilter } from "../../shared/gitignoreFilter";
import { replaceWithGuard } from "../../shared/replaceGuard";
import { createTsMorphProject, parseAngularTemplate, parseAngularTemplateUsage, parseAngularTemplateNav, parseAngularTemplateDirectives, extractInlineTemplates, type TemplateNavFacts, type TemplateDirectiveUsage } from "./astTooling";
import { parseRouteConfig, isLikelyRouteFile, type ParsedRoute, type RouteParseResult, type GuardDetail } from "./routeParser";

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

/** Route fact re-exported so consumers don't need to import routeParser directly */
export type { ParsedRoute, GuardDetail } from "./routeParser";
/** Template directive type re-exported from astTooling */
export type { TemplateDirectiveUsage } from "./astTooling";

/**
 * Resolved guard — links a guard name back to its definition file and
 * the files it imports (constants, services, enums — whatever they are).
 * This enables the chain: Route → Guard → dependency files.
 *
 * The resolution is generic — it traces ALL imports of the guard's
 * definition file, not just files named "roles" or "permissions".
 */
export interface ResolvedGuard {
  /** Guard function or class name */
  name: string;
  /** File where the guard is defined (repo-relative) */
  definitionFile: string | null;
  /** Symbol kind (function, class, variable) */
  kind: SymbolHit["kind"] | null;
  /** Files that the guard's definition file imports (repo-relative) —
   *  these are whatever the guard depends on (constants, services, etc.) */
  importedFiles: string[];
  /** Named imports pulled in by the guard's definition file */
  importedSymbols: string[];
  /** Routes that use this guard (fullPath list) */
  usedByRoutes: string[];
  /** Structured guard instances across routes */
  instances: Array<{ routePath: string; guardType: GuardDetail["guardType"]; args: string[] }>;
}

/** Template-level navigation fact: routerLink reference found in a template */
export interface TemplateRouterLinkFact {
  routePath: string;
  filePath: string;
  line: number;
  hostTag: string;
  isBound: boolean;
}

/** Custom directive usage found in a template */
export interface DirectiveUsageFact {
  /** Directive name as it appears (e.g. "appHasRole", "appHighlight", "tooltip") */
  directiveName: string;
  /** The bound expression or static value (e.g. "'ADMIN'", "someCondition") */
  boundExpression: string | null;
  /** Template file path (repo-relative) */
  filePath: string;
  /** 0-based line number */
  line: number;
  /** Host element tag (e.g. "div", "button", "ng-template") */
  hostTag: string;
  /** Whether this is a structural directive (*appXyz) */
  isStructural: boolean;
}

/**
 * Resolved directive — links a directive name extracted from templates back
 * to its @Directive class definition file and traces imports to discover
 * the files it depends on (constants, services, enums — whatever they are).
 *
 * Chain: Template → directive usage → @Directive class → imports → dependency files
 *
 * The resolution is generic — it does NOT assume the directive is role/permission
 * related.  Classification happens downstream from the resolved import chain,
 * not from hardcoded patterns.
 */
export interface ResolvedDirective {
  /** Directive name as extracted from templates (e.g. "appHasRole", "appHighlight") */
  directiveName: string;
  /** All distinct bound expressions used with this directive across templates */
  boundExpressions: string[];
  /** File where the @Directive class is defined (repo-relative) */
  definitionFile: string | null;
  /** The @Directive class name (e.g. "HasRoleDirective", "HighlightDirective") */
  className: string | null;
  /** Symbol kind */
  kind: SymbolHit["kind"] | null;
  /** Files that the directive class imports (repo-relative) —
   *  these are the constant/service/enum dependencies */
  importedFiles: string[];
  /** Named imports pulled in by the directive definition */
  importedSymbols: string[];
  /** Template files that use this directive (repo-relative) */
  usedInTemplates: string[];
}

/**
 * @deprecated — Retained only as a fallback reference. Actual exclusion is now
 * handled by `loadGitignoreFilterWithAncestors()` in `shared/gitignoreFilter.ts`,
 * which reads the target repo's `.gitignore` AND applies a safety-net set of
 * always-excluded segments (node_modules, dist, .angular, .git, etc.).
 */
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
  private readonly parsedRoutes: ParsedRoute[] = [];
  private readonly routeParseNotes: string[] = [];
  private readonly templateRouterLinks: TemplateRouterLinkFact[] = [];
  private readonly routerOutletFiles = new Set<string>();
  private readonly directiveUsages: DirectiveUsageFact[] = [];
  private indexedFilePaths: string[] = [];
  private indexedAt = "";

  constructor(private readonly config: GatewayConfig) {}

  async rebuild(repoRoot = resolveTargetRepoRoot()): Promise<void> {
    this.lexicalIndex.clear();
    this.symbolMap.clear();
    this.failures.length = 0;
    this.templateUsageFacts.length = 0;
    this.parsedRoutes.length = 0;
    this.routeParseNotes.length = 0;
    this.templateRouterLinks.length = 0;
    this.routerOutletFiles.clear();
    this.directiveUsages.length = 0;
    this.indexedFilePaths = [];

    const roots = resolveIngestionRoots(repoRoot, this.config);
    const gitFilter = loadGitignoreFilterWithAncestors(repoRoot, resolveRepoRoot());
    const files = await collectFilesAcrossRoots(roots, this.config.ingestion.excludes, repoRoot, gitFilter);
    this.indexedFilePaths = files;
    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf8");
        this.lexicalIndex.addDocument(filePath, content);

        // Determine template sources to parse:
        //  - .html files: the whole file is a template
        //  - .ts files: extract inline `template: \`...\`` strings
        const templateSources: string[] = [];
        if (filePath.endsWith(".html")) {
          templateSources.push(content);
        } else if (filePath.endsWith(".ts")) {
          templateSources.push(...extractInlineTemplates(content));
        }

        for (const templateContent of templateSources) {
          const template = parseAngularTemplate(templateContent);
          if (template.errors.length > 0) {
            this.failures.push({
              filePath,
              reason: template.errors.join(" | ")
            });
          }
          // Phase 4: Extract component usage facts from templates
          const usageFacts = parseAngularTemplateUsage(templateContent, filePath);
          this.templateUsageFacts.push(...usageFacts);
          // Phase 5: Extract navigation facts (routerLink, router-outlet)
          const navFacts = parseAngularTemplateNav(templateContent, filePath);
          if (navFacts.hasRouterOutlet) {
            this.routerOutletFiles.add(filePath);
          }
          for (const link of navFacts.routerLinks) {
            this.templateRouterLinks.push({
              routePath: link.routePath,
              filePath,
              line: link.line,
              hostTag: link.hostTag,
              isBound: link.isBound,
            });
          }
          // Phase 6: Extract custom directive usages from templates
          const directiveFacts = parseAngularTemplateDirectives(templateContent, filePath);
          for (const usage of directiveFacts.usages) {
            this.directiveUsages.push({
              directiveName: usage.directiveName,
              boundExpression: usage.boundExpression,
              filePath,
              line: usage.line,
              hostTag: usage.hostTag,
              isStructural: usage.isStructural,
            });
          }
        }
      } catch (error) {
        this.failures.push({
          filePath,
          reason: error instanceof Error ? error.message : "READ_FAILED"
        });
      }
    }

    await this.rebuildSymbolIndex(repoRoot, files.filter((item) => item.endsWith(".ts") || item.endsWith(".js")));
    await this.rebuildRouteIndex(repoRoot, files.filter((item) => item.endsWith(".ts")));
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
   * Returns the full list of file paths that were indexed during the last rebuild().
   * These are repo-relative paths — suitable for populating contextPack.files.
   */
  getIndexedFilePaths(): string[] {
    return [...this.indexedFilePaths];
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

  /**
   * Phase 5: Returns parsed Angular route definitions.
   * Includes full path tree, lazy-load targets, guards, and nesting info.
   */
  getParsedRoutes(): ParsedRoute[] {
    return [...this.parsedRoutes];
  }

  /**
   * Phase 5: Returns routerLink references found in templates.
   * These are the template-side references to route paths.
   */
  getTemplateRouterLinks(limit = 2000): TemplateRouterLinkFact[] {
    return this.templateRouterLinks.slice(0, limit);
  }

  /**
   * Phase 5: Returns file paths containing <router-outlet>.
   * These files host child route rendering.
   */
  getRouterOutletFiles(): string[] {
    return [...this.routerOutletFiles];
  }

  /**
   * Phase 6: Returns custom directive usages found in templates.
   * These track where templates use custom directives (structural or attribute).
   * No filtering by role/permission — ALL custom directives are captured.
   */
  getDirectiveUsages(limit = 2000): DirectiveUsageFact[] {
    return this.directiveUsages.slice(0, limit);
  }

  /**
   * Phase 6: Resolve directive names from template usages to their @Directive
   * class definitions and trace imports to discover dependency files.
   *
   * Chain: Template → directive name → symbol map → @Directive class → imports
   *
   * Works identically to getResolvedGuards() but for template-level directives.
   * The resolution is generic — it captures ALL custom directives, not just
   * role/permission ones.  The import chain reveals what each directive depends on.
   */
  getResolvedDirectives(): ResolvedDirective[] {
    const directiveMap = new Map<string, ResolvedDirective>();

    for (const usage of this.directiveUsages) {
      let entry = directiveMap.get(usage.directiveName);
      if (!entry) {
        // Try to resolve the directive name to a @Directive class via the symbol map.
        // Directive classes typically follow the pattern: HasRoleDirective, AppHasPermissionDirective
        // We search for the directive name + "Directive" suffix variants
        const candidates = [
          usage.directiveName + "Directive",           // appHasRole → appHasRoleDirective
          capitalize(usage.directiveName) + "Directive", // appHasRole → AppHasRoleDirective
          usage.directiveName,                          // direct name match
        ];

        let bestHit: SymbolHit | null = null;
        for (const candidate of candidates) {
          const hits = this.searchSymbol(candidate, 5);
          const exactMatch = hits.find((h) => h.symbol.toLowerCase() === candidate.toLowerCase());
          if (exactMatch) {
            bestHit = exactMatch;
            break;
          }
          if (!bestHit && hits.length > 0) {
            bestHit = hits[0];
          }
        }

        entry = {
          directiveName: usage.directiveName,
          boundExpressions: [],
          definitionFile: bestHit?.filePath ?? null,
          className: bestHit?.symbol ?? null,
          kind: bestHit?.kind ?? null,
          importedFiles: [],
          importedSymbols: [],
          usedInTemplates: [],
        };

        // If we found the definition file, trace its imports
        if (bestHit?.filePath) {
          try {
            const project = createTsMorphProject(resolveTsConfigPath(resolveTargetRepoRoot()));
            const sourceFile = project.addSourceFileAtPathIfExists(bestHit.filePath);
            if (sourceFile) {
              for (const imp of sourceFile.getImportDeclarations()) {
                const moduleSpecifier = imp.getModuleSpecifierValue();
                if (moduleSpecifier.startsWith(".")) {
                  const resolvedPath = resolveImportPath(moduleSpecifier, bestHit.filePath);
                  if (resolvedPath) {
                    entry.importedFiles.push(resolvedPath);
                  }
                }
                for (const named of imp.getNamedImports()) {
                  entry.importedSymbols.push(named.getName());
                }
                const defaultImport = imp.getDefaultImport();
                if (defaultImport) {
                  entry.importedSymbols.push(defaultImport.getText());
                }
              }
            }
          } catch {
            // Import resolution failures are non-fatal
          }
        }

        directiveMap.set(usage.directiveName, entry);
      }

      // Track bound expressions and template files
      if (usage.boundExpression && !entry.boundExpressions.includes(usage.boundExpression)) {
        entry.boundExpressions.push(usage.boundExpression);
      }
      if (!entry.usedInTemplates.includes(usage.filePath)) {
        entry.usedInTemplates.push(usage.filePath);
      }
    }

    return [...directiveMap.values()];
  }

  /**
   * Phase 6: Resolve guard names from parsed routes to their definition files
   * and trace one level of imports to discover role/permission constant files.
   *
   * Chain: Route \u2192 guard name \u2192 symbol map \u2192 definition file \u2192 imports \u2192 roles.ts / permissions.ts
   *
   * This powers the contextPack guard metadata: when a JIRA ticket says
   * "add role pi-int-stuff", the agent can trace from the guard back to
   * the constants file that needs editing.
   */
  getResolvedGuards(): ResolvedGuard[] {
    // Collect all guard details across all parsed routes
    const guardMap = new Map<string, ResolvedGuard>();

    for (const route of this.parsedRoutes) {
      for (const detail of route.guardDetails) {
        let entry = guardMap.get(detail.name);
        if (!entry) {
          // Resolve guard name to a symbol definition file via the symbol map
          const symbolHits = this.searchSymbol(detail.name, 5);
          const bestHit = symbolHits.find((h) => h.symbol === detail.name) ?? symbolHits[0] ?? null;

          entry = {
            name: detail.name,
            definitionFile: bestHit?.filePath ?? null,
            kind: bestHit?.kind ?? null,
            importedFiles: [],
            importedSymbols: [],
            usedByRoutes: [],
            instances: [],
          };

          // If we found the definition file, trace its imports to find
          // role/permission/constant dependencies
          if (bestHit?.filePath) {
            try {
              const project = createTsMorphProject(resolveTsConfigPath(resolveTargetRepoRoot()));
              const sourceFile = project.addSourceFileAtPathIfExists(bestHit.filePath);
              if (sourceFile) {
                for (const imp of sourceFile.getImportDeclarations()) {
                  const moduleSpecifier = imp.getModuleSpecifierValue();
                  // Resolve relative imports to repo-relative paths
                  if (moduleSpecifier.startsWith(".")) {
                    const resolvedPath = resolveImportPath(moduleSpecifier, bestHit.filePath);
                    if (resolvedPath) {
                      entry.importedFiles.push(resolvedPath);
                    }
                  }
                  // Capture named import identifiers (ROLES, Permissions, AuthService, etc.)
                  for (const named of imp.getNamedImports()) {
                    entry.importedSymbols.push(named.getName());
                  }
                  // Capture default imports
                  const defaultImport = imp.getDefaultImport();
                  if (defaultImport) {
                    entry.importedSymbols.push(defaultImport.getText());
                  }
                }
              }
            } catch {
              // Import resolution failures are non-fatal — we still have the guard name + definition file
            }
          }
          guardMap.set(detail.name, entry);
        }

        // Track which routes use this guard and with which arguments
        if (!entry.usedByRoutes.includes(route.fullPath)) {
          entry.usedByRoutes.push(route.fullPath);
        }
        entry.instances.push({
          routePath: route.fullPath,
          guardType: detail.guardType,
          args: detail.args,
        });
      }
    }

    return [...guardMap.values()];
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

  /**
   * Phase 5: Parse route configuration files.
   * Scans .ts files for Angular route definitions (Routes arrays, provideRouter, RouterModule).
   */
  private async rebuildRouteIndex(repoRoot: string, tsFiles: string[]): Promise<void> {
    const project = createTsMorphProject(resolveTsConfigPath(repoRoot));

    for (const filePath of tsFiles) {
      try {
        // Quick content check to avoid parsing every .ts file with ts-morph
        const content = await readFile(filePath, "utf8");
        if (!isLikelyRouteFile(filePath, content)) continue;

        const sourceFile = project.addSourceFileAtPathIfExists(filePath);
        if (!sourceFile) continue;

        const result = parseRouteConfig(sourceFile);
        if (result.routes.length > 0) {
          this.parsedRoutes.push(...result.routes);
        }
        if (result.notes.length > 0) {
          this.routeParseNotes.push(...result.notes);
        }
      } catch (error) {
        this.failures.push({
          filePath,
          reason: error instanceof Error ? error.message : "ROUTE_INDEX_FAILED",
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

async function collectFiles(
  root: string,
  excludes: string[],
  repoRoot: string,
  gitFilter: GitignoreFilter,
): Promise<string[]> {
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
      // Fast path: skip entries whose name alone is always-excluded
      // (avoids computing relative paths for node_modules, dist, etc.)
      if (gitFilter.isHardExcludedSegment(entry.name)) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      const normalized = normalizeSlashes(fullPath);

      // Compute repo-relative path for .gitignore matching
      const relative = normalizeSlashes(path.relative(repoRoot, fullPath));
      if (gitFilter.isIgnored(relative)) {
        continue;
      }

      // Legacy hard-exclude check (belt + suspenders)
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

async function collectFilesAcrossRoots(
  roots: string[],
  excludes: string[],
  repoRoot: string,
  gitFilter: GitignoreFilter,
): Promise<string[]> {
  const files = new Set<string>();
  for (const root of roots) {
    const scoped = await collectFiles(root, excludes, repoRoot, gitFilter);
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve a relative import specifier (e.g. '../shared/roles') to a
 * repo-relative file path, given the importing file's absolute path.
 * Tries .ts extension first, then /index.ts.
 */
function resolveImportPath(moduleSpecifier: string, fromFilePath: string): string | null {
  if (!moduleSpecifier.startsWith(".")) return null;
  const fromDir = path.dirname(fromFilePath);
  const resolved = path.resolve(fromDir, moduleSpecifier);
  const normalized = normalizeSlashes(resolved);

  // Try direct .ts
  const withTs = normalized.endsWith(".ts") ? normalized : `${normalized}.ts`;
  if (existsSync(withTs)) return withTs;

  // Try /index.ts (barrel re-exports)
  const indexTs = `${normalized}/index.ts`;
  if (existsSync(indexTs)) return indexTs;

  return withTs; // Return best guess even if file doesn't exist (may be .js, etc.)
}
