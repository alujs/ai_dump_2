import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { VerbResult, SessionState } from "../types";
import type { IndexingService } from "../../indexing/indexingService";
import type { MemoryService } from "../../memory/memoryService";
import { MEMORY_CONFIG } from "../../memory/config";
import { readText } from "../../../shared/fileStore";
import { normalizeSafePath, resolveTargetRepoRoot } from "../../../shared/fsPaths";
import {
  scopeAllowsFile,
} from "../../worktree-scope/worktreeScopeService";

/** Like normalizeSafePath but allows the directory to equal the root itself. */
function normalizeSafeDir(root: string, relativeTarget: string): string {
  const resolved = path.resolve(root, relativeTarget);
  const normalizedRoot = path.resolve(root);
  // Allow exact root match (for ".") or any child path
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error("PATH_SCOPE_VIOLATION");
  }
  return resolved;
}

/**
 * Check if a file path is within the session's contextPack.
 * When contextPack is set (post-initialize_work), all reads are pack-scoped.
 * §3 lines 141-153 — pack-scoping rule.
 */
function isInPack(filePath: string, session: SessionState): boolean {
  if (!session.contextPack) return true; // No pack yet → allow (backward compat)
  const normalized = filePath.replace(/\\/g, "/");
  // Scratch-area files (.ai/tmp/work/) are always accessible — they're the agent's own workspace
  if (normalized.includes(".ai/tmp/work/")) return true;
  return session.contextPack.files.some((f) => {
    const normalizedPackFile = f.replace(/\\/g, "/");
    return normalized === normalizedPackFile
      || normalized.endsWith(normalizedPackFile)
      || normalizedPackFile.endsWith(normalized);
  });
}

export async function handleReadRange(
  args: Record<string, unknown> | undefined,
  session: SessionState
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const targetFile = String(args?.targetFile ?? "");
  const startLine = Math.max(1, Number(args?.startLine ?? 1));
  const endLine = Math.max(startLine, Number(args?.endLine ?? startLine + 99));

  if (!targetFile) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "args.targetFile is required but was missing or empty. Supply a relative file path within the worktree (e.g., 'src/main.ts'). Optionally include args.startLine and args.endLine (1-based) to narrow the read range.";
    result.missingFields = ["targetFile"];
    return { result, denyReasons };
  }

  /* ── Pack-scope check ──────────────────────────────────── */
  if (!isInPack(targetFile, session)) {
    denyReasons.push("PACK_SCOPE_VIOLATION");
    result.error = `File '${targetFile}' is not in the contextPack. Use 'escalate' to request additional files be added to the pack.`;
    return { result, denyReasons };
  }

  const readRoot = session.planGraph?.worktreeRoot ?? resolveTargetRepoRoot();
  const scopeCheck = scopeAllowsFile({
    workId: session.workId,
    targetFile,
    worktreeRoot: readRoot,
    allowlist: session.scopeAllowlist,
  });
  if (!scopeCheck.ok) {
    denyReasons.push(scopeCheck.rejectionCode ?? "PLAN_SCOPE_VIOLATION");
    result.readRangeError = scopeCheck.reason;
    return { result, denyReasons };
  }

  try {
    const safePath = normalizeSafePath(readRoot, targetFile);
    const content = await readText(safePath);
    const lines = content.split("\n");
    const slice = lines.slice(startLine - 1, endLine).map((text, index) => ({
      line: startLine + index,
      text,
    }));
    result.readRange = { targetFile, startLine, endLine, totalLines: lines.length, lines: slice };
  } catch (error) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.readRangeError = error instanceof Error ? error.message : "READ_RANGE_FAILED";
  }

  return { result, denyReasons };
}

export async function handleReadSymbol(
  args: Record<string, unknown> | undefined,
  indexing: IndexingService | null,
  session?: SessionState,
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const symbol = String(args?.symbol ?? "").trim();
  if (!symbol) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "args.symbol is required but was missing or empty. Supply the name of a class, function, interface, enum, type, or variable to search for (e.g., 'TurnController' or 'handleTurn').";
    result.missingFields = ["symbol"];
    return { result, denyReasons };
  }
  if (!indexing) {
    denyReasons.push("PLAN_VERIFICATION_WEAK");
    result.readSymbolError = "Indexing service unavailable.";
    return { result, denyReasons };
  }

  const limit = Math.max(1, Number(args?.limit ?? 12));
  let matches = indexing.searchSymbol(symbol, limit);

  // Pack-scope filter: only return symbols from contextPack files
  if (session?.contextPack) {
    matches = matches.filter((m: { filePath?: string }) =>
      m.filePath ? isInPack(m.filePath, session) : true
    );
  }

  result.readSymbol = { symbol, matches };
  return { result, denyReasons };
}

export async function handleGrepLexeme(
  args: Record<string, unknown> | undefined,
  indexing: IndexingService | null,
  session?: SessionState,
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const query = String(args?.query ?? args?.lexeme ?? "").trim();
  if (!query) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "args.query (or args.lexeme) is required but was missing or empty. Supply a search string to grep for across the indexed codebase (e.g., 'TODO' or 'fetchUser').";
    result.missingFields = ["query"];
    return { result, denyReasons };
  }
  if (!indexing) {
    denyReasons.push("PLAN_VERIFICATION_WEAK");
    result.grepLexemeError = "Indexing service unavailable.";
    return { result, denyReasons };
  }

  const limit = Math.max(1, Number(args?.limit ?? 20));
  let hits = indexing.searchLexical(query, limit);

  // Pack-scope filter: only return hits from contextPack files
  if (session?.contextPack) {
    hits = hits.filter((h: { filePath?: string }) =>
      h.filePath ? isInPack(h.filePath, session) : true
    );
  }

  result.grepLexeme = { query, hits };
  return { result, denyReasons };
}

export async function handleListDir(
  args: Record<string, unknown> | undefined,
  session: SessionState
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const targetDir = String(args?.targetDir ?? args?.path ?? "").trim();
  if (!targetDir) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "args.targetDir is required but was missing or empty. Supply a relative directory path within the worktree (e.g., 'src/app/profile').";
    result.missingFields = ["targetDir"];
    return { result, denyReasons };
  }

  const readRoot = session.planGraph?.worktreeRoot ?? resolveTargetRepoRoot();

  // For directories we do our own containment check rather than using scopeAllowsFile
  // (which is designed for file paths and rejects root-level "." due to path.sep suffix check).
  try {
    const safePath = normalizeSafeDir(readRoot, targetDir);
    const entries = readdirSync(safePath, { withFileTypes: true });
    const maxEntries = Math.min(Number(args?.limit ?? 200), 500);

    const items = entries.slice(0, maxEntries).map((entry) => {
      const isDir = entry.isDirectory();
      const name = isDir ? `${entry.name}/` : entry.name;
      const item: Record<string, unknown> = { name, type: isDir ? "directory" : "file" };
      if (!isDir) {
        try {
          const fullPath = path.join(safePath, entry.name);
          const stat = statSync(fullPath);
          item.size = stat.size;
        } catch { /* stat failures are non-fatal */ }
      }
      return item;
    });

    result.listDir = {
      targetDir,
      entries: items,
      totalEntries: entries.length,
      truncated: entries.length > maxEntries,
    };
  } catch (error) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.listDirError = error instanceof Error ? error.message : "LIST_DIR_FAILED";
  }

  return { result, denyReasons };
}

export async function handleReadNeighbors(
  args: Record<string, unknown> | undefined,
  indexing: IndexingService | null,
  memoryService?: MemoryService,
  session?: SessionState,
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  if (!indexing) {
    denyReasons.push("PLAN_VERIFICATION_WEAK");
    result.readNeighborsError = "Indexing service unavailable.";
    return { result, denyReasons };
  }

  const symbol = String(args?.symbol ?? "").trim();
  const targetFile = String(args?.targetFile ?? "").trim();
  const query = String(args?.query ?? "").trim();
  const limit = Math.max(1, Number(args?.limit ?? 12));

  if (!symbol && !targetFile && !query) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "At least one of args.symbol, args.targetFile, or args.query is required for trace_symbol_graph. Supply a symbol name, file path, or text query to anchor the neighbor search.";
    result.missingFields = ["symbol | targetFile | query"];
    return { result, denyReasons };
  }

  let symbolMatches = symbol ? indexing.searchSymbol(symbol, limit) : [];
  const lexicalQuery = query || symbol || path.basename(targetFile);
  let lexicalMatches = indexing.searchLexical(lexicalQuery, limit);

  // Pack-scope filter: only return neighbors within contextPack files
  if (session?.contextPack) {
    symbolMatches = symbolMatches.filter((m: { filePath?: string }) =>
      m.filePath ? isInPack(m.filePath, session) : true
    );
    lexicalMatches = lexicalMatches.filter((h: { filePath?: string }) =>
      h.filePath ? isInPack(h.filePath, session) : true
    );
  }

  result.readNeighbors = { anchor: symbol || targetFile || query, symbolMatches, lexicalMatches };

  /* ── Few-shot injection from active memories ──────────── */
  if (memoryService && MEMORY_CONFIG.enableFewShotInjection) {
    try {
      const filePaths = [targetFile, ...symbolMatches.map((m) => m.filePath)].filter(Boolean);
      const { resolveAnchorsForFiles, expandAnchorHierarchy, scanAnchors } = await import("../../memory/anchorSeeder");
      const { resolveRepoRoot } = await import("../../../shared/fsPaths");
      const repoRoot = resolveRepoRoot();
      const { anchors: allAnchors } = await scanAnchors(repoRoot);
      const anchorIds = resolveAnchorsForFiles(filePaths, allAnchors);
      const expandedIds = expandAnchorHierarchy(anchorIds, allAnchors);
      if (expandedIds.length > 0) {
        const activeMemories = await memoryService.findActiveForAnchors(expandedIds);
        const fewShotExamples = activeMemories
          .filter((m) => m.enforcementType === "few_shot" && m.fewShot)
          .map((m) => ({
            memoryId: m.id,
            instruction: m.fewShot!.instruction,
            before: m.fewShot!.before,
            after: m.fewShot!.after,
            antiPattern: m.fewShot!.antiPattern,
            whyWrong: m.fewShot!.whyWrong,
            scaffolded: m.fewShot!.scaffolded ?? false,
          }));
        if (fewShotExamples.length > 0) {
          result.fewShotExamples = fewShotExamples;
        }
      }
    } catch {
      // Few-shot injection is non-fatal
    }
  }

  return { result, denyReasons };
}
