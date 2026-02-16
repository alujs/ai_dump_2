import path from "node:path";
import { readFile } from "node:fs/promises";
import type { GatewayConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";
import { validateGatewayConfig } from "./validateConfig";
import { resolveRepoRoot } from "../shared/fsPaths";

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readRequiredJson(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function loadGatewayConfig(): Promise<GatewayConfig> {
  const root = resolveRepoRoot();
  const schema = await readRequiredJson(path.join(root, ".ai", "config", "schema.json"));
  const base = await readJsonIfExists(path.join(root, ".ai", "config", "base.json"));
  const repo = await readJsonIfExists(path.join(root, ".ai", "config", "repo.json"));
  const envLocal = await readJsonIfExists(path.join(root, ".ai", "config", "env.local.json"));

  if (!schema.properties || typeof schema.properties !== "object") {
    throw new Error("Invalid .ai/config/schema.json: missing top-level properties object.");
  }

  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    base,
    repo,
    envLocal
  ) as unknown as GatewayConfig;

  const hydrated = {
    ...merged,
    dashboardPort: Number(process.env.MCP_DASHBOARD_PORT ?? merged.dashboardPort ?? 8722),
    neo4j: {
      uri: process.env.NEO4J_URI ?? merged.neo4j.uri,
      username: process.env.NEO4J_USERNAME ?? merged.neo4j.username,
      password: process.env.NEO4J_PASSWORD ?? merged.neo4j.password,
      database: process.env.NEO4J_DATABASE ?? merged.neo4j.database
    }
  };

  const validation = validateGatewayConfig(hydrated);
  if (!validation.ok) {
    const list = validation.errors.map((entry) => `- ${entry}`).join("\n");
    throw new Error(`Invalid MCP config:\n${list}`);
  }

  return hydrated;
}

function deepMerge(...objects: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      if (Array.isArray(value)) {
        out[key] = value;
      } else if (isPlainObject(value)) {
        out[key] = deepMerge((out[key] as Record<string, unknown>) ?? {}, value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
