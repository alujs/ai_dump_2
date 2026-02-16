import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const aiRoot = path.join(repoRoot, ".ai");
const mcpRoot = path.join(aiRoot, "mcp-controller");
const testAppRoot = path.join(repoRoot, "test-app");
const starterRepo = process.env.E2E_TEST_APP_REPO ?? "https://github.com/nartc/ng-conduit.git";
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

async function main() {
  if (!(await exists(path.join(mcpRoot, "package.json")))) {
    throw new Error("Missing .ai/mcp-controller/package.json.");
  }

  await ensureTestApp();
  await rm(path.join(testAppRoot, ".ai"), { recursive: true, force: true });
  const sourceSeedDigestBefore = await digestDirectory(path.join(aiRoot, "graph", "seed"));

  const baseEnv = {
    ...process.env,
    MCP_TARGET_REPO_ROOT: testAppRoot
  };

  await run(npmCmd, ["--prefix", mcpRoot, "install"], repoRoot, baseEnv);
  await run(npmCmd, ["--prefix", mcpRoot, "run", "e2e:smoke"], repoRoot, baseEnv);
  await run(npmCmd, ["--prefix", mcpRoot, "run", "e2e:mcp-smoke"], repoRoot, baseEnv);
  await run(npmCmd, ["--prefix", mcpRoot, "run", "e2e:mcp-stdio-smoke"], repoRoot, baseEnv);

  const sourceSeedDigestAfter = await digestDirectory(path.join(aiRoot, "graph", "seed"));
  if (sourceSeedDigestBefore !== sourceSeedDigestAfter) {
    throw new Error("Source .ai/graph/seed changed during e2e run.");
  }

  const testAppChanges = await changedPaths(testAppRoot);
  if (testAppChanges.length > 0) {
    throw new Error(`test-app changed unexpectedly: ${testAppChanges.join(", ")}`);
  }

  console.log("E2E validation completed.");
  console.log("Layout: root .ai + sibling test-app + e2e harness.");
  console.log("Seed guard: .ai/graph/seed digest unchanged.");
}

async function ensureTestApp() {
  if (await exists(path.join(testAppRoot, ".git"))) {
    return;
  }
  await run("git", ["clone", "--depth", "1", starterRepo, testAppRoot], repoRoot, process.env);
}

async function changedPaths(repoPath) {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "status", "--porcelain"], {
    cwd: repoRoot
  });
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim())
    .map((target) => {
      if (!target.includes(" -> ")) {
        return target;
      }
      const parts = target.split(" -> ");
      return parts[parts.length - 1].trim();
    });
}

async function digestDirectory(root) {
  const files = await listFiles(root);
  const lines = [];
  for (const filePath of files.sort((a, b) => a.localeCompare(b))) {
    const bytes = await readFile(filePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    lines.push(`${normalize(path.relative(root, filePath))}:${hash}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolute)));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function run(command, args, cwd, env) {
  await execFileAsync(command, args, {
    cwd,
    env
  });
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function normalize(value) {
  return value.split(path.sep).join("/");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
