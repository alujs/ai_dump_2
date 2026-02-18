/**
 * Seed-Facts-From-Index — generates JSONL seed files from IndexingService
 * output so that `graphops:sync` populates Neo4j with:
 *
 *   1. DomainAnchor nodes  (from anchorSeeder.scanAnchors)
 *   2. SymbolDefinition nodes  (from IndexingService.getSymbolHeaders)
 *   3. Component nodes  (derived from template usage tags)
 *   4. UsageExample nodes  (from IndexingService.getTemplateUsageFacts)
 *   5. Edges: FILE_DECLARES_SYMBOL, IN_ANCHOR, USES_COMPONENT, HAS_USAGE
 *
 * This module is intentionally WRITE-ONLY: it generates JSONL files that
 * graphOpsService.sync() consumes. It does NOT talk to Neo4j directly.
 *
 * Run via:  npm run graphops:seed-facts
 */

import path from "node:path";
import { writeFile } from "node:fs/promises";
import { ensureDir } from "../../shared/fileStore";
import { scanAnchors, resolveAnchorsForFiles, type AnchorSeedResult } from "../memory/anchorSeeder";
import type { SymbolHeader, TemplateUsageFact, ParsedRoute, TemplateRouterLinkFact } from "../indexing/indexingService";
import type { DomainAnchor } from "../../contracts/memoryRecord";

/* ── Types ───────────────────────────────────────────────── */

interface SeedNodeRow {
  kind: "node";
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

interface SeedRelRow {
  kind: "relationship";
  from: { id: string; label: string };
  to: { id: string; label: string };
  relType: string;
  properties: Record<string, unknown>;
}

type SeedRow = SeedNodeRow | SeedRelRow;

export interface SeedFactsResult {
  anchorCount: number;
  symbolCount: number;
  componentCount: number;
  usageExampleCount: number;
  routeCount: number;
  edgeCount: number;
  files: string[];
}

/* ── Public API ──────────────────────────────────────────── */

/**
 * Generate all fact JSONL files from runtime index data.
 *
 * @param repoRoot    Absolute path to target repo root
 * @param seedRoot    Absolute path to .ai/graph/seed/
 * @param symbols     From IndexingService.getSymbolHeaders()
 * @param usageFacts  From IndexingService.getTemplateUsageFacts()
 * @param routes      From IndexingService.getParsedRoutes()
 * @param routerLinks From IndexingService.getTemplateRouterLinks()
 * @param routerOutletFiles From IndexingService.getRouterOutletFiles()
 */
export async function generateFactSeedFiles(
  repoRoot: string,
  seedRoot: string,
  symbols: SymbolHeader[],
  usageFacts: TemplateUsageFact[],
  routes: ParsedRoute[] = [],
  routerLinks: TemplateRouterLinkFact[] = [],
  routerOutletFiles: string[] = [],
): Promise<SeedFactsResult> {
  const factDir = path.join(seedRoot, "fact");
  await ensureDir(factDir);
  const now = new Date().toISOString();

  /* ── 1. Domain Anchors ─────────────────────────────────── */
  const anchorResult = await scanAnchors(repoRoot);
  const anchorRows = buildAnchorRows(anchorResult, now);
  const anchorFile = path.join(factDir, "anchors.jsonl");
  await writeJsonlFile(anchorFile, anchorRows);

  /* ── 2. Symbol stubs ───────────────────────────────────── */
  const symbolRows = buildSymbolRows(symbols, repoRoot, anchorResult.anchors, now);
  const symbolFile = path.join(factDir, "symbols.jsonl");
  await writeJsonlFile(symbolFile, symbolRows.nodes);

  /* ── 3. Component + UsageExample nodes ─────────────────── */
  const componentResult = buildComponentAndUsageRows(usageFacts, repoRoot, anchorResult.anchors, now);
  const componentFile = path.join(factDir, "components.jsonl");
  await writeJsonlFile(componentFile, componentResult.nodes);

  /* ── 4. Route nodes + edges ─────────────────────────────── */
  const routeResult = buildRouteRows(routes, repoRoot, anchorResult.anchors, routerLinks, routerOutletFiles, now);
  const routeFile = path.join(factDir, "routes.jsonl");
  await writeJsonlFile(routeFile, routeResult.nodes);

  /* ── 5. All edges ──────────────────────────────────────── */
  const allEdges: SeedRow[] = [
    ...symbolRows.edges,
    ...componentResult.edges,
    ...routeResult.edges,
  ];
  const edgeFile = path.join(factDir, "edges.jsonl");
  await writeJsonlFile(edgeFile, allEdges);

  return {
    anchorCount: anchorResult.anchors.length,
    symbolCount: symbolRows.nodes.length,
    componentCount: componentResult.componentCount,
    usageExampleCount: componentResult.usageCount,
    routeCount: routeResult.routeCount,
    edgeCount: allEdges.length,
    files: [anchorFile, symbolFile, componentFile, routeFile, edgeFile],
  };
}

/* ── Anchor rows ─────────────────────────────────────────── */

function buildAnchorRows(result: AnchorSeedResult, now: string): SeedRow[] {
  const rows: SeedRow[] = [];

  for (const anchor of result.anchors) {
    rows.push({
      kind: "node",
      id: anchor.id,
      labels: ["Entity", "DomainAnchor"],
      properties: {
        id: anchor.id,
        name: anchor.name,
        folderPath: anchor.folderPath,
        depth: anchor.depth,
        parentAnchorId: anchor.parentAnchorId ?? "",
        autoSeeded: true,
        updated_at: now,
        updated_by: "seed-facts",
      },
    });
  }

  for (const rel of result.relationships) {
    rows.push(rel);
  }

  return rows;
}

/* ── Symbol rows ─────────────────────────────────────────── */

function buildSymbolRows(
  symbols: SymbolHeader[],
  repoRoot: string,
  anchors: DomainAnchor[],
  now: string,
): { nodes: SeedRow[]; edges: SeedRow[] } {
  const nodes: SeedRow[] = [];
  const edges: SeedRow[] = [];
  const seen = new Set<string>();

  for (const sym of symbols) {
    const relativePath = normalizeToRelative(sym.filePath, repoRoot);
    const id = `sym:${sym.kind}:${relativePath}#${sym.symbol}`;

    if (seen.has(id)) continue;
    seen.add(id);

    nodes.push({
      kind: "node",
      id,
      labels: ["SymbolDefinition"],
      properties: {
        id,
        name: sym.symbol,
        kind: sym.kind,
        filePath: relativePath,
        highSignal: sym.highSignal,
        updated_at: now,
        updated_by: "seed-facts",
      },
    });

    // Edge: FILE_DECLARES_SYMBOL (file → symbol)
    // Use a stable "file entity" id so symbols are grouped by file
    const fileId = `file:${relativePath}`;
    edges.push({
      kind: "relationship",
      from: { id: fileId, label: "File" },
      to: { id, label: "SymbolDefinition" },
      relType: "DECLARES",
      properties: { updated_at: now, updated_by: "seed-facts" },
    });

    // Edge: IN_ANCHOR (symbol → deepest matching domain anchor)
    const anchorIds = resolveAnchorsForFiles([relativePath], anchors);
    if (anchorIds.length > 0) {
      edges.push({
        kind: "relationship",
        from: { id, label: "SymbolDefinition" },
        to: { id: anchorIds[0], label: "DomainAnchor" },
        relType: "IN_ANCHOR",
        properties: { updated_at: now, updated_by: "seed-facts" },
      });
    }
  }

  return { nodes, edges };
}

/* ── Component + UsageExample rows ───────────────────────── */

function buildComponentAndUsageRows(
  usageFacts: TemplateUsageFact[],
  repoRoot: string,
  anchors: DomainAnchor[],
  now: string,
): { nodes: SeedRow[]; edges: SeedRow[]; componentCount: number; usageCount: number } {
  const nodes: SeedRow[] = [];
  const edges: SeedRow[] = [];
  const seenComponents = new Set<string>();
  let usageCount = 0;

  for (const fact of usageFacts) {
    const relativePath = normalizeToRelative(fact.filePath, repoRoot);
    const componentId = `component:${fact.tag}`;

    // Create Component node (once per unique tag)
    if (!seenComponents.has(componentId)) {
      seenComponents.add(componentId);
      nodes.push({
        kind: "node",
        id: componentId,
        labels: ["Component"],
        properties: {
          id: componentId,
          tag: fact.tag,
          isAdp: fact.isAdp,
          isSdf: fact.isSdf,
          updated_at: now,
          updated_by: "seed-facts",
        },
      });
    }

    // Create UsageExample node (one per occurrence)
    const usageId = `usage:${relativePath}:L${fact.line}:${fact.tag}`;
    nodes.push({
      kind: "node",
      id: usageId,
      labels: ["UsageExample"],
      properties: {
        id: usageId,
        tag: fact.tag,
        filePath: relativePath,
        line: fact.line,
        attributes: JSON.stringify(fact.attributes),
        isAdp: fact.isAdp,
        isSdf: fact.isSdf,
        updated_at: now,
        updated_by: "seed-facts",
      },
    });
    usageCount++;

    // Edge: HAS_USAGE (Component → UsageExample)
    edges.push({
      kind: "relationship",
      from: { id: componentId, label: "Component" },
      to: { id: usageId, label: "UsageExample" },
      relType: "HAS_USAGE",
      properties: { updated_at: now, updated_by: "seed-facts" },
    });

    // Edge: IN_ANCHOR (UsageExample → deepest matching domain anchor)
    const anchorIds = resolveAnchorsForFiles([relativePath], anchors);
    if (anchorIds.length > 0) {
      edges.push({
        kind: "relationship",
        from: { id: usageId, label: "UsageExample" },
        to: { id: anchorIds[0], label: "DomainAnchor" },
        relType: "IN_ANCHOR",
        properties: { updated_at: now, updated_by: "seed-facts" },
      });
    }
  }

  return { nodes, edges, componentCount: seenComponents.size, usageCount };
}

/* ── Route rows ──────────────────────────────────────────── */

/**
 * Build AngularRoute nodes and edges:
 *   - AngularRoute nodes (one per route definition)
 *   - ROUTES_TO edges (route → component symbol, resolved from loadComponent target)
 *   - CHILD_OF edges (child route → parent route)
 *   - IN_ANCHOR edges (route → deepest matching domain anchor)
 *   - LOADS_CHILDREN edges (route → child route file, for lazy-loaded route modules)
 *   - REFERENCED_BY_TEMPLATE edges (route ← template routerLink)
 */
function buildRouteRows(
  routes: ParsedRoute[],
  repoRoot: string,
  anchors: DomainAnchor[],
  routerLinks: TemplateRouterLinkFact[],
  routerOutletFiles: string[],
  now: string,
): { nodes: SeedRow[]; edges: SeedRow[]; routeCount: number } {
  const nodes: SeedRow[] = [];
  const edges: SeedRow[] = [];
  const seen = new Set<string>();

  // Build a path → routeId lookup for routerLink matching
  const pathToRouteId = new Map<string, string>();

  for (const route of routes) {
    const relativePath = normalizeToRelative(route.filePath, repoRoot);
    const routeId = `route:${relativePath}#${route.fullPath || "(root)"}`;

    if (seen.has(routeId)) continue;
    seen.add(routeId);
    pathToRouteId.set(route.fullPath, routeId);

    nodes.push({
      kind: "node",
      id: routeId,
      labels: ["AngularRoute"],
      properties: {
        id: routeId,
        path: route.fullPath,
        pathSegment: route.pathSegment,
        filePath: relativePath,
        line: route.line,
        isLazy: route.isLazy,
        loadComponentTarget: route.loadComponentTarget ?? "",
        loadChildrenTarget: route.loadChildrenTarget ?? "",
        guards: JSON.stringify(route.guards),
        hasChildren: route.hasChildren,
        hasProviders: route.hasProviders,
        updated_at: now,
        updated_by: "seed-facts",
      },
    });

    // Edge: CHILD_OF (this route → parent route)
    if (route.parentRoutePath !== undefined) {
      const parentRelativePath = relativePath; // parent is in same file (inline children)
      const parentRouteId = `route:${parentRelativePath}#${route.parentRoutePath || "(root)"}`;
      edges.push({
        kind: "relationship",
        from: { id: routeId, label: "AngularRoute" },
        to: { id: parentRouteId, label: "AngularRoute" },
        relType: "CHILD_OF",
        properties: { updated_at: now, updated_by: "seed-facts" },
      });
    }

    // Edge: ROUTES_TO component (resolve loadComponent target to a symbol)
    if (route.loadComponentTarget) {
      // loadComponent target is a relative import like './login/login.component'
      // Resolve to a Component node ID by deriving the component selector/class from the path
      const targetRelPath = resolveImportToRelative(route.loadComponentTarget, relativePath);
      if (targetRelPath) {
        // We don't know the exact symbol name, so reference via file path
        // The SymbolDefinition nodes use filePath — create a ROUTES_TO edge to a stable file reference
        const fileId = `file:${targetRelPath}`;
        edges.push({
          kind: "relationship",
          from: { id: routeId, label: "AngularRoute" },
          to: { id: fileId, label: "File" },
          relType: "ROUTES_TO",
          properties: {
            resolvedTarget: targetRelPath,
            updated_at: now,
            updated_by: "seed-facts",
          },
        });
      }
    }

    // Edge: LOADS_CHILDREN (route → child route file for lazy-loaded child routes)
    if (route.loadChildrenTarget) {
      const targetRelPath = resolveImportToRelative(route.loadChildrenTarget, relativePath);
      if (targetRelPath) {
        const fileId = `file:${targetRelPath}`;
        edges.push({
          kind: "relationship",
          from: { id: routeId, label: "AngularRoute" },
          to: { id: fileId, label: "File" },
          relType: "LOADS_CHILDREN",
          properties: {
            resolvedTarget: targetRelPath,
            updated_at: now,
            updated_by: "seed-facts",
          },
        });
      }
    }

    // Edge: IN_ANCHOR (route → deepest matching domain anchor)
    const anchorIds = resolveAnchorsForFiles([relativePath], anchors);
    if (anchorIds.length > 0) {
      edges.push({
        kind: "relationship",
        from: { id: routeId, label: "AngularRoute" },
        to: { id: anchorIds[0], label: "DomainAnchor" },
        relType: "IN_ANCHOR",
        properties: { updated_at: now, updated_by: "seed-facts" },
      });
    }
  }

  // Template routerLink → Route matching
  // Match template routerLink references to the closest route by path
  for (const link of routerLinks) {
    const normalizedLinkPath = link.routePath.startsWith("/") ? link.routePath.slice(1) : link.routePath;
    const matchedRouteId = pathToRouteId.get(normalizedLinkPath);
    if (matchedRouteId) {
      const linkRelPath = normalizeToRelative(link.filePath, repoRoot);
      const linkId = `routerlink:${linkRelPath}:L${link.line}:${link.routePath}`;
      edges.push({
        kind: "relationship",
        from: { id: `file:${linkRelPath}`, label: "File" },
        to: { id: matchedRouteId, label: "AngularRoute" },
        relType: "REFERENCES_ROUTE",
        properties: {
          routePath: link.routePath,
          hostTag: link.hostTag,
          isBound: link.isBound,
          line: link.line,
          updated_at: now,
          updated_by: "seed-facts",
        },
      });
    }
  }

  return { nodes, edges, routeCount: seen.size };
}

/* ── Helpers ─────────────────────────────────────────────── */

/**
 * Resolve a relative import path (e.g. './login/login.component') to a
 * workspace-relative path, given the source file's relative path.
 * Strips .ts extension normalization — import paths don't include extensions.
 */
function resolveImportToRelative(importPath: string, sourceRelativePath: string): string | null {
  if (!importPath.startsWith(".")) return null; // Only handle relative imports
  const sourceDir = path.dirname(sourceRelativePath);
  const resolved = path.posix.normalize(path.posix.join(sourceDir, importPath));
  // Add .ts extension if not present (Angular imports omit it)
  return resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
}

function normalizeToRelative(filePath: string, repoRoot: string): string {
  const relative = path.relative(repoRoot, filePath);
  return relative.replace(/\\/g, "/");
}

async function writeJsonlFile(filePath: string, rows: SeedRow[]): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const content = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
  await writeFile(filePath, content, "utf8");
}
