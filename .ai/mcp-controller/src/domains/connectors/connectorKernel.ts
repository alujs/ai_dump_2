import path from "node:path";
import { readFile } from "node:fs/promises";
import { HttpKernel, NormalizedHttpError } from "../../infrastructure/http/httpClient";
import { traceRef } from "../../shared/ids";
import { resolveRepoRoot } from "../../shared/fsPaths";

export interface ConnectorKernelFetchResult {
  payload: unknown;
  traceRef: string;
  cacheHit: boolean;
}

export class ConnectorKernel {
  private readonly http = new HttpKernel();

  async readPatToken(patFilePath: string): Promise<string> {
    const absolutePath = path.join(resolveRepoRoot(), patFilePath);
    const token = (await readFile(absolutePath, "utf8")).trim();
    if (!token) {
      throw new Error("JIRA_PAT_MISSING");
    }
    return token;
  }

  async fetchJson(url: string, init: RequestInit): Promise<ConnectorKernelFetchResult> {
    const nextTraceRef = traceRef();
    const response = await this.http.fetchJson(url, init, nextTraceRef);
    return {
      payload: response.payload,
      traceRef: nextTraceRef,
      cacheHit: response.cacheHit
    };
  }

  normalizeError(error: unknown): { code: string; message: string } {
    if (error instanceof NormalizedHttpError) {
      return {
        code: error.code,
        message: error.message
      };
    }
    if (error instanceof Error) {
      return {
        code: "CONNECTOR_ERROR",
        message: error.message
      };
    }
    return {
      code: "CONNECTOR_ERROR",
      message: "Unknown connector failure"
    };
  }
}
