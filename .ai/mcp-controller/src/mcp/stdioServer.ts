import { bootstrapRuntime, type RuntimeHandle } from "../runtime/bootstrapRuntime";
import { TOOL_NAME } from "../shared/constants";
import {
  CONTROLLER_TURN_INPUT_SCHEMA,
  TOOL_DESCRIPTION,
  parseTurnRequest,
  formatTurnResult,
} from "./handler";

/* ── JSON-RPC types (hand-rolled, zero deps) ─────────────── */

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
  error: { code: number; message: string; data?: unknown };
}

/* ── MCP protocol method dispatch ────────────────────────── */

const MCP_SERVER_INFO = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: {} },
  serverInfo: { name: "mcp-controller", version: "1.0.0" },
};

async function handleMcpMethod(
  method: string,
  params: unknown,
  ensureRuntime: () => Promise<RuntimeHandle>,
): Promise<unknown> {
  switch (method) {
    case "initialize":
      return MCP_SERVER_INFO;
    case "notifications/initialized":
    case "initialized":
      return {};
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: [
          {
            name: TOOL_NAME,
            description: TOOL_DESCRIPTION,
            inputSchema: CONTROLLER_TURN_INPUT_SCHEMA,
          },
        ],
      };
    case "tools/call": {
      const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      if (!p?.name || p.name !== TOOL_NAME) {
        throw jsonRpcError(-32601, `Unknown tool '${p?.name ?? "(none)"}'.`);
      }
      const runtime = await ensureRuntime();
      const turnRequest = parseTurnRequest(p.arguments ?? {});
      const turnResponse = await runtime.controller.handleTurn(turnRequest);
      return formatTurnResult(turnResponse);
    }
    default:
      throw jsonRpcError(-32601, `Method not found: ${method}`);
  }
}

/* ── Content-Length framed stdio transport ────────────────── */

class StdioJsonRpcTransport {
  private lineBuffer = "";
  private drainChain = Promise.resolve();

  constructor(
    private readonly onRequest: (req: JsonRpcRequest) => Promise<unknown>,
  ) {}

  start(): void {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      this.lineBuffer += chunk;
      this.drainChain = this.drainChain
        .then(() => this.drainLines())
        .catch((error) => logError(error));
    });
    process.stdin.resume();
  }

  private async drainLines(): Promise<void> {
    while (true) {
      const newlineIdx = this.lineBuffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = this.lineBuffer.substring(0, newlineIdx).trim();
      this.lineBuffer = this.lineBuffer.substring(newlineIdx + 1);

      if (line.length === 0) continue;

      let payload: unknown;
      try {
        payload = JSON.parse(line) as unknown;
      } catch {
        this.writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON payload." } });
        continue;
      }

      await this.dispatchMessage(payload);
    }
  }

  private async dispatchMessage(payload: unknown): Promise<void> {
    if (!isJsonRpcMessage(payload)) {
      this.writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC envelope." } });
      return;
    }

    if (!("id" in payload) || payload.id === undefined) {
      await this.dispatchNotification(payload);
      return;
    }

    try {
      const result = await this.onRequest(payload);
      this.writeResponse({ jsonrpc: "2.0", id: payload.id ?? null, result: result ?? {} });
    } catch (error) {
      logRequestError(payload.method, payload.id ?? null, error);
      this.writeResponse({ jsonrpc: "2.0", id: payload.id ?? null, error: normalizeJsonRpcError(error) });
    }
  }

  private async dispatchNotification(payload: JsonRpcNotification): Promise<void> {
    try {
      await this.onRequest({ jsonrpc: "2.0", method: payload.method, params: payload.params });
    } catch (error) {
      logError(error);
    }
  }

  private writeResponse(response: JsonRpcSuccess | JsonRpcFailure): void {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}

/* ── Entry point ─────────────────────────────────────────── */

async function main(): Promise<void> {
  const enableDashboard = parseBool(process.env.MCP_ENABLE_DASHBOARD);
  const dashboardPort = process.env.MCP_DASHBOARD_PORT?.trim()
    ? Number(process.env.MCP_DASHBOARD_PORT)
    : undefined;

  let runtimePromise: Promise<RuntimeHandle> | null = null;
  const ensureRuntime = (): Promise<RuntimeHandle> => {
    if (!runtimePromise) {
      runtimePromise = bootstrapRuntime({
        startDashboard: enableDashboard,
        dashboardPort,
      }).catch((error) => {
        runtimePromise = null;
        throw error;
      });
    }
    return runtimePromise;
  };

  const transport = new StdioJsonRpcTransport((request) =>
    handleMcpMethod(request.method, request.params, ensureRuntime),
  );
  transport.start();
}

/* ── Helpers ─────────────────────────────────────────────── */

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isJsonRpcMessage(payload: unknown): payload is JsonRpcRequest | JsonRpcNotification {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const cast = payload as { jsonrpc?: unknown; method?: unknown };
  return cast.jsonrpc === "2.0" && typeof cast.method === "string";
}

function jsonRpcError(code: number, message: string, data?: unknown): { code: number; message: string; data?: unknown } {
  return data !== undefined ? { code, message, data } : { code, message };
}

function normalizeJsonRpcError(error: unknown): JsonRpcFailure["error"] {
  if (error && typeof error === "object" && !Array.isArray(error) && "code" in error && "message" in error) {
    return error as JsonRpcFailure["error"];
  }
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}

function logError(error: unknown): void {
  process.stderr.write(`[mcp-stdio] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
}

function logRequestError(method: string, id: JsonRpcId, error: unknown): void {
  process.stderr.write(`[mcp-stdio] request_error method=${method} id=${String(id)}\n`);
  logError(error);
}

/* ── Process-level error handlers ────────────────────────── */

process.on("uncaughtException", (error) => { logError(error); process.exit(1); });
process.on("unhandledRejection", (error) => { logError(error); process.exit(1); });

main().catch((error) => { logError(error); process.exit(1); });

