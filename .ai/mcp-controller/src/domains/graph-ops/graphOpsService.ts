import path from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { ensureDir } from "../../shared/fileStore";
import { replaceWithGuard } from "../../shared/replaceGuard";
import { Neo4jClient, type Neo4jConnectionConfig } from "../../infrastructure/neo4j/client";

type SeedRow =
  | {
      kind: "cypher" | "query";
      query: string;
      params?: Record<string, unknown>;
    }
  | {
      kind: "node";
      id: string;
      labels?: string[];
      label?: string;
      properties?: Record<string, unknown>;
    }
  | {
      kind: "relationship" | "rel";
      id?: string;
      relType?: string;
      type?: string;
      from: { id: string; label?: string };
      to: { id: string; label?: string };
      properties?: Record<string, unknown>;
    };

export interface GraphOpsConfig {
  seedRoot: string;
  outRoot: string;
  cypherRoot: string;
  neo4j: Neo4jConnectionConfig;
}

export interface GraphSyncResult {
  appliedCypherStatements: number;
  seededRows: number;
}

export class GraphOpsService {
  private readonly seedRootAbs: string;
  private readonly outRootAbs: string;
  private readonly cypherRootAbs: string;

  constructor(private readonly config: GraphOpsConfig) {
    this.seedRootAbs = path.resolve(this.config.seedRoot);
    this.outRootAbs = path.resolve(this.config.outRoot);
    this.cypherRootAbs = path.resolve(this.config.cypherRoot);
    this.assertPathIsolation();
  }

  async checkConnectivity(): Promise<void> {
    const client = new Neo4jClient(this.config.neo4j);
    try {
      await client.verifyConnectivity();
    } finally {
      await client.close();
    }
  }

  async sync(): Promise<GraphSyncResult> {
    const client = new Neo4jClient(this.config.neo4j);
    try {
      await client.verifyConnectivity();
      await this.dropAll(client);
      const appliedCypherStatements = await this.rebuildIndexes(client);
      const seededRows = await this.upsertSeed(client);
      // Sync is a full graph rebuild; clear export watermark so next export is deterministic.
      await this.writeWatermark({ lastExportAt: "" });
      return { appliedCypherStatements, seededRows };
    } finally {
      await client.close();
    }
  }

  async exportSnapshot(tag = "delta"): Promise<{ files: string[]; nodeCount: number; relationshipCount: number }> {
    const client = new Neo4jClient(this.config.neo4j);
    try {
      await client.verifyConnectivity();

      const watermark = await this.readWatermark();
      const since = watermark.lastExportAt ?? "";
      const now = new Date().toISOString();

      const nodes = await client.runRead<{
        labels: string[];
        properties: Record<string, unknown>;
      }>(
        `
          MATCH (n)
          WHERE $since = "" OR coalesce(n.updated_at, n._graphops_updated_at, "") > $since
          RETURN labels(n) AS labels, properties(n) AS properties
        `,
        { since }
      );

      const relationships = await client.runRead<{
        fromLabels: string[];
        fromId: string;
        relType: string;
        toLabels: string[];
        toId: string;
        properties: Record<string, unknown>;
      }>(
        `
          MATCH (a)-[r]->(b)
          WHERE $since = "" OR coalesce(r.updated_at, r._graphops_updated_at, "") > $since
          RETURN labels(a) AS fromLabels, a.id AS fromId, type(r) AS relType,
                 labels(b) AS toLabels, b.id AS toId, properties(r) AS properties
        `,
        { since }
      );

      const files = await this.writeBucketedExport(tag, nodes, relationships);
      await this.writeWatermark({ lastExportAt: now });

      return {
        files,
        nodeCount: nodes.length,
        relationshipCount: relationships.length
      };
    } finally {
      await client.close();
    }
  }

  private async dropAll(client: Neo4jClient): Promise<void> {
    await client.runWrite("MATCH (n) DETACH DELETE n");
  }

  private async rebuildIndexes(client: Neo4jClient): Promise<number> {
    const scriptFiles = await listCypherFiles(this.config.cypherRoot);
    let applied = 0;
    for (const scriptFile of scriptFiles) {
      const content = await readFile(scriptFile, "utf8");
      const statements = splitCypherStatements(content);
      for (const statement of statements) {
        await client.runWrite(statement);
        applied += 1;
      }
    }
    return applied;
  }

  private async upsertSeed(client: Neo4jClient): Promise<number> {
    const syncedAt = new Date().toISOString();
    const files = await listJsonlFiles(this.config.seedRoot);
    const directQueries: Array<Extract<SeedRow, { kind: "cypher" | "query" }>> = [];
    const keyedRows = new Map<string, Extract<SeedRow, { kind: "node" | "relationship" | "rel" }>>();

    for (const file of files) {
      const lines = (await readFile(file, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (const line of lines) {
        const row = parseSeedRow(line);
        if (!row) {
          continue;
        }
        if (row.kind === "cypher" || row.kind === "query") {
          directQueries.push(row as Extract<SeedRow, { kind: "cypher" | "query" }>);
          continue;
        }
        if (row.kind === "node" && isPolicyOrRecipeNode(row)) {
          enforcePolicyRecipeRowInvariants(row);
        }
        const key = seedRowKey(row);
        if (key) {
          const candidate = row as Extract<SeedRow, { kind: "node" | "relationship" | "rel" }>;
          const existing = keyedRows.get(key);
          if (!existing) {
            keyedRows.set(key, candidate);
          } else {
            keyedRows.set(key, resolveConflict(existing, candidate));
          }
        }
      }
    }

    let applied = 0;
    for (const row of directQueries) {
      await client.runWrite(row.query, row.params ?? {});
      applied += 1;
    }
    for (const row of keyedRows.values()) {
      if (row.kind === "node") {
        await this.upsertNode(client, row, syncedAt);
      } else {
        await this.upsertRelationship(client, row, syncedAt);
      }
      applied += 1;
    }
    return applied;
  }

  private async upsertNode(
    client: Neo4jClient,
    row: Extract<SeedRow, { kind: "node" }>,
    syncedAt: string
  ): Promise<void> {
    const labels = sanitizeLabels(row.labels ?? [row.label ?? "Entity"]);
    const labelFragment = labels.map((label) => `:${label}`).join("");
    const props = {
      ...(row.properties ?? {}),
      id: row.id,
      _graphops_updated_at: syncedAt
    };
    const query = `MERGE (n${labelFragment} {id: $id}) SET n += $props`;
    await client.runWrite(query, { id: row.id, props });
  }

  private async upsertRelationship(
    client: Neo4jClient,
    row: Extract<SeedRow, { kind: "relationship" | "rel" }>,
    syncedAt: string
  ): Promise<void> {
    const fromLabel = sanitizeLabel(row.from.label ?? "Entity");
    const toLabel = sanitizeLabel(row.to.label ?? "Entity");
    const relType = sanitizeLabel(row.relType ?? row.type ?? "RELATED_TO");
    const relProps = {
      ...(row.properties ?? {}),
      _graphops_updated_at: syncedAt
    };

    if (row.id) {
      const query = `
        MERGE (a:${fromLabel} {id: $fromId})
        MERGE (b:${toLabel} {id: $toId})
        MERGE (a)-[r:${relType} {id: $relId}]->(b)
        SET r += $props
      `;
      await client.runWrite(query, {
        fromId: row.from.id,
        toId: row.to.id,
        relId: row.id,
        props: relProps
      });
      return;
    }

    const query = `
      MERGE (a:${fromLabel} {id: $fromId})
      MERGE (b:${toLabel} {id: $toId})
      MERGE (a)-[r:${relType}]->(b)
      SET r += $props
    `;
    await client.runWrite(query, {
      fromId: row.from.id,
      toId: row.to.id,
      props: relProps
    });
  }

  private async writeBucketedExport(
    tag: string,
    nodes: Array<{ labels: string[]; properties: Record<string, unknown> }>,
    relationships: Array<{
      fromLabels: string[];
      fromId: string;
      relType: string;
      toLabels: string[];
      toId: string;
      properties: Record<string, unknown>;
    }>
  ): Promise<string[]> {
    const files: string[] = [];
    const nodeBuckets = new Map<string, string[]>();
    const relBuckets = new Map<string, string[]>();

    for (const node of nodes) {
      const bucket = bucketForLabels(node.labels);
      const row = JSON.stringify({
        kind: "node",
        labels: node.labels,
        properties: node.properties
      });
      const list = nodeBuckets.get(bucket) ?? [];
      list.push(row);
      nodeBuckets.set(bucket, list);
    }

    for (const rel of relationships) {
      const bucket = bucketForLabels([...rel.fromLabels, ...rel.toLabels]);
      const row = JSON.stringify({
        kind: "relationship",
        from: { id: rel.fromId, labels: rel.fromLabels },
        to: { id: rel.toId, labels: rel.toLabels },
        relType: rel.relType,
        properties: rel.properties
      });
      const list = relBuckets.get(bucket) ?? [];
      list.push(row);
      relBuckets.set(bucket, list);
    }

    for (const [bucket, rows] of nodeBuckets) {
      const filePath = path.join(this.config.outRoot, bucket, `nodes.${tag}.jsonl`);
      await ensureDir(path.dirname(filePath));
      await writeFile(filePath, `${rows.join("\n")}\n`, "utf8");
      files.push(filePath);
    }
    for (const [bucket, rows] of relBuckets) {
      const filePath = path.join(this.config.outRoot, bucket, `rels.${tag}.jsonl`);
      await ensureDir(path.dirname(filePath));
      await writeFile(filePath, `${rows.join("\n")}\n`, "utf8");
      files.push(filePath);
    }

    return files.sort((a, b) => a.localeCompare(b));
  }

  private async readWatermark(): Promise<{ lastExportAt?: string }> {
    const filePath = path.join(this.config.outRoot, "_watermarks.json");
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as { lastExportAt?: string };
    } catch {
      return {};
    }
  }

  private async writeWatermark(value: { lastExportAt: string }): Promise<void> {
    const filePath = path.join(this.config.outRoot, "_watermarks.json");
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  }

  private assertPathIsolation(): void {
    if (pathsOverlap(this.seedRootAbs, this.outRootAbs)) {
      throw new Error("GRAPHOPS_PATH_COLLISION: graph.outRoot must not overlap graph.seedRoot.");
    }
    if (pathsOverlap(this.seedRootAbs, this.cypherRootAbs)) {
      throw new Error("GRAPHOPS_PATH_COLLISION: graph.cypherRoot must not overlap graph.seedRoot.");
    }
  }
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryName = String(entry.name);
      const full = path.join(current, entryName);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && entryName.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }
  return results.sort((a, b) => a.localeCompare(b));
}

async function listCypherFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryName = String(entry.name);
      const full = path.join(current, entryName);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && (entryName.endsWith(".cypher") || entryName.endsWith(".cql"))) {
        results.push(full);
      }
    }
  }
  return results.sort((a, b) => a.localeCompare(b));
}

function parseSeedRow(line: string): SeedRow | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.query === "string") {
      return {
        kind: (parsed.kind === "query" ? "query" : "cypher"),
        query: parsed.query,
        params: isRecord(parsed.params) ? parsed.params : undefined
      };
    }
    if (parsed.kind === "node" && typeof parsed.id === "string") {
      return {
        kind: "node",
        id: parsed.id,
        labels: asStringArray(parsed.labels),
        label: typeof parsed.label === "string" ? parsed.label : undefined,
        properties: isRecord(parsed.properties) ? parsed.properties : undefined
      };
    }
    if ((parsed.kind === "relationship" || parsed.kind === "rel") && isRecord(parsed.from) && isRecord(parsed.to)) {
      if (typeof parsed.from.id !== "string" || typeof parsed.to.id !== "string") {
        return null;
      }
      return {
        kind: parsed.kind,
        id: typeof parsed.id === "string" ? parsed.id : undefined,
        relType: typeof parsed.relType === "string" ? parsed.relType : undefined,
        type: typeof parsed.type === "string" ? parsed.type : undefined,
        from: {
          id: parsed.from.id,
          label: typeof parsed.from.label === "string" ? parsed.from.label : undefined
        },
        to: {
          id: parsed.to.id,
          label: typeof parsed.to.label === "string" ? parsed.to.label : undefined
        },
        properties: isRecord(parsed.properties) ? parsed.properties : undefined
      };
    }
    return null;
  } catch {
    return null;
  }
}

function seedRowKey(row: SeedRow): string | null {
  if (row.kind === "node") {
    const labels = sanitizeLabels(row.labels ?? [row.label ?? "Entity"]).join(",");
    return `node:${labels}:${row.id}`;
  }
  if (row.kind === "relationship" || row.kind === "rel") {
    const relType = sanitizeLabel(row.relType ?? row.type ?? "RELATED_TO");
    const relId = row.id ?? "_";
    return `rel:${row.from.id}:${relType}:${row.to.id}:${relId}`;
  }
  return null;
}

export function resolveConflict(
  existing: Extract<SeedRow, { kind: "node" | "relationship" | "rel" }>,
  candidate: Extract<SeedRow, { kind: "node" | "relationship" | "rel" }>
): Extract<SeedRow, { kind: "node" | "relationship" | "rel" }> {
  const existingMeta = extractConflictMeta(existing);
  const candidateMeta = extractConflictMeta(candidate);

  if (existingMeta && candidateMeta) {
    const rowsChanged = JSON.stringify(existing) !== JSON.stringify(candidate);
    if (rowsChanged && candidateMeta.version <= existingMeta.version) {
      throw new Error(
        `GRAPH_SEED_VERSION_NOT_INCREMENTED key change detected but version did not increase (existing=${existingMeta.version} candidate=${candidateMeta.version}).`
      );
    }
    if (candidateMeta.version !== existingMeta.version) {
      return candidateMeta.version > existingMeta.version ? candidate : existing;
    }
    if (candidateMeta.updatedAt !== existingMeta.updatedAt) {
      return candidateMeta.updatedAt > existingMeta.updatedAt ? candidate : existing;
    }
    if (candidateMeta.updatedBy !== existingMeta.updatedBy) {
      return candidateMeta.updatedBy > existingMeta.updatedBy ? candidate : existing;
    }
    return candidate;
  }

  // Deterministic fallback when no metadata exists for conflict policy.
  return JSON.stringify(candidate) >= JSON.stringify(existing) ? candidate : existing;
}

export function isPolicyOrRecipeNode(row: Extract<SeedRow, { kind: "node" }>): boolean {
  const labels = (row.labels ?? [row.label ?? ""]).map((item) => String(item).toLowerCase());
  return labels.some((label) => label.includes("policy") || label.includes("recipe"));
}

export function enforcePolicyRecipeRowInvariants(row: Extract<SeedRow, { kind: "node" }>): void {
  const props = row.properties ?? {};
  const required = ["id", "type", "version", "updated_at", "updated_by"];
  const missing = required.filter((key) => !(key in props) || String(props[key] ?? "").trim().length === 0);
  if (missing.length > 0) {
    throw new Error(`GRAPH_SEED_INVARIANT_VIOLATION missing fields for policy/recipe row ${row.id}: ${missing.join(",")}`);
  }
}

function extractConflictMeta(
  row: Extract<SeedRow, { kind: "node" | "relationship" | "rel" }>
): { version: number; updatedAt: string; updatedBy: string } | null {
  const props = row.properties ?? {};
  const versionRaw = props.version;
  const updatedAt = String(props.updated_at ?? "");
  const updatedBy = String(props.updated_by ?? "");
  const version =
    typeof versionRaw === "number"
      ? versionRaw
      : typeof versionRaw === "string"
        ? Number(versionRaw)
        : Number.NaN;

  if (!Number.isFinite(version) || !updatedAt || !updatedBy) {
    return null;
  }

  return {
    version,
    updatedAt,
    updatedBy
  };
}

function splitCypherStatements(content: string): string[] {
  return content
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function sanitizeLabels(labels: string[]): string[] {
  const sanitized = labels
    .map((label) => sanitizeLabel(label))
    .filter((label) => label.length > 0);
  return sanitized.length ? sanitized : ["Entity"];
}

function sanitizeLabel(label: string): string {
  return replaceWithGuard(label, /[^A-Za-z0-9_]/g, "", "GraphOpsService:sanitizeLabel");
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => String(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bucketForLabels(labels: string[]): string {
  const lower = labels.map((item) => item.toLowerCase());
  if (lower.some((item) => item.includes("policy"))) {
    return "policy";
  }
  if (lower.some((item) => item.includes("recipe"))) {
    return "recipe";
  }
  if (lower.some((item) => item.includes("memory") || item.includes("correction"))) {
    return "memory";
  }
  return "fact";
}

function pathsOverlap(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) {
    return true;
  }
  return a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}
