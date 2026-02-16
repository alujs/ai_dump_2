import { createJsonRpcError, handleMcpMethod } from "./handler";
import { bootstrapRuntime, type RuntimeHandle } from "../runtime/bootstrapRuntime";

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

async function main(): Promise<void> {
  const enableDashboard = parseBool(process.env.MCP_ENABLE_DASHBOARD);
  const dashboardPortEnv = process.env.MCP_DASHBOARD_PORT;
  const dashboardPort =
    dashboardPortEnv && dashboardPortEnv.trim().length > 0 ? Number(dashboardPortEnv) : undefined;

  let runtimePromise: Promise<RuntimeHandle> | null = null;
  const ensureRuntime = (): Promise<RuntimeHandle> => {
    if (!runtimePromise) {
      runtimePromise = bootstrapRuntime({
        startDashboard: enableDashboard,
        dashboardPort
      }).catch((error) => {
        runtimePromise = null;
        throw error;
      });
    }
    return runtimePromise;
  };

  const transport = new StdioJsonRpcTransport(async (request) => {
    const isHandshakeMethod =
      request.method === "initialize" ||
      request.method === "notifications/initialized" ||
      request.method === "tools/list" ||
      request.method === "ping";

    if (isHandshakeMethod) {
      return handleMcpMethod({
        method: request.method,
        params: request.params
      });
    }

    const runtime = await ensureRuntime();
    return handleMcpMethod({
      method: request.method,
      params: request.params,
      controller: runtime.controller
    });
  });

  transport.start();
}

class StdioJsonRpcTransport {
  private buffer = Buffer.alloc(0);
  private drainChain = Promise.resolve();

  constructor(private readonly onRequest: (request: JsonRpcRequest) => Promise<unknown>) {}

  start(): void {
    process.stdin.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainChain = this.drainChain.then(() => this.drainBuffer()).catch((error) => {
        logError(error);
      });
    });
    process.stdin.resume();
  }

  private async drainBuffer(): Promise<void> {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const headerRaw = this.buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = parseContentLength(headerRaw);
      const frameStart = headerEnd + 4;
      const frameEnd = frameStart + contentLength;
      if (this.buffer.length < frameEnd) {
        return;
      }

      const payloadRaw = this.buffer.subarray(frameStart, frameEnd).toString("utf8");
      this.buffer = this.buffer.subarray(frameEnd);

      let payload: unknown;
      try {
        payload = JSON.parse(payloadRaw) as unknown;
      } catch {
        this.writeResponse({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Invalid JSON payload."
          }
        });
        continue;
      }

      await this.dispatchMessage(payload);
    }
  }

  private async dispatchMessage(payload: unknown): Promise<void> {
    if (!isJsonRpcMessage(payload)) {
      this.writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Invalid JSON-RPC envelope."
        }
      });
      return;
    }

    if (!("id" in payload) || payload.id === undefined) {
      await this.dispatchNotification(payload);
      return;
    }

    try {
      const result = await this.onRequest(payload);
      this.writeResponse({
        jsonrpc: "2.0",
        id: payload.id ?? null,
        result: result ?? {}
      });
    } catch (error) {
      logRequestError(payload.method, payload.id ?? null, error);
      const normalized = normalizeJsonRpcError(error);
      this.writeResponse({
        jsonrpc: "2.0",
        id: payload.id ?? null,
        error: normalized
      });
    }
  }

  private async dispatchNotification(payload: JsonRpcNotification): Promise<void> {
    try {
      await this.onRequest({
        jsonrpc: "2.0",
        method: payload.method,
        params: payload.params
      });
    } catch (error) {
      logError(error);
    }
  }

  private writeResponse(response: JsonRpcSuccess | JsonRpcFailure): void {
    const serialized = JSON.stringify(response);
    const encoded = Buffer.from(serialized, "utf8");
    process.stdout.write(`Content-Length: ${encoded.length}\r\n\r\n`);
    process.stdout.write(encoded);
  }
}

function parseContentLength(headers: string): number {
  const lines = headers.split("\r\n");
  for (const line of lines) {
    const parts = line.split(":");
    if (parts.length < 2) {
      continue;
    }
    if (parts[0].trim().toLowerCase() !== "content-length") {
      continue;
    }
    const value = Number(parts.slice(1).join(":").trim());
    if (!Number.isFinite(value) || value < 0) {
      break;
    }
    return value;
  }
  throw createJsonRpcError(-32600, "Missing Content-Length header.");
}

function parseBool(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isJsonRpcMessage(payload: unknown): payload is JsonRpcRequest | JsonRpcNotification {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const cast = payload as { jsonrpc?: unknown; method?: unknown };
  return cast.jsonrpc === "2.0" && typeof cast.method === "string";
}

function normalizeJsonRpcError(error: unknown): JsonRpcFailure["error"] {
  if (isJsonRpcFailureShape(error)) {
    return error;
  }
  if (error instanceof Error) {
    return {
      code: -32603,
      message: error.message
    };
  }
  return {
    code: -32603,
    message: String(error)
  };
}

function isJsonRpcFailureShape(value: unknown): value is JsonRpcFailure["error"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const cast = value as { code?: unknown; message?: unknown };
  return typeof cast.code === "number" && typeof cast.message === "string";
}

function logError(error: unknown): void {
  const text = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[mcp-stdio] ${text}\n`);
}

function logRequestError(method: string, id: JsonRpcId, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[mcp-stdio] request_error method=${method} id=${String(id)}\n`);
  process.stderr.write(`[mcp-stdio] ${detail}\n`);
}

process.on("uncaughtException", (error) => {
  logError(error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  logError(error);
  process.exit(1);
});

main().catch((error) => {
  logError(error);
  process.exit(1);
});
