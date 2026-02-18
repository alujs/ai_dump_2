/**
 * Gitignore-aware file filtering for the indexer and other tree-walking code.
 *
 * Reads `.gitignore` from a given root directory (and optionally walks up
 * to parent directories to pick up cascading gitignore rules), then exposes
 * a simple predicate: `isIgnored(relativePath) → boolean`.
 *
 * Zero external dependencies — implements the subset of gitignore spec that
 * matters (comments, blank lines, negation, directory-only markers, leading/
 * trailing slashes, `*`, `**`, `?`, character classes `[abc]`).
 *
 * Additionally applies a set of ALWAYS_EXCLUDED segments as a safety net so
 * that `node_modules`, `dist`, `.angular`, etc. are blocked even if the
 * target repo's `.gitignore` is missing or incomplete.
 */

import path from "node:path";
import { readFileSync, existsSync } from "node:fs";

/* ── Safety-net segments (always excluded regardless of .gitignore) ── */

const ALWAYS_EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".angular",
  ".git",
  ".next",
  ".cache",
  "coverage",
  "build",
  "tmp",
  ".tmp",
  ".ai",
  "__pycache__",
  ".nyc_output",
  ".parcel-cache",
  ".turbo",
  ".output",
  ".nuxt",
  ".svelte-kit",
  "out-tsc",
  "bazel-out",
]);

/* ── Gitignore pattern → RegExp compiler ─────────────────── */

interface GitignoreRule {
  regex: RegExp;
  negated: boolean;
  directoryOnly: boolean;
}

/**
 * Parse a single gitignore pattern into a RegExp rule.
 * Returns null for blank lines and comments.
 */
function parseGitignoreLine(raw: string): GitignoreRule | null {
  let line = raw;

  // Strip trailing whitespace (unless escaped with backslash)
  line = line.replace(/(?<!\\)\s+$/, "");

  // Skip blanks and comments
  if (!line || line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }

  // Strip leading backslash escapes (e.g. `\#foo` → `#foo`)
  if (line.startsWith("\\")) {
    line = line.slice(1);
  }

  // Directory-only flag: trailing slash
  let directoryOnly = false;
  if (line.endsWith("/")) {
    directoryOnly = true;
    line = line.slice(0, -1);
  }

  // Strip leading slash — makes pattern anchored to root
  const anchored = line.includes("/"); // contains a slash → anchored
  line = line.replace(/^\//, "");

  // Convert gitignore glob to regex
  const regexStr = gitignoreGlobToRegex(line, anchored);
  return { regex: new RegExp(regexStr), negated, directoryOnly };
}

/**
 * Convert a gitignore glob pattern to a regex string.
 * Handles `*`, `**`, `?`, and `[...]` character classes.
 */
function gitignoreGlobToRegex(pattern: string, anchored: boolean): string {
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — match across directory boundaries
        if (pattern[i + 2] === "/") {
          // `**/` — zero or more directories
          result += "(?:.+/)?";
          i += 3;
        } else {
          // `**` at end — match everything
          result += ".*";
          i += 2;
        }
      } else {
        // Single `*` — match within one path segment (no slashes)
        result += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      result += "[^/]";
      i++;
    } else if (ch === "[") {
      // Character class — pass through to regex (already valid)
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        result += escapeRegex(ch);
        i++;
      } else {
        result += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else {
      result += escapeRegex(ch);
      i++;
    }
  }

  // If the pattern has no slash (unanchored), it can match at any depth
  if (anchored) {
    return "^" + result + "(?:/.*)?$";
  } else {
    return "(?:^|/)" + result + "(?:/.*)?$";
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|\\]/g, "\\$&");
}

/**
 * Parse a `.gitignore` file content into an ordered list of rules.
 */
function parseGitignoreContent(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const rule = parseGitignoreLine(rawLine);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Test a repo-relative path against a list of gitignore rules.
 * Last matching rule wins (standard gitignore precedence).
 */
function matchesRules(relativePath: string, rules: GitignoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(relativePath)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

/* ── Public API ──────────────────────────────────────────── */

export interface GitignoreFilter {
  /**
   * Returns true if the given **repo-root-relative** path is ignored
   * (either by .gitignore rules or the always-excluded safety net).
   * Paths should use forward slashes.
   */
  isIgnored(relativePath: string): boolean;

  /**
   * Returns true if a path segment (single directory/file name) is in
   * the always-excluded set. Useful for short-circuiting during BFS
   * without computing the full relative path.
   */
  isHardExcludedSegment(segment: string): boolean;
}

/**
 * Build a gitignore-aware filter for the given repo root.
 *
 * Reads `.gitignore` at `repoRoot/.gitignore`. If you also want ancestor
 * gitignore files (e.g. the monorepo root's `.gitignore`), pass their
 * paths in `extraGitignorePaths`.
 */
export function loadGitignoreFilter(
  repoRoot: string,
  extraGitignorePaths: string[] = [],
): GitignoreFilter {
  const allRules: GitignoreRule[] = [];

  // 1. Load the repo's own .gitignore
  const repoGitignore = path.join(repoRoot, ".gitignore");
  if (existsSync(repoGitignore)) {
    try {
      const content = readFileSync(repoGitignore, "utf8");
      allRules.push(...parseGitignoreContent(content));
    } catch {
      // Ignore read errors — safety net still active
    }
  }

  // 2. Load any extra gitignore files (e.g. from parent monorepo root)
  for (const extra of extraGitignorePaths) {
    if (existsSync(extra)) {
      try {
        const content = readFileSync(extra, "utf8");
        allRules.push(...parseGitignoreContent(content));
      } catch {
        // Continue
      }
    }
  }

  return {
    isIgnored(relativePath: string): boolean {
      // Normalize to forward slashes and strip leading slash
      const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
      if (!normalized) return false;

      // Fast path: check if any segment is in the always-excluded set
      const segments = normalized.split("/");
      if (segments.some((s) => ALWAYS_EXCLUDED_SEGMENTS.has(s.toLowerCase()))) {
        return true;
      }

      // Full gitignore check
      return matchesRules(normalized, allRules);
    },

    isHardExcludedSegment(segment: string): boolean {
      return ALWAYS_EXCLUDED_SEGMENTS.has(segment.toLowerCase());
    },
  };
}

/**
 * Build a filter for a target repo that also considers the workspace root
 * .gitignore (for monorepo setups where the target is a subdirectory).
 */
export function loadGitignoreFilterWithAncestors(
  repoRoot: string,
  workspaceRoot?: string,
): GitignoreFilter {
  const extras: string[] = [];
  if (workspaceRoot && workspaceRoot !== repoRoot) {
    extras.push(path.join(workspaceRoot, ".gitignore"));
  }
  return loadGitignoreFilter(repoRoot, extras);
}
