import type { TurnRequest, TurnResponse } from "../contracts/controller";
import type { TurnController } from "../domains/controller/turnController";
import { TOOL_NAME } from "../shared/constants";

export const MCP_SERVER_INFO = {
  name: "mcp-controller",
  version: "1.0.0"
} as const;

export const CONTROLLER_TURN_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    runSessionId: { type: "string" },
    workId: { type: "string" },
    agentId: { type: "string" },
    originalPrompt: { type: "string" },
    verb: { type: "string" },
    args: {
      type: "object",
      additionalProperties: true
    }
  },
  required: ["verb"]
} as const;

export async function handleMcpMethod(input: {
  method: string;
  params?: unknown;
  controller?: TurnController;
}): Promise<unknown> {
  switch (input.method) {
    case "initialize":
      return {
        protocolVersion: resolveProtocolVersion(input.params),
        capabilities: {
          tools: {}
        },
        serverInfo: MCP_SERVER_INFO
      };
    case "notifications/initialized":
      return {};
    case "tools/list":
      return {
        tools: [
          {
            name: TOOL_NAME,
            description: "Gateway controller tool for plan-safe and policy-gated work execution.",
            inputSchema: CONTROLLER_TURN_INPUT_SCHEMA
          }
        ]
      };
    case "tools/call": {
      if (!input.controller) {
        throw createJsonRpcError(-32603, "MCP runtime controller is not initialized.");
      }
      const toolCall = asRecord(input.params);
      const toolName = asString(toolCall.name);
      if (toolName !== TOOL_NAME) {
        throw createJsonRpcError(-32602, `Unknown tool '${toolName ?? ""}'.`);
      }

      const turnRequest = parseTurnRequest(asRecord(toolCall.arguments));
      const turnResponse = await input.controller.handleTurn(turnRequest);

      return {
        content: [
          {
            type: "text",
            text: summarizeTurn(turnResponse)
          }
        ],
        structuredContent: turnResponse,
        isError: turnResponse.denyReasons.length > 0
      };
    }
    case "ping":
      return {};
    default:
      throw createJsonRpcError(-32601, `Method '${input.method}' is not supported.`);
  }
}

export function parseTurnRequest(raw: Record<string, unknown>): TurnRequest {
  const verb = asString(raw.verb);
  if (!verb) {
    throw createJsonRpcError(-32602, "tools/call arguments must include 'verb'.");
  }

  const parsed: TurnRequest = {
    verb,
    args: asRecord(raw.args)
  };
  const runSessionId = asString(raw.runSessionId);
  if (runSessionId) {
    parsed.runSessionId = runSessionId;
  }
  const workId = asString(raw.workId);
  if (workId) {
    parsed.workId = workId;
  }
  const agentId = asString(raw.agentId);
  if (agentId) {
    parsed.agentId = agentId;
  }
  const originalPrompt = asString(raw.originalPrompt);
  if (originalPrompt) {
    parsed.originalPrompt = originalPrompt;
  }
  return parsed;
}

function summarizeTurn(response: TurnResponse): string {
  const deny = response.denyReasons.length > 0 ? response.denyReasons.join(",") : "none";
  return `state=${response.state}; denyReasons=${deny}; traceRef=${response.traceRef}`;
}

function resolveProtocolVersion(params: unknown): string {
  const candidate = asString(asRecord(params).protocolVersion);
  if (candidate) {
    return candidate;
  }
  return "2024-11-05";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

export function createJsonRpcError(code: number, message: string, data?: unknown): {
  code: number;
  message: string;
  data?: unknown;
} {
  return {
    code,
    message,
    data
  };
}
