/**
 * Minimal diagnostic — tests file-collection, inline template extraction,
 * and directive/nav/usage parsing. No ts-morph overhead.
 */
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadGatewayConfig } from "../../config/loadConfig.js";
import { resolveTargetRepoRoot } from "../../shared/fsPaths.js";
import {
  parseAngularTemplateUsage,
  parseAngularTemplateNav,
  parseAngularTemplateDirectives,
  extractInlineTemplates,
} from "./astTooling.js";
import { isLikelyRouteFile } from "./routeParser.js";

const HARD_EXCLUDED = new Set([
  "node_modules", "dist", ".angular", ".git", ".next", ".cache", "coverage", "build", "tmp",
]);
const ALLOWED_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html", ".json", ".yaml", ".yml"];

async function collectFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const segments = full.replace(/\\/g, "/").split("/");
      if (segments.some((s) => HARD_EXCLUDED.has(s))) continue;
      if (entry.isDirectory()) { queue.push(full); }
      else if (entry.isFile() && ALLOWED_EXTS.some((ext) => full.toLowerCase().endsWith(ext))) {
        output.push(full);
      }
    }
  }
  return output.sort();
}

async function main() {
  const targetRoot = resolveTargetRepoRoot();
  console.log("targetRoot:", targetRoot);
  const srcDir = path.join(targetRoot, "src");
  const files = await collectFiles(srcDir);
  const tsFiles = files.filter((f) => f.endsWith(".ts"));
  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  console.log(`Collected ${files.length} files (.ts: ${tsFiles.length}, .html: ${htmlFiles.length})\n`);

  let totalDirectives = 0;
  let totalUsages = 0;
  let totalRouterLinks = 0;

  // Process HTML files
  for (const htmlFile of htmlFiles) {
    const content = await readFile(htmlFile, "utf8");
    const rel = path.relative(targetRoot, htmlFile);
    const directives = parseAngularTemplateDirectives(content, htmlFile);
    const usages = parseAngularTemplateUsage(content, htmlFile);
    const nav = parseAngularTemplateNav(content, htmlFile);
    totalDirectives += directives.usages.length;
    totalUsages += usages.length;
    totalRouterLinks += nav.routerLinks.length;
    if (directives.usages.length > 0 || usages.length > 0 || nav.routerLinks.length > 0) {
      console.log(`[HTML] ${rel}: directives=${directives.usages.length} usages=${usages.length} links=${nav.routerLinks.length}`);
    }
  }

  // Process inline templates from .ts files
  for (const tsFile of tsFiles) {
    const content = await readFile(tsFile, "utf8");
    const rel = path.relative(targetRoot, tsFile);
    const inlineTemplates = extractInlineTemplates(content);
    for (const tpl of inlineTemplates) {
      const directives = parseAngularTemplateDirectives(tpl, tsFile);
      const usages = parseAngularTemplateUsage(tpl, tsFile);
      const nav = parseAngularTemplateNav(tpl, tsFile);
      totalDirectives += directives.usages.length;
      totalUsages += usages.length;
      totalRouterLinks += nav.routerLinks.length;
      if (directives.usages.length > 0 || usages.length > 0 || nav.routerLinks.length > 0) {
        console.log(`[TS inline] ${rel}: directives=${directives.usages.length} usages=${usages.length} links=${nav.routerLinks.length}`);
        for (const d of directives.usages) {
          console.log(`  -> directive: ${d.directiveName} structural=${d.isStructural} expr=${d.boundExpression} host=${d.hostTag}`);
        }
        for (const u of usages) {
          console.log(`  -> usage: <${u.tag}> attrs=[${u.attributes.join(",")}]`);
        }
        for (const l of nav.routerLinks) {
          console.log(`  -> routerLink: ${l.routePath} host=${l.hostTag}`);
        }
      }
    }
  }

  console.log(`\n=== Totals ===`);
  console.log(`  Directive usages: ${totalDirectives}`);
  console.log(`  Component usages: ${totalUsages}`);
  console.log(`  RouterLink refs:  ${totalRouterLinks}`);

  // Route files
  console.log("\n=== Route files ===");
  for (const tsFile of tsFiles) {
    const content = await readFile(tsFile, "utf8");
    const rel = path.relative(targetRoot, tsFile);
    if (isLikelyRouteFile(tsFile, content)) {
      const guardMatches = content.match(/canMatch|canActivate|canDeactivate|canLoad/g);
      console.log(`  ${rel}${guardMatches ? ` guards=[${guardMatches.join(",")}]` : ""}`);
    }
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
