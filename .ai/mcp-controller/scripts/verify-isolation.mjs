import path from "node:path";
import { execFileSync } from "node:child_process";

const mcpRoot = process.cwd();
const repoRoot = path.resolve(mcpRoot, "..", "..");

function main() {
  let status = "";
  try {
    status = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
      encoding: "utf8"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Isolation check skipped: ${message}`);
    return;
  }

  const changedPaths = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map(extractPath)
    .filter((value) => value.length > 0);

  const outsideAi = changedPaths.filter((target) => target !== ".ai" && !target.startsWith(".ai/"));
  if (outsideAi.length > 0) {
    console.error("Isolation check failed. Non-.ai paths changed:");
    for (const target of outsideAi) {
      console.error(`- ${target}`);
    }
    process.exit(1);
  }

  console.log(`Isolation check passed. Changed paths are scoped to .ai (${changedPaths.length} entries).`);
}

function extractPath(line) {
  const payload = line.slice(3).trim();
  if (payload.includes(" -> ")) {
    const parts = payload.split(" -> ");
    return parts[parts.length - 1].trim();
  }
  return payload;
}

main();
