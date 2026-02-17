import type { GatewayConfig } from "../config/types";
import { loadGatewayConfig } from "../config/loadConfig";
import { ConnectorRegistry } from "../domains/connectors/connectorRegistry";
import { TurnController } from "../domains/controller/turnController";
import { startHttpServer } from "../domains/dashboard/httpServer";
import { IndexingService } from "../domains/indexing/indexingService";
import { EventStore } from "../domains/observability/eventStore";

export interface RuntimeBootstrapOptions {
  startDashboard?: boolean;
  dashboardPort?: number;
}

export interface RuntimeHandle {
  config: GatewayConfig;
  events: EventStore;
  connectors: ConnectorRegistry;
  indexing: IndexingService;
  controller: TurnController;
}

export async function bootstrapRuntime(options: RuntimeBootstrapOptions = {}): Promise<RuntimeHandle> {
  const config = await loadGatewayConfig();
  const events = new EventStore();
  const connectors = new ConnectorRegistry(config);
  const indexing = new IndexingService(config);
  await indexing.rebuild();

  for (const failure of indexing.getFailures(200)) {
    await events.append({
      ts: new Date().toISOString(),
      type: "indexing_failure",
      runSessionId: "startup",
      workId: "startup",
      agentId: "system",
      payload: { ...failure }
    });
  }

  const controller = new TurnController(
    events,
    connectors,
    indexing,
    undefined, // memoryPromotion — use default
    undefined, // recipes — use default
    config.neo4j, // pass Neo4j config for proof chain builder [REF:PROOF-CHAINS]
  );
  if (options.startDashboard ?? false) {
    await startHttpServer({
      controller,
      events,
      port: options.dashboardPort ?? config.dashboardPort
    });
  }

  return {
    config,
    events,
    connectors,
    indexing,
    controller
  };
}
