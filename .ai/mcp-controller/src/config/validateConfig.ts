import path from "node:path";
import type { GatewayConfig } from "./types";

export function validateGatewayConfig(config: GatewayConfig): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!Number.isFinite(config.dashboardPort) || config.dashboardPort <= 0) {
    errors.push("dashboardPort must be a positive integer.");
  }
  if (config.dashboardPort === 4200 || config.dashboardPort === 8080) {
    errors.push("dashboardPort must not be 4200 or 8080.");
  }

  validateNonEmptyString(config.neo4j.uri, "neo4j.uri", errors);
  validateNonEmptyString(config.neo4j.username, "neo4j.username", errors);
  validateNonEmptyString(config.neo4j.password, "neo4j.password", errors);
  validateNonEmptyString(config.neo4j.database, "neo4j.database", errors);

  validateNonEmptyString(config.graph.seedRoot, "graph.seedRoot", errors);
  validateNonEmptyString(config.graph.outRoot, "graph.outRoot", errors);
  validateNonEmptyString(config.graph.cypherRoot, "graph.cypherRoot", errors);

  validateNonEmptyString(config.repo.root, "repo.root", errors);
  validateNonEmptyString(config.repo.worktreeRoot, "repo.worktreeRoot", errors);

  if (!config.ingestion.includes.length) {
    errors.push("ingestion.includes must contain at least one glob.");
  }
  if (!config.ingestion.excludes.length) {
    errors.push("ingestion.excludes must contain at least one glob.");
  }

  if (!config.hints.angularRoots.length) {
    errors.push("hints.angularRoots must include at least one root path.");
  }
  if (!config.parserTargets.typescript.length) {
    errors.push("parserTargets.typescript must include at least one root path.");
  }
  if (!config.parserTargets.templates.length) {
    errors.push("parserTargets.templates must include at least one root path.");
  }

  validateNonEmptyString(config.recipes.manifestPath, "recipes.manifestPath", errors);
  validateNonEmptyString(config.jira.patFilePath, "jira.patFilePath", errors);

  const patNormalized = normalizeSlash(config.jira.patFilePath);
  if (!patNormalized.startsWith(".ai/auth/")) {
    errors.push("jira.patFilePath must resolve under .ai/auth/");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function validateNonEmptyString(value: string, field: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} is required.`);
  }
}

function normalizeSlash(value: string): string {
  return value.split(path.sep).join("/");
}
