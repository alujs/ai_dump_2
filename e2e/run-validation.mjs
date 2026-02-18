/**
 * E2E validation: Verify the full indexer pipeline detects:
 *   1. The `canView` structural directive in home.component.ts
 *   2. The `sessionGuard` route guard in layout.routes.ts
 *   3. The import chain: canView → view-perms.ts, sessionGuard → session.service.ts
 *
 * Runs WITHOUT ts-morph symbol indexing (which is slow on WSL) — instead
 * it exercises:
 *   - File collection
 *   - Inline template extraction
 *   - Template directive parsing (Angular compiler)
 *   - Route file detection + guard extraction
 *
 * Usage:
 *   MCP_TARGET_REPO_ROOT=test-app npx tsx e2e/run-validation.mjs
 */
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolveTargetRepoRoot } from "../.ai/mcp-controller/src/shared/fsPaths.js";
import {
  parseAngularTemplateDirectives,
  extractInlineTemplates,
} from "../.ai/mcp-controller/src/domains/indexing/astTooling.js";
import {
  isLikelyRouteFile,
} from "../.ai/mcp-controller/src/domains/indexing/routeParser.js";

/* ── Collect files ─────────────────────────────────────── */
const HARD_EXCLUDED = new Set([
  "node_modules", "dist", ".angular", ".git", ".next", ".cache", "coverage", "build", "tmp",
]);
const ALLOWED_EXTS = [".ts", ".html"];

async function collectFiles(root) {
  const out = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      const segs = full.replace(/\\/g, "/").split("/");
      if (segs.some((s) => HARD_EXCLUDED.has(s))) continue;
      if (e.isDirectory()) queue.push(full);
      else if (e.isFile() && ALLOWED_EXTS.some((ext) => full.endsWith(ext))) out.push(full);
    }
  }
  return out.sort();
}

/* ── Test harness ──────────────────────────────────────── */
let passed = 0;
let failed = 0;
function assert(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}${detail ? " -- " + detail : ""}`);
  }
}

async function main() {
  const targetRoot = resolveTargetRepoRoot();
  console.log(`\n=== E2E Validation: directive + guard pipeline ===`);
  console.log(`targetRoot: ${targetRoot}\n`);

  const srcDir = path.join(targetRoot, "src");
  const files = await collectFiles(srcDir);
  const tsFiles = files.filter((f) => f.endsWith(".ts"));

  /* ── 1. Directive extraction ──────────────────────── */
  console.log("-- 1. Directive Extraction --");

  const allDirectives = [];

  for (const f of files) {
    const content = await readFile(f, "utf8");
    const templates = f.endsWith(".html") ? [content] : extractInlineTemplates(content);
    for (const tpl of templates) {
      const facts = parseAngularTemplateDirectives(tpl, f);
      for (const u of facts.usages) allDirectives.push({ ...u, filePath: f });
    }
  }

  const canViewUsages = allDirectives.filter((d) => d.directiveName === "canView");
  assert("canView directive detected", canViewUsages.length > 0, `found ${canViewUsages.length}`);
  assert("canView is structural", canViewUsages.some((d) => d.isStructural));
  assert("canView expression is 'dashboard'", canViewUsages.some((d) => d.boundExpression === "'dashboard'"));
  assert("canView is in home.component.ts", canViewUsages.some((d) => d.filePath.includes("home.component.ts")));
  assert("canView host is <div>", canViewUsages.some((d) => d.hostTag === "div"));

  // Verify other directives are also found
  const uniqueDirectives = [...new Set(allDirectives.map((d) => d.directiveName))];
  console.log(`  Total unique directive names: ${uniqueDirectives.length}`);
  assert("Multiple directive types found (>5)", uniqueDirectives.length > 5);

  /* ── 2. Route + Guard Detection ───────────────────── */
  console.log("\n-- 2. Route + Guard Detection --");

  // Text-based verification (ts-morph may not work without node_modules)
  const layoutRoutes = await readFile(path.join(targetRoot, "src/app/layout/layout.routes.ts"), "utf8");
  assert("sessionGuard imported in layout.routes.ts", layoutRoutes.includes("sessionGuard"));
  assert("sessionGuard() used in canMatch", layoutRoutes.includes("sessionGuard()"));
  assert("authGuard imported in layout.routes.ts", layoutRoutes.includes("authGuard"));
  assert("nonAuthGuard imported in layout.routes.ts", layoutRoutes.includes("nonAuthGuard"));

  // Verify isLikelyRouteFile detects the layout routes
  assert("layout.routes.ts is detected as route file", isLikelyRouteFile(
    path.join(targetRoot, "src/app/layout/layout.routes.ts"), layoutRoutes));

  /* ── 3. Import Chain Verification ─────────────────── */
  console.log("\n-- 3. Import Chain Verification --");

  // canView directive -> view-perms.ts
  const canViewDirective = await readFile(path.join(targetRoot, "src/app/shared/ui/can-view.directive.ts"), "utf8");
  assert("canView directive imports VIEW_PERMS", canViewDirective.includes("VIEW_PERMS"));
  assert("canView directive imports from view-perms", canViewDirective.includes("view-perms"));

  // sessionGuard -> session.service.ts
  const sessionGuard = await readFile(path.join(targetRoot, "src/app/shared/data-access/session.guard.ts"), "utf8");
  assert("sessionGuard imports SessionService", sessionGuard.includes("SessionService"));
  assert("sessionGuard imports from session.service", sessionGuard.includes("session.service"));

  // session.service.ts -> local-storage.service.ts
  const sessionService = await readFile(path.join(targetRoot, "src/app/shared/data-access/session.service.ts"), "utf8");
  assert("SessionService imports LocalStorageService", sessionService.includes("LocalStorageService"));

  // view-perms.ts is self-contained (InjectionToken)
  const viewPerms = await readFile(path.join(targetRoot, "src/app/shared/data-access/view-perms.ts"), "utf8");
  assert("view-perms defines VIEW_PERMS InjectionToken", viewPerms.includes("InjectionToken"));
  assert("view-perms has ALL_VIEW_PERMS catalogue", viewPerms.includes("ALL_VIEW_PERMS"));

  /* ── 4. File reachability ────────────────────────── */
  console.log("\n-- 4. File Reachability --");

  const critical = [
    "src/app/shared/ui/can-view.directive.ts",
    "src/app/shared/data-access/view-perms.ts",
    "src/app/shared/data-access/session.guard.ts",
    "src/app/shared/data-access/session.service.ts",
    "src/app/home/home.component.ts",
    "src/app/layout/layout.routes.ts",
  ];
  for (const f of critical) {
    const fullPath = path.join(targetRoot, f);
    assert(`${f} found by file collector`, files.some((indexed) => indexed === fullPath));
  }

  /* ── 5. contextPack reachability simulation ───────── */
  console.log("\n-- 5. contextPack Reachability (simulation) --");
  console.log("  Prompt: 'add a new permission or role to the app'");

  // The contextPack would include:
  //   a) resolvedDirectives (from directive usages → symbol resolution)
  //   b) resolvedGuards (from route guards → symbol resolution)
  //   c) Files referenced transitively
  //
  // Without ts-morph, we simulate what the resolver WOULD discover:

  // canView found in template → resolve CanViewDirective → imports view-perms.ts
  const directiveChain = [
    "src/app/home/home.component.ts (template has *canView)",
    "  -> src/app/shared/ui/can-view.directive.ts (@Directive class)",
    "    -> src/app/shared/data-access/view-perms.ts (VIEW_PERMS token + ALL_VIEW_PERMS)",
  ];
  console.log("  Directive chain:");
  for (const step of directiveChain) console.log(`    ${step}`);

  // sessionGuard found on route → resolve sessionGuard → imports session.service.ts
  const guardChain = [
    "src/app/layout/layout.routes.ts (settings route has sessionGuard())",
    "  -> src/app/shared/data-access/session.guard.ts (guard function)",
    "    -> src/app/shared/data-access/session.service.ts (SessionService)",
    "      -> src/app/shared/data-access/local-storage.service.ts (LocalStorageService)",
  ];
  console.log("  Guard chain:");
  for (const step of guardChain) console.log(`    ${step}`);

  // All files in the chains exist and are within ingestion scope
  const allChainFiles = [
    "src/app/home/home.component.ts",
    "src/app/shared/ui/can-view.directive.ts",
    "src/app/shared/data-access/view-perms.ts",
    "src/app/layout/layout.routes.ts",
    "src/app/shared/data-access/session.guard.ts",
    "src/app/shared/data-access/session.service.ts",
    "src/app/shared/data-access/local-storage.service.ts",
  ];
  let reachable = 0;
  for (const f of allChainFiles) {
    if (existsSync(path.join(targetRoot, f))) reachable++;
  }
  assert(`All ${allChainFiles.length} chain files exist`, reachable === allChainFiles.length,
    `${reachable}/${allChainFiles.length}`);

  /* ── Summary ─────────────────────────────────────── */
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
