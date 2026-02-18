import { loadGatewayConfig } from "../../config/loadConfig.js";
import { IndexingService } from "./indexingService.js";
import { resolveTargetRepoRoot } from "../../shared/fsPaths.js";

async function main() {
  console.log("=== Debug indexer ===");
  const targetRoot = resolveTargetRepoRoot();
  console.log("targetRoot:", targetRoot);

  const config = await loadGatewayConfig();
  console.log("config.hints.angularRoots:", config.hints.angularRoots);
  console.log("config.ingestion.includes:", config.ingestion.includes);
  console.log("config.ingestion.excludes:", config.ingestion.excludes);

  const indexing = new IndexingService(config);
  await indexing.rebuild(targetRoot);

  const symbols = indexing.getSymbolHeaders(2000);
  const usageFacts = indexing.getTemplateUsageFacts(5000);
  const routes = indexing.getParsedRoutes();
  const directiveUsages = indexing.getDirectiveUsages();
  const resolvedGuards = indexing.getResolvedGuards();
  const resolvedDirectives = indexing.getResolvedDirectives();
  const failures = indexing.getFailures();

  console.log("\n=== Results ===");
  console.log("symbols:", symbols.length);
  console.log("usageFacts:", usageFacts.length);
  console.log("routes:", routes.length);
  console.log("directiveUsages:", directiveUsages.length);
  console.log("resolvedGuards:", resolvedGuards.length);
  console.log("resolvedDirectives:", resolvedDirectives.length);
  console.log("failures:", failures.length);

  if (failures.length > 0) {
    console.log("\n=== Failures (first 10) ===");
    for (const f of failures.slice(0, 10)) {
      console.log(`  ${f.filePath}: ${f.reason}`);
    }
  }

  if (directiveUsages.length > 0) {
    console.log("\n=== Directive Usages ===");
    for (const d of directiveUsages) {
      console.log(`  ${d.directiveName} in ${d.filePath}:${d.line} [structural=${d.isStructural}] expr=${d.boundExpression}`);
    }
  }

  if (resolvedGuards.length > 0) {
    console.log("\n=== Resolved Guards ===");
    for (const g of resolvedGuards) {
      console.log(`  ${g.name}: defFile=${g.definitionFile}, kind=${g.kind}`);
      console.log(`    imports: ${g.importedFiles.join(", ")}`);
      console.log(`    symbols: ${g.importedSymbols.join(", ")}`);
    }
  }

  if (resolvedDirectives.length > 0) {
    console.log("\n=== Resolved Directives ===");
    for (const d of resolvedDirectives) {
      console.log(`  ${d.directiveName} (${d.className}): defFile=${d.definitionFile}, kind=${d.kind}`);
      console.log(`    imports: ${d.importedFiles.join(", ")}`);
      console.log(`    symbols: ${d.importedSymbols.join(", ")}`);
      console.log(`    usedIn: ${d.usedInTemplates.join(", ")}`);
    }
  }

  // Show some sample symbols
  if (symbols.length > 0) {
    console.log("\n=== Sample symbols (first 20) ===");
    for (const s of symbols.slice(0, 20)) {
      console.log(`  ${s.kind} ${s.symbol} -> ${s.filePath}`);
    }
  }

  // Show routes
  if (routes.length > 0) {
    console.log("\n=== Routes ===");
    for (const r of routes) {
      console.log(`  ${r.fullPath} guards=[${r.guards.join(",")}]`);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
