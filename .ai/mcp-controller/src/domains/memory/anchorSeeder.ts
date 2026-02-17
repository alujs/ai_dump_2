/**
 * Domain Anchor Auto-Seeder — scans repo folder structure and generates
 * DomainAnchor graph nodes with :CONTAINS parent-child relationships.
 *
 * Uses folder paths as domain boundaries. Configurable via .ai/memory/config.ts.
 * Can output seed data as JSONL (for graphOps upsert) or return structured data
 * for in-memory use.
 *
 * Entry points:
 *   - scanAnchors(repoRoot): returns DomainAnchor[] + relationship edges
 *   - writeSeedFile(repoRoot, outPath): writes JSONL seed file for graphOps
 */

import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { MEMORY_CONFIG } from "./config";
import type { DomainAnchor } from "../../contracts/memoryRecord";
import { appendJsonl } from "../../shared/fileStore";

/* ── Types ───────────────────────────────────────────────── */

export interface AnchorSeedResult {
  anchors: DomainAnchor[];
  relationships: AnchorRelationship[];
}

export interface AnchorRelationship {
  kind: "relationship";
  from: { id: string; label: string };
  to: { id: string; label: string };
  relType: string;
  properties: Record<string, unknown>;
}

/* ── Core scanning logic ─────────────────────────────────── */

/**
 * Scan the target repo's folder tree and produce DomainAnchor nodes
 * with parent→child :CONTAINS relationships.
 */
export async function scanAnchors(
  repoRoot: string,
  config = MEMORY_CONFIG,
): Promise<AnchorSeedResult> {
  const anchors: DomainAnchor[] = [];
  const relationships: AnchorRelationship[] = [];
  const now = new Date().toISOString();

  await walkDir(repoRoot, "", 0, config.anchorAutoSeedMaxDepth, config, anchors, relationships, now);

  // Add forced includes that may have been excluded by depth
  for (const override of config.anchorIncludeOverrides) {
    const anchorId = `anchor:${override}`;
    if (!anchors.some((a) => a.id === anchorId)) {
      const fullPath = path.join(repoRoot, override);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          const depth = override.split("/").filter(Boolean).length;
          const anchor: DomainAnchor = {
            id: anchorId,
            labels: ["DomainAnchor"],
            name: path.basename(override),
            folderPath: override,
            depth,
            autoSeeded: true,
            updatedAt: now,
          };
          // Find parent
          const parentPath = path.dirname(override);
          if (parentPath && parentPath !== ".") {
            const parentId = `anchor:${parentPath}`;
            anchor.parentAnchorId = parentId;
            relationships.push(makeContainsRel(parentId, anchorId, now));
          }
          anchors.push(anchor);
        }
      } catch {
        // Path doesn't exist, skip
      }
    }
  }

  return { anchors, relationships };
}

/**
 * Write anchor + relationship seed data as JSONL for graphOps.
 * Returns the file path written.
 */
export async function writeAnchorSeedFile(
  repoRoot: string,
  outPath: string,
  config = MEMORY_CONFIG,
): Promise<{ filePath: string; anchorCount: number; relCount: number }> {
  const { anchors, relationships } = await scanAnchors(repoRoot, config);

  // Write as JSONL seed rows compatible with graphOpsService.upsertSeed
  for (const anchor of anchors) {
    await appendJsonl(outPath, {
      kind: "node",
      id: anchor.id,
      labels: ["Entity", "DomainAnchor"],
      properties: {
        id: anchor.id,
        name: anchor.name,
        folderPath: anchor.folderPath,
        depth: anchor.depth,
        parentAnchorId: anchor.parentAnchorId ?? "",
        autoSeeded: anchor.autoSeeded,
        updated_at: anchor.updatedAt,
        updated_by: "anchor-seeder",
      },
    });
  }

  for (const rel of relationships) {
    await appendJsonl(outPath, rel);
  }

  return { filePath: outPath, anchorCount: anchors.length, relCount: relationships.length };
}

/* ── Internal helpers ────────────────────────────────────── */

async function walkDir(
  repoRoot: string,
  relativePath: string,
  currentDepth: number,
  maxDepth: number,
  config: typeof MEMORY_CONFIG,
  anchors: DomainAnchor[],
  relationships: AnchorRelationship[],
  now: string,
): Promise<void> {
  if (currentDepth > maxDepth) return;

  const fullPath = relativePath
    ? path.join(repoRoot, relativePath)
    : repoRoot;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(fullPath, { withFileTypes: true }) as unknown as import("node:fs").Dirent[];
  } catch {
    return; // Permission denied, symlink, etc.
  }

  const dirs = entries.filter((entry) => {
    if (!entry.isDirectory()) return false;
    const name = entry.name;
    // Exclude dotfiles/dirs (except explicitly included)
    if (name.startsWith(".")) return false;
    // Exclude configured patterns
    return !config.anchorExcludePatterns.some((pattern) => matchesExclude(name, pattern));
  });

  for (const dir of dirs) {
    const childRelativePath = relativePath
      ? `${relativePath}/${dir.name}`
      : dir.name;
    const anchorId = `anchor:${childRelativePath}`;

    const anchor: DomainAnchor = {
      id: anchorId,
      labels: ["DomainAnchor"],
      name: dir.name,
      folderPath: childRelativePath,
      depth: currentDepth + 1,
      autoSeeded: true,
      updatedAt: now,
    };

    // Link to parent
    if (relativePath) {
      const parentId = `anchor:${relativePath}`;
      anchor.parentAnchorId = parentId;
      relationships.push(makeContainsRel(parentId, anchorId, now));
    }

    anchors.push(anchor);

    // Recurse
    await walkDir(repoRoot, childRelativePath, currentDepth + 1, maxDepth, config, anchors, relationships, now);
  }
}

function makeContainsRel(fromId: string, toId: string, now: string): AnchorRelationship {
  return {
    kind: "relationship",
    from: { id: fromId, label: "DomainAnchor" },
    to: { id: toId, label: "DomainAnchor" },
    relType: "CONTAINS",
    properties: { updated_at: now, updated_by: "anchor-seeder" },
  };
}

function matchesExclude(name: string, pattern: string): boolean {
  // Simple glob: exact match or wildcard suffix
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

/**
 * Resolve which anchor IDs are in scope for a set of file paths.
 * Returns the most specific (deepest) anchor for each file.
 */
export function resolveAnchorsForFiles(
  filePaths: string[],
  anchors: DomainAnchor[],
): string[] {
  const anchorIds = new Set<string>();
  // Sort anchors by depth descending (most specific first)
  const sorted = [...anchors].sort((a, b) => b.depth - a.depth);

  for (const filePath of filePaths) {
    // Normalize to forward slashes for matching
    const normalized = filePath.replace(/\\/g, "/");
    for (const anchor of sorted) {
      if (normalized.startsWith(anchor.folderPath + "/") || normalized === anchor.folderPath) {
        anchorIds.add(anchor.id);
        break; // Most specific match found
      }
    }
  }

  return [...anchorIds];
}

/**
 * Given anchor IDs, return those IDs plus all ancestor anchor IDs.
 * This is used to find memories that apply to parent domains.
 */
export function expandAnchorHierarchy(
  anchorIds: string[],
  anchors: DomainAnchor[],
): string[] {
  const expanded = new Set<string>(anchorIds);
  const anchorMap = new Map(anchors.map((a) => [a.id, a]));

  for (const id of anchorIds) {
    let current = anchorMap.get(id);
    while (current?.parentAnchorId) {
      expanded.add(current.parentAnchorId);
      current = anchorMap.get(current.parentAnchorId);
    }
  }

  return [...expanded];
}
