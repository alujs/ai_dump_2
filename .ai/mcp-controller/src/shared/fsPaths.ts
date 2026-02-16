import path from "node:path";
import { existsSync } from "node:fs";

export function resolveRepoRoot(): string {
  const explicit = process.env.MCP_REPO_ROOT;
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(process.cwd(), explicit);
  }

  const cwd = process.cwd();
  if (existsSync(path.join(cwd, ".ai", "config", "base.json"))) {
    return cwd;
  }

  const parent = path.dirname(cwd);
  const grandParent = path.dirname(parent);
  if (path.basename(cwd) === "mcp-controller" && path.basename(parent) === ".ai") {
    return grandParent;
  }
  if (path.basename(cwd) === ".ai" && existsSync(path.join(cwd, "config", "base.json"))) {
    return parent;
  }

  return process.cwd();
}

export function resolveTargetRepoRoot(): string {
  const explicit = process.env.MCP_TARGET_REPO_ROOT;
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(resolveRepoRoot(), explicit);
  }
  return resolveRepoRoot();
}

export function workRoot(workId: string): string {
  return path.join(resolveRepoRoot(), ".ai", "tmp", "work", workId);
}

export function scratchRoot(workId: string): string {
  return path.join(workRoot(workId), "scratch");
}

export function contextRoot(runSessionId: string, workId: string): string {
  return path.join(resolveRepoRoot(), ".ai", "tmp", "context", runSessionId, workId);
}

export function observabilityRoot(): string {
  return path.join(resolveRepoRoot(), ".ai", "tmp", "observability");
}

export function normalizeSafePath(root: string, relativeTarget: string): string {
  const resolved = path.resolve(root, relativeTarget);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error("PATH_SCOPE_VIOLATION");
  }
  return resolved;
}
