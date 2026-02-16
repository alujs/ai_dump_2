import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const mcpRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(mcpRoot, "..", "..");

async function main() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/stdioServer.ts"], {
    cwd: mcpRoot,
    env: {
      ...process.env,
      MCP_REPO_ROOT: process.env.MCP_REPO_ROOT ?? repoRoot
    },
    stdio: "inherit"
  });

  child.on("error", (error) => {
    process.stderr.write(`Failed to launch MCP stdio server: ${error.message}\n`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
