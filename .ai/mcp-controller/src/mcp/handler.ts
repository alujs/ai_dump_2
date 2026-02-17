import type { TurnRequest, TurnResponse } from "../contracts/controller";
import { TOOL_NAME } from "../shared/constants";

/**
 * JSON-Schema for the single controller.turn tool input.
 * Used by both SDK tool registration and direct handler mode.
 */
export const CONTROLLER_TURN_INPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    runSessionId: { type: "string", description: "Session identifier for run continuity." },
    workId: { type: "string", description: "Work unit identifier scoping this turn." },
    agentId: { type: "string", description: "Agent identifier for multi-agent tracking." },
    originalPrompt: { type: "string", description: "The original user prompt for this work unit." },
    verb: { type: "string", description: "The command verb to execute." },
    args: { type: "object", additionalProperties: true, description: "Verb-specific arguments." },
    traceMeta: { type: "object", additionalProperties: true, description: "Optional trace metadata forwarded from caller." },
  },
  required: ["verb"],
} as const;

export const TOOL_DESCRIPTION =
  "Gateway controller tool for plan-safe and policy-gated work execution. " +
  "Single chokepoint for all agent interaction: capability gating, evidence-backed planning, " +
  "scoped execution, and observability-driven memory/policy evolution.";

/**
 * Parse raw tool arguments into a typed TurnRequest.
 */
export function parseTurnRequest(raw: Record<string, unknown>): TurnRequest {
  const verb = asString(raw.verb);
  if (!verb) {
    throw new Error("tools/call arguments must include 'verb'.");
  }

  const parsed: TurnRequest = { verb, args: asRecord(raw.args) };

  const runSessionId = asString(raw.runSessionId);
  if (runSessionId) parsed.runSessionId = runSessionId;

  const workId = asString(raw.workId);
  if (workId) parsed.workId = workId;

  const agentId = asString(raw.agentId);
  if (agentId) parsed.agentId = agentId;

  const originalPrompt = asString(raw.originalPrompt);
  if (originalPrompt) parsed.originalPrompt = originalPrompt;

  const traceMeta = asRecord(raw.traceMeta);
  if (Object.keys(traceMeta).length > 0) parsed.traceMeta = traceMeta;

  return parsed;
}

/**
 * Format a TurnResponse into the MCP tool result shape.
 */
export function formatTurnResult(response: TurnResponse): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: TurnResponse;
  isError: boolean;
} {
  const deny = response.denyReasons.length > 0
    ? response.denyReasons.join(",")
    : "none";

  return {
    content: [
      {
        type: "text",
        text: `state=${response.state}; denyReasons=${deny}; traceRef=${response.traceRef}`,
      },
    ],
    structuredContent: response,
    isError: response.denyReasons.length > 0,
  };
}

/* ── internal helpers ──────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  return undefined;
}
