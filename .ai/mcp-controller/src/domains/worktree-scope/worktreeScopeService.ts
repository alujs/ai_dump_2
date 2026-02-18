import path from "node:path";
import { readText } from "../../shared/fileStore";
import { normalizeSafePath, workRoot } from "../../shared/fsPaths";

export interface ScopeAllowlist {
  files: string[];
  symbolsByFile?: Record<string, string[]>;
}

export interface ScopeCheckResult {
  ok: boolean;
  rejectionCode?: "PLAN_SCOPE_VIOLATION";
  reason?: string;
}

export async function loadScopeAllowlist(scopeAllowlistRef: string): Promise<ScopeAllowlist | null> {
  if (!scopeAllowlistRef || scopeAllowlistRef.trim().length === 0) {
    return null;
  }
  try {
    const raw = await readText(scopeAllowlistRef);
    const parsed = JSON.parse(raw) as Partial<ScopeAllowlist>;
    const files = Array.isArray(parsed.files) ? parsed.files.map((item) => String(item)) : [];
    const symbolsByFile = isRecord(parsed.symbolsByFile)
      ? Object.fromEntries(
          Object.entries(parsed.symbolsByFile).map(([filePath, symbols]) => [
            filePath,
            Array.isArray(symbols) ? symbols.map((item) => String(item)) : []
          ])
        )
      : undefined;
    return { files, symbolsByFile };
  } catch {
    return null;
  }
}

export function scopeAllowsFile(
  input: {
    workId: string;
    targetFile: string;
    worktreeRoot?: string;
    allowlist?: ScopeAllowlist | null;
  }
): ScopeCheckResult {
  const root = input.worktreeRoot ? path.resolve(input.worktreeRoot) : workRoot(input.workId);
  const target = normalizeFilePath(root, input.targetFile);
  if (!target) {
    return {
      ok: false,
      rejectionCode: "PLAN_SCOPE_VIOLATION",
      reason: "Target file escapes worktree scope."
    };
  }

  if (!input.allowlist || input.allowlist.files.length === 0) {
    return { ok: true };
  }

  const allowlistNormalized = input.allowlist.files
    .map((value) => normalizeFilePath(root, value))
    .filter((value): value is string => Boolean(value));
  if (!allowlistNormalized.includes(target)) {
    return {
      ok: false,
      rejectionCode: "PLAN_SCOPE_VIOLATION",
      reason: "Target file is not in approved allowlist."
    };
  }

  return { ok: true };
}

export function scopeAllowsSymbols(
  input: {
    targetFile: string;
    requestedSymbols: string[];
    allowlist?: ScopeAllowlist | null;
  }
): ScopeCheckResult {
  if (!input.allowlist?.symbolsByFile) {
    return { ok: true };
  }

  const allowed = input.allowlist.symbolsByFile[input.targetFile];
  if (!allowed || allowed.length === 0) {
    return { ok: true };
  }
  if (input.requestedSymbols.some((symbol) => symbol === "*" || symbol.trim().length === 0)) {
    return {
      ok: false,
      rejectionCode: "PLAN_SCOPE_VIOLATION",
      reason: "Wildcard or empty symbol scopes are forbidden."
    };
  }

  const missing = input.requestedSymbols.filter((symbol) => !allowed.includes(symbol));
  if (missing.length > 0) {
    return {
      ok: false,
      rejectionCode: "PLAN_SCOPE_VIOLATION",
      reason: `Symbols out of scope: ${missing.join(",")}`
    };
  }
  return { ok: true };
}

export function listAllowedFiles(
  workId: string,
  allowlist?: ScopeAllowlist | null,
  worktreeRoot?: string
): string[] {
  if (!allowlist || allowlist.files.length === 0) {
    // v2: Return empty rather than entire worktree. The contextPack builder
    // should populate scope from retrieval lanes, not default to "everything."
    // Callers that need a root fallback should handle the empty case explicitly.
    return [];
  }
  return [...allowlist.files];
}

function normalizeFilePath(root: string, filePath: string): string | null {
  if (!filePath || filePath.trim().length === 0) {
    return null;
  }
  try {
    return normalizeSafePath(root, filePath);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
