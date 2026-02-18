import type { GatewayConfig } from "../../config/types";
import { replaceWithGuard } from "../../shared/replaceGuard";
import { ConnectorKernel } from "./connectorKernel";

export interface ConnectorArtifact {
  source: "jira" | "swagger" | "attachment";
  ref: string;
  summary: string;
  metadata: Record<string, unknown>;
}

export class ConnectorRegistry {
  private readonly kernel = new ConnectorKernel();

  constructor(private readonly config: GatewayConfig) {}

  async fetchJiraIssue(issueKey: string): Promise<ConnectorArtifact> {
    const pat = await this.kernel.readPatToken(this.config.jira.patFilePath);
    const baseUrl = this.config.jira.baseUrl.trim();

    if (!baseUrl) {
      // Keep deterministic placeholder behavior if remote endpoint is not configured.
      return {
        source: "jira",
        ref: `jira:${issueKey}`,
        summary: `Jira artifact placeholder for ${issueKey}`,
        metadata: {
          issueKey,
          baseUrl,
          authMode: "pat_file",
          fetchedAt: new Date().toISOString(),
          mode: "placeholder"
        }
      };
    }

    try {
      const sanitizedBaseUrl = replaceWithGuard(baseUrl, /\/$/, "", "ConnectorRegistry:fetchJiraIssue:base-url");
      const url = `${sanitizedBaseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}`;
      const response = await this.kernel.fetchJson(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/json"
        }
      });
      return {
        source: "jira",
        ref: `jira:${issueKey}`,
        summary: `Jira issue ${issueKey}`,
        metadata: {
          issueKey,
          baseUrl,
          authMode: "pat_file",
          fetchedAt: new Date().toISOString(),
          traceRef: response.traceRef,
          cacheHit: response.cacheHit,
          payload: response.payload
        }
      };
    } catch (error) {
      const normalized = this.kernel.normalizeError(error);
      throw new Error(`${normalized.code}: ${normalized.message}`);
    }
  }

  async registerSwaggerRef(swaggerRef: string): Promise<ConnectorArtifact> {
    if (swaggerRef.startsWith("http://") || swaggerRef.startsWith("https://")) {
      try {
        const response = await this.kernel.fetchJson(swaggerRef, {
          method: "GET",
          headers: {
            Accept: "application/json"
          }
        });
        return {
          source: "swagger",
          ref: `swagger:${swaggerRef}`,
          summary: "Swagger artifact reference",
          metadata: {
            swaggerRef,
            roots: this.config.swagger.roots,
            fetchedAt: new Date().toISOString(),
            traceRef: response.traceRef,
            cacheHit: response.cacheHit,
            payload: response.payload
          }
        };
      } catch (error) {
        const normalized = this.kernel.normalizeError(error);
        throw new Error(`${normalized.code}: ${normalized.message}`);
      }
    }

    return {
      source: "swagger",
      ref: `swagger:${swaggerRef}`,
      summary: "Swagger artifact reference",
      metadata: {
        swaggerRef,
        roots: this.config.swagger.roots,
        fetchedAt: new Date().toISOString()
      }
    };
  }
}
