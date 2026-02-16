import path from "node:path";
import { readText } from "../../shared/fileStore";
import { resolveTargetRepoRoot } from "../../shared/fsPaths";
import { replaceWithGuard } from "../../shared/replaceGuard";

export async function repoSnapshotId(repoRoot = resolveTargetRepoRoot()): Promise<string> {
  try {
    const headRef = (await readText(path.join(repoRoot, ".git", "HEAD"))).trim();
    if (headRef.startsWith("ref:")) {
      const refPath = replaceWithGuard(headRef, "ref:", "", "repoSnapshotId:head-ref-strip").trim();
      const sha = (await readText(path.join(repoRoot, ".git", refPath))).trim();
      if (sha) {
        return `git:${sha}`;
      }
    }
    if (headRef) {
      return `git:${headRef}`;
    }
  } catch {
    // Fall through to fs timestamp fallback.
  }
  return `fs:${Date.now().toString(36)}`;
}
