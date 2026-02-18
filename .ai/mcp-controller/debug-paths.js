const path = require("path");
const { existsSync, readdirSync } = require("fs");

// Reproduce resolveRepoRoot
const cwd = process.cwd();
const parent = path.dirname(cwd);
const grandParent = path.dirname(parent);
const repoRoot = grandParent;
const envTarget = process.env.MCP_TARGET_REPO_ROOT || "(not set)";
const targetRoot = path.resolve(repoRoot, process.env.MCP_TARGET_REPO_ROOT || ".");
console.log("cwd:", cwd);
console.log("repoRoot:", repoRoot);
console.log("MCP_TARGET_REPO_ROOT:", envTarget);
console.log("targetRoot:", targetRoot);
console.log("targetRoot exists:", existsSync(targetRoot));
console.log("targetRoot/src exists:", existsSync(path.join(targetRoot, "src")));

function countFiles(dir, ext, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 6) return 0;
  var count = 0;
  try {
    var entries = readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var ent = entries[i];
      var full = path.join(dir, ent.name);
      if (ent.isDirectory() && ent.name !== "node_modules" && ent.name !== ".angular") {
        count += countFiles(full, ext, depth + 1);
      } else if (ent.name.endsWith(ext)) {
        count++;
      }
    }
  } catch (e) { /* skip */ }
  return count;
}

var srcDir = path.join(targetRoot, "src");
console.log(".html in src/:", countFiles(srcDir, ".html"));
console.log(".ts in src/:", countFiles(srcDir, ".ts"));

// Also check what the config says
try {
  var configPath = path.join(repoRoot, ".ai", "config", "base.json");
  console.log("config path:", configPath, "exists:", existsSync(configPath));
} catch (e) {
  console.log("config error:", e.message);
}
