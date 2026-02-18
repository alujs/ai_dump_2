import path from "node:path";
import { loadGatewayConfig } from "../../config/loadConfig";
import { GraphOpsService } from "./graphOpsService";
import { resolveRepoRoot, resolveTargetRepoRoot } from "../../shared/fsPaths";
import { generateFactSeedFiles } from "./seedFactsFromIndex";
import { IndexingService } from "../indexing/indexingService";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "sync";
  const config = await loadGatewayConfig();
  const repoRoot = resolveRepoRoot();
  const service = new GraphOpsService({
    seedRoot: path.join(repoRoot, config.graph.seedRoot),
    outRoot: path.join(repoRoot, config.graph.outRoot),
    cypherRoot: path.join(repoRoot, config.graph.cypherRoot),
    neo4j: config.neo4j
  });

  if (command === "sync") {
    const result = await service.sync();
    process.stdout.write(
      `graphops sync complete. appliedCypherStatements=${result.appliedCypherStatements} seededRows=${result.seededRows}\n`
    );
    return;
  }

  if (command === "check") {
    await service.checkConnectivity();
    process.stdout.write("graphops connectivity check passed.\n");
    return;
  }

  if (command === "export") {
    const result = await service.exportSnapshot(process.argv[3] ?? "delta");
    process.stdout.write(
      `graphops export complete. nodeCount=${result.nodeCount} relationshipCount=${result.relationshipCount} files=${result.files.join(",")}\n`
    );
    return;
  }

  if (command === "seed-facts") {
    process.stdout.write("graphops seed-facts: rebuilding AST index...\n");
    const targetRoot = resolveTargetRepoRoot();
    const indexing = new IndexingService(config);
    await indexing.rebuild(targetRoot);

    const symbols = indexing.getSymbolHeaders(2000);
    const usageFacts = indexing.getTemplateUsageFacts(5000);
    const routes = indexing.getParsedRoutes();
    const routerLinks = indexing.getTemplateRouterLinks(2000);
    const routerOutletFiles = indexing.getRouterOutletFiles();
    const seedRoot = path.join(repoRoot, config.graph.seedRoot);

    process.stdout.write(
      `graphops seed-facts: extracted ${symbols.length} symbols, ${usageFacts.length} template usage facts, ` +
      `${routes.length} routes, ${routerLinks.length} routerLinks, ${routerOutletFiles.length} router-outlet files\n`
    );

    const result = await generateFactSeedFiles(targetRoot, seedRoot, symbols, usageFacts, routes, routerLinks, routerOutletFiles);
    process.stdout.write(
      `graphops seed-facts complete. anchors=${result.anchorCount} symbols=${result.symbolCount} ` +
      `components=${result.componentCount} usageExamples=${result.usageExampleCount} ` +
      `routes=${result.routeCount} edges=${result.edgeCount}\n`
    );
    process.stdout.write(`  files written: ${result.files.join(", ")}\n`);

    const doSync = process.argv.includes("--sync");
    if (doSync) {
      process.stdout.write("graphops seed-facts: running sync to load into Neo4j...\n");
      const syncResult = await service.sync();
      process.stdout.write(
        `graphops sync complete. appliedCypherStatements=${syncResult.appliedCypherStatements} seededRows=${syncResult.seededRows}\n`
      );
    } else {
      process.stdout.write("graphops seed-facts: JSONL written. Run with --sync to also load into Neo4j.\n");
    }
    return;
  }

  process.stdout.write("usage: tsx src/domains/graph-ops/cli.ts <check|sync|export|seed-facts> [--sync]\n");
}

main().catch((error) => {
  process.stderr.write(`graphops failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
