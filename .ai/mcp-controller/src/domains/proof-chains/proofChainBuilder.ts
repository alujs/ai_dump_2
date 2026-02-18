/**
 * Proof Chain Builder — traverses Neo4j graph to construct:
 *   1. ag-Grid UI origin chain [REF:CHAIN-AGGRID]
 *      Table → ColumnDef → CellRenderer → NavTrigger → Route → Component → Service → DTO
 *   2. Federation proof chain [REF:CHAIN-FEDERATION]
 *      Host Route → Federation Mapping → Remote Expose → Remote Route → Destination Component
 *
 * Falls back to AST-based heuristics from the IndexingService when graph data
 * is sparse. Chains are partial rather than fabricated — missing links are
 * reported so the caller can escalate. [REF:ESCALATE-NO-GUESS]
 */

import { Neo4jClient, type Neo4jConnectionConfig } from "../../infrastructure/neo4j/client";
import type { IndexingService } from "../indexing/indexingService";
import type { GraphPolicyNode, MigrationRuleNode } from "../plan-graph/enforcementBundle";

/* ── Public types ─────────────────────────────────────────── */

export interface ChainLink {
  /** Node kind (e.g. "agGridTable", "ColumnDef", "CellRenderer") */
  kind: string;
  /** Stable node ID from graph (or synth ID from AST fallback) */
  id: string;
  /** Human-readable label */
  label: string;
  /** Source file, if known */
  filePath?: string;
  /** Symbol name, if known */
  symbol?: string;
  /** How this link was resolved */
  source: "graph" | "ast_fallback" | "lexical_fallback";
}

export interface ProofChainResult {
  /** The ordered chain links */
  chain: ChainLink[];
  /** Whether the chain is complete end-to-end */
  complete: boolean;
  /** Missing link kinds (gaps in the chain) */
  missingLinks: string[];
  /** Diagnostic notes */
  notes: string[];
}

export interface ProofChainBuilderConfig {
  neo4j: Neo4jConnectionConfig;
}

/* ── ag-Grid chain spec (the expected node kinds in order) ── */

const AGGRID_CHAIN_KINDS = [
  "agGridTable",
  "ColumnDef",
  "CellRenderer",
  "NavTrigger",
  "Route",
  "Component",
  "Service",
  "Definition",
] as const;

/* ── Federation chain spec ───────────────────────────────── */

const FEDERATION_CHAIN_KINDS = [
  "HostRoute",
  "FederationMapping",
  "RemoteExpose",
  "RemoteRoute",
  "DestinationComponent",
] as const;

/* ── Main builder class ──────────────────────────────────── */

export class ProofChainBuilder {
  constructor(
    private readonly config: ProofChainBuilderConfig,
    private readonly indexing: IndexingService | null = null,
  ) {}

  /**
   * Build an ag-Grid origin chain starting from a seed.
   * Seed can be a table ID, a column field name, or a component symbol.
   * [REF:CHAIN-AGGRID]
   */
  async buildAgGridOriginChain(seed: string): Promise<ProofChainResult> {
    const notes: string[] = [];
    const chain: ChainLink[] = [];
    const missingLinks: string[] = [];

    let client: Neo4jClient | null = null;
    try {
      client = new Neo4jClient(this.config.neo4j);
      await client.verifyConnectivity();

      // 1. Find the ag-Grid table node
      const tables = await client.runRead<{ id: string; label: string; filePath: string }>(
        `MATCH (t:agGridTable)
         WHERE t.id CONTAINS $seed OR t.name CONTAINS $seed OR t.gridId CONTAINS $seed
         RETURN t.id AS id, coalesce(t.name, t.gridId, t.id) AS label, coalesce(t.filePath, '') AS filePath
         LIMIT 3`,
        { seed: seed.toLowerCase() },
      );

      if (tables.length > 0) {
        const t = tables[0];
        chain.push({ kind: "agGridTable", id: t.id, label: t.label, filePath: t.filePath || undefined, source: "graph" });
        notes.push(`Found agGridTable '${t.label}' via graph.`);
      } else {
        // AST fallback: look for gridOptions / columnDefs in indexed symbols
        const fallback = this.findSymbolFallback(seed, ["gridoptions", "columndefs", "ag-grid"]);
        if (fallback) {
          chain.push({ kind: "agGridTable", id: `ast:${fallback.symbol}`, label: fallback.symbol, filePath: fallback.filePath, source: "ast_fallback" });
          notes.push(`agGridTable resolved via AST fallback from symbol '${fallback.symbol}'.`);
        } else {
          missingLinks.push("agGridTable");
          notes.push(`agGridTable not found for seed '${seed}'.`);
        }
      }

      // 2. Traverse: Table → ColumnDef(s) → CellRenderer → NavTrigger → Route → Component → Service → Definition
      const lastGraphId = chain.length > 0 && chain[0].source === "graph" ? chain[0].id : null;

      if (lastGraphId) {
        // ColumnDefs
        const colDefs = await client.runRead<{ id: string; label: string; filePath: string }>(
          `MATCH (t:agGridTable {id: $tableId})-[:HAS_COLUMN]->(cd:ColumnDef)
           RETURN cd.id AS id, coalesce(cd.field, cd.headerName, cd.id) AS label, coalesce(cd.filePath, '') AS filePath
           LIMIT 10`,
          { tableId: lastGraphId },
        );
        if (colDefs.length > 0) {
          const cd = colDefs[0]; // take first for chain; all are logged
          chain.push({ kind: "ColumnDef", id: cd.id, label: cd.label, filePath: cd.filePath || undefined, source: "graph" });
          notes.push(`Found ${colDefs.length} ColumnDef(s); using '${cd.label}'.`);

          // CellRenderer
          const renderers = await client.runRead<{ id: string; label: string; filePath: string }>(
            `MATCH (cd:ColumnDef {id: $cdId})-[:USES_RENDERER]->(cr:CellRenderer)
             RETURN cr.id AS id, coalesce(cr.name, cr.component, cr.id) AS label, coalesce(cr.filePath, '') AS filePath
             LIMIT 3`,
            { cdId: cd.id },
          );
          if (renderers.length > 0) {
            const cr = renderers[0];
            chain.push({ kind: "CellRenderer", id: cr.id, label: cr.label, filePath: cr.filePath || undefined, source: "graph" });

            // NavTrigger
            const triggers = await client.runRead<{ id: string; label: string; filePath: string; routePath: string }>(
              `MATCH (cr:CellRenderer {id: $crId})-[:TRIGGERS_NAV]->(nt:NavTrigger)
               RETURN nt.id AS id, coalesce(nt.action, nt.id) AS label, coalesce(nt.filePath, '') AS filePath, coalesce(nt.routePath, '') AS routePath
               LIMIT 3`,
              { crId: cr.id },
            );
            if (triggers.length > 0) {
              const nt = triggers[0];
              chain.push({ kind: "NavTrigger", id: nt.id, label: nt.label, filePath: nt.filePath || undefined, source: "graph" });

              // Route
              const routeSeed = nt.routePath || nt.label;
              await this.resolveRouteChain(client, chain, missingLinks, notes, routeSeed);
            } else {
              missingLinks.push("NavTrigger");
              notes.push(`No NavTrigger found from CellRenderer '${cr.label}'. Escalation recommended.`);
              // Try direct route from seed
              await this.resolveRouteChain(client, chain, missingLinks, notes, seed);
            }
          } else {
            missingLinks.push("CellRenderer");
            notes.push(`No CellRenderer found from ColumnDef '${cd.label}'.`);
          }
        } else {
          missingLinks.push("ColumnDef");
          notes.push(`No ColumnDefs found from agGridTable '${lastGraphId}'.`);
        }
      } else {
        // If we only have AST fallback for the table, try to resolve remaining via lexical search
        await this.resolveChainViaFallback(chain, missingLinks, notes, seed);
      }
    } catch (error) {
      notes.push(`Graph traversal error: ${error instanceof Error ? error.message : "unknown"}. Falling back to AST.`);
      await this.resolveChainViaFallback(chain, missingLinks, notes, seed);
    } finally {
      if (client) await client.close();
    }

    // Fill remaining expected kinds that are missing
    for (const kind of AGGRID_CHAIN_KINDS) {
      if (!chain.some((link) => link.kind === kind) && !missingLinks.includes(kind)) {
        missingLinks.push(kind);
      }
    }

    return {
      chain,
      complete: missingLinks.length === 0 && chain.length >= 4,
      missingLinks,
      notes,
    };
  }

  /**
   * Build a federation proof chain starting from a host route segment.
   * [REF:CHAIN-FEDERATION]
   */
  async buildFederationChain(seed: string): Promise<ProofChainResult> {
    const notes: string[] = [];
    const chain: ChainLink[] = [];
    const missingLinks: string[] = [];

    let client: Neo4jClient | null = null;
    try {
      client = new Neo4jClient(this.config.neo4j);
      await client.verifyConnectivity();

      // 1. Find the host route
      const hostRoutes = await client.runRead<{ id: string; label: string; filePath: string }>(
        `MATCH (r:AngularRoute)
         WHERE r.path CONTAINS $seed OR r.id CONTAINS $seed
         RETURN r.id AS id, coalesce(r.path, r.id) AS label, coalesce(r.filePath, '') AS filePath
         LIMIT 3`,
        { seed: seed.toLowerCase() },
      );

      if (hostRoutes.length > 0) {
        const hr = hostRoutes[0];
        chain.push({ kind: "HostRoute", id: hr.id, label: hr.label, filePath: hr.filePath || undefined, source: "graph" });
        notes.push(`Found HostRoute '${hr.label}' via graph.`);

        // 2. Federation Mapping (LOADS_REMOTE)
        const fedMappings = await client.runRead<{ id: string; label: string; remoteName: string; exposedModule: string }>(
          `MATCH (r:AngularRoute {id: $routeId})-[:LOADS_REMOTE]->(fb:FederationBoundary)
           RETURN fb.id AS id, coalesce(fb.remoteName, fb.id) AS label, 
                  coalesce(fb.remoteName, '') AS remoteName, coalesce(fb.exposedModule, '') AS exposedModule
           LIMIT 3`,
          { routeId: hr.id },
        );

        if (fedMappings.length > 0) {
          const fm = fedMappings[0];
          chain.push({
            kind: "FederationMapping",
            id: fm.id,
            label: `${fm.remoteName}/${fm.exposedModule}`,
            source: "graph",
          });
          notes.push(`Found FederationMapping '${fm.label}' via LOADS_REMOTE edge.`);

          // 3. Remote Expose
          const remoteExposes = await client.runRead<{ id: string; label: string; filePath: string }>(
            `MATCH (fb:FederationBoundary {id: $fbId})-[:EXPOSES|DEFINES]->(re)
             RETURN re.id AS id, coalesce(re.name, re.id) AS label, coalesce(re.filePath, '') AS filePath
             LIMIT 3`,
            { fbId: fm.id },
          );

          if (remoteExposes.length > 0) {
            const re = remoteExposes[0];
            chain.push({ kind: "RemoteExpose", id: re.id, label: re.label, filePath: re.filePath || undefined, source: "graph" });

            // 4. Remote Route
            const remoteRoutes = await client.runRead<{ id: string; label: string; filePath: string }>(
              `MATCH (re {id: $reId})-[:ROUTES_TO|CONTAINS]->(rr:AngularRoute)
               RETURN rr.id AS id, coalesce(rr.path, rr.id) AS label, coalesce(rr.filePath, '') AS filePath
               LIMIT 3`,
              { reId: re.id },
            );

            if (remoteRoutes.length > 0) {
              const rr = remoteRoutes[0];
              chain.push({ kind: "RemoteRoute", id: rr.id, label: rr.label, filePath: rr.filePath || undefined, source: "graph" });

              // 5. Destination Component
              const destComponents = await client.runRead<{ id: string; label: string; filePath: string }>(
                `MATCH (rr:AngularRoute {id: $rrId})-[:ROUTES_TO]->(dc:AngularComponent)
                 RETURN dc.id AS id, coalesce(dc.selector, dc.name, dc.id) AS label, coalesce(dc.filePath, '') AS filePath
                 LIMIT 3`,
                { rrId: rr.id },
              );
              if (destComponents.length > 0) {
                const dc = destComponents[0];
                chain.push({ kind: "DestinationComponent", id: dc.id, label: dc.label, filePath: dc.filePath || undefined, source: "graph" });
              } else {
                missingLinks.push("DestinationComponent");
                notes.push(`No DestinationComponent found from RemoteRoute '${rr.label}'.`);
              }
            } else {
              missingLinks.push("RemoteRoute");
              notes.push(`No RemoteRoute found from RemoteExpose '${re.label}'.`);
            }
          } else {
            missingLinks.push("RemoteExpose");
            notes.push(`No RemoteExpose found from FederationBoundary '${fm.label}'.`);
          }
        } else {
          missingLinks.push("FederationMapping");
          notes.push(`No LOADS_REMOTE edge from HostRoute '${hr.label}'.`);
          // Try looking for FederationBoundary by seed
          await this.resolveFederationFallback(client, chain, missingLinks, notes, seed);
        }
      } else {
        missingLinks.push("HostRoute");
        notes.push(`No HostRoute found for seed '${seed}'.`);
        // Fallback: try finding FederationBoundary directly
        await this.resolveFederationFallback(client, chain, missingLinks, notes, seed);
      }
    } catch (error) {
      notes.push(`Graph traversal error: ${error instanceof Error ? error.message : "unknown"}.`);
    } finally {
      if (client) await client.close();
    }

    // AST fallback for federation when graph is sparse
    if (chain.length === 0 && this.indexing) {
      const fedHit = this.findSymbolFallback(seed, ["loadremotemodule", "federation", "remoteentry", "webpack.config"]);
      if (fedHit) {
        chain.push({
          kind: "FederationMapping",
          id: `ast:${fedHit.symbol}`,
          label: fedHit.symbol,
          filePath: fedHit.filePath,
          source: "ast_fallback",
        });
        notes.push(`Federation resolved via AST fallback from symbol '${fedHit.symbol}'.`);
      }
    }

    // Fill expected kinds that are missing
    for (const kind of FEDERATION_CHAIN_KINDS) {
      if (!chain.some((link) => link.kind === kind) && !missingLinks.includes(kind)) {
        missingLinks.push(kind);
      }
    }

    return {
      chain,
      complete: missingLinks.length === 0 && chain.length >= 3,
      missingLinks,
      notes,
    };
  }

  /* ── Private: resolve Route → Component → Service → Definition ── */

  private async resolveRouteChain(
    client: Neo4jClient,
    chain: ChainLink[],
    missingLinks: string[],
    notes: string[],
    routeSeed: string,
  ): Promise<void> {
    // Route
    const routes = await client.runRead<{ id: string; label: string; filePath: string }>(
      `MATCH (r:AngularRoute)
       WHERE r.path CONTAINS $seed OR r.id CONTAINS $seed
       RETURN r.id AS id, coalesce(r.path, r.id) AS label, coalesce(r.filePath, '') AS filePath
       LIMIT 3`,
      { seed: routeSeed.toLowerCase() },
    );

    if (routes.length > 0) {
      const r = routes[0];
      if (!chain.some((l) => l.kind === "Route")) {
        chain.push({ kind: "Route", id: r.id, label: r.label, filePath: r.filePath || undefined, source: "graph" });
      }

      // Component
      const components = await client.runRead<{ id: string; label: string; filePath: string }>(
        `MATCH (r:AngularRoute {id: $routeId})-[:ROUTES_TO]->(c:AngularComponent)
         RETURN c.id AS id, coalesce(c.selector, c.name, c.id) AS label, coalesce(c.filePath, '') AS filePath
         LIMIT 3`,
        { routeId: r.id },
      );
      if (components.length > 0) {
        const c = components[0];
        chain.push({ kind: "Component", id: c.id, label: c.label, filePath: c.filePath || undefined, source: "graph" });

        // Service (DI)
        const services = await client.runRead<{ id: string; label: string; filePath: string }>(
          `MATCH (c:AngularComponent {id: $compId})-[:INJECTS]->(s:Service)
           RETURN s.id AS id, coalesce(s.name, s.id) AS label, coalesce(s.filePath, '') AS filePath
           LIMIT 5`,
          { compId: c.id },
        );
        if (services.length > 0) {
          const s = services[0];
          chain.push({ kind: "Service", id: s.id, label: s.label, filePath: s.filePath || undefined, source: "graph" });

          // Definition (DTO/Model)
          const defs = await client.runRead<{ id: string; label: string; filePath: string }>(
            `MATCH (s:Service {id: $svcId})-[:IMPORTS|DEFINES]->(d:Symbol)
             WHERE d.kind IN ['interface', 'type', 'class', 'enum']
             RETURN d.id AS id, coalesce(d.name, d.id) AS label, coalesce(d.filePath, '') AS filePath
             LIMIT 5`,
            { svcId: s.id },
          );
          if (defs.length > 0) {
            const d = defs[0];
            chain.push({ kind: "Definition", id: d.id, label: d.label, filePath: d.filePath || undefined, source: "graph" });
          } else {
            missingLinks.push("Definition");
          }
        } else {
          missingLinks.push("Service");
        }
      } else {
        missingLinks.push("Component");
        notes.push(`No Component found for Route '${r.label}'.`);
      }
    } else {
      missingLinks.push("Route");
      notes.push(`No Route found matching '${routeSeed}'.`);
    }
  }

  /* ── Private: federation fallback when host route is missing ─── */

  private async resolveFederationFallback(
    client: Neo4jClient,
    chain: ChainLink[],
    missingLinks: string[],
    notes: string[],
    seed: string,
  ): Promise<void> {
    const boundaries = await client.runRead<{ id: string; label: string; remoteName: string }>(
      `MATCH (fb:FederationBoundary)
       WHERE fb.remoteName CONTAINS $seed OR fb.id CONTAINS $seed
       RETURN fb.id AS id, coalesce(fb.remoteName, fb.id) AS label, coalesce(fb.remoteName, '') AS remoteName
       LIMIT 3`,
      { seed: seed.toLowerCase() },
    );

    if (boundaries.length > 0) {
      const fb = boundaries[0];
      chain.push({ kind: "FederationMapping", id: fb.id, label: fb.label, source: "graph" });
      notes.push(`Found FederationBoundary '${fb.label}' via direct search.`);
    }
  }

  /* ── Private: AST/lexical fallback ─────────────────────── */

  private async resolveChainViaFallback(
    chain: ChainLink[],
    missingLinks: string[],
    notes: string[],
    seed: string,
  ): Promise<void> {
    if (!this.indexing) return;

    // Try to find route-related symbols
    const routeHit = this.findSymbolFallback(seed, ["route", "routing", "module"]);
    if (routeHit && !chain.some((l) => l.kind === "Route")) {
      chain.push({
        kind: "Route",
        id: `ast:${routeHit.symbol}`,
        label: routeHit.symbol,
        filePath: routeHit.filePath,
        source: "ast_fallback",
      });
      notes.push(`Route resolved via AST fallback from symbol '${routeHit.symbol}'.`);
    }

    // Try to find component
    const compHit = this.findSymbolFallback(seed, ["component"]);
    if (compHit && !chain.some((l) => l.kind === "Component")) {
      chain.push({
        kind: "Component",
        id: `ast:${compHit.symbol}`,
        label: compHit.symbol,
        filePath: compHit.filePath,
        source: "ast_fallback",
      });
      notes.push(`Component resolved via AST fallback from symbol '${compHit.symbol}'.`);
    }
  }

  private findSymbolFallback(
    seed: string,
    kindHints: string[],
  ): { symbol: string; kind: string; filePath: string } | null {
    if (!this.indexing) return null;

    // Search for the seed as a symbol
    const hits = this.indexing.searchSymbol(seed, 10);
    if (hits.length === 0) return null;

    // Prefer hits whose kind or symbol matches a hint
    const lowerHints = kindHints.map((h) => h.toLowerCase());
    const hinted = hits.find((h) =>
      lowerHints.some((hint) =>
        h.kind.toLowerCase().includes(hint) || h.symbol.toLowerCase().includes(hint)
      ),
    );
    return hinted ?? hits[0];
  }

  /**
   * Query Neo4j for graph-derived policy nodes and migration rules.
   * Returns empty arrays when the graph is unavailable (non-fatal).
   */
  async queryGraphPolicies(): Promise<{
    graphPolicies: GraphPolicyNode[];
    migrationRules: MigrationRuleNode[];
  }> {
    let client: Neo4jClient | null = null;
    const graphPolicies: GraphPolicyNode[] = [];
    const migrationRules: MigrationRuleNode[] = [];

    try {
      client = new Neo4jClient(this.config.neo4j);
      await client.verifyConnectivity();

      // Query UIIntent, ComponentIntent, MacroConstraint policy nodes
      const policyRecords = await client.runRead<{
        id: string; type: string; grounded: boolean;
        condition: string; enforcement: string;
        componentTag?: string;
        requiredComponents?: string[];
        forbiddenComponents?: string[];
      }>(
        `MATCH (p)
         WHERE p:UIIntent OR p:ComponentIntent OR p:MacroConstraint
         RETURN p.id AS id,
                coalesce(p.type, 'unknown') AS type,
                coalesce(p.grounded, false) AS grounded,
                coalesce(p.condition, p.description, '') AS condition,
                coalesce(p.enforcement, 'advisory') AS enforcement,
                p.componentTag AS componentTag,
                p.requiredComponents AS requiredComponents,
                p.forbiddenComponents AS forbiddenComponents
         LIMIT 200`,
        {},
      );
      for (const r of policyRecords) {
        graphPolicies.push({
          id: r.id,
          type: r.type as GraphPolicyNode["type"],
          grounded: r.grounded,
          condition: r.condition,
          enforcement: r.enforcement as "hard_deny" | "advisory",
          componentTag: r.componentTag,
          requiredComponents: r.requiredComponents,
          forbiddenComponents: r.forbiddenComponents,
        });
      }

      // Query MigrationRule nodes
      const migrationRecords = await client.runRead<{
        id: string; fromTag: string; toTag: string; status: string;
      }>(
        `MATCH (m:MigrationRule)
         RETURN m.id AS id, m.fromTag AS fromTag, m.toTag AS toTag,
                coalesce(m.status, 'unknown') AS status
         LIMIT 200`,
        {},
      );
      for (const r of migrationRecords) {
        migrationRules.push({
          id: r.id,
          fromTag: r.fromTag,
          toTag: r.toTag,
          status: r.status as MigrationRuleNode["status"],
        });
      }
    } catch {
      // Neo4j unavailable — return empty (non-fatal)
    } finally {
      if (client) {
        try { await client.close(); } catch { /* ignore */ }
      }
    }

    return { graphPolicies, migrationRules };
  }
}
