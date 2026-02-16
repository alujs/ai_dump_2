import path from "node:path";
import { loadGatewayConfig } from "../../config/loadConfig";
import { GraphOpsService } from "./graphOpsService";
import { resolveRepoRoot } from "../../shared/fsPaths";

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

  process.stdout.write("usage: tsx src/domains/graph-ops/cli.ts <check|sync|export> [tag]\n");
}

main().catch((error) => {
  process.stderr.write(`graphops failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
