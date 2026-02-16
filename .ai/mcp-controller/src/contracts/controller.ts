import type { PlanGraphDocument } from "./planGraph";

export type RunState =
  | "PLAN_REQUIRED"
  | "PLAN_ACCEPTED"
  | "EXECUTION_ENABLED"
  | "BLOCKED_BUDGET"
  | "FAILED"
  | "COMPLETED";

export type TurnOutcome = "ok" | "pack_insufficient";

export interface TurnRequest {
  runSessionId?: string;
  workId?: string;
  agentId?: string;
  originalPrompt?: string;
  verb: string;
  args?: Record<string, unknown>;
}

export interface PackInsufficiency {
  missingAnchors: Array<{
    anchorType: string;
    requiredBy: string;
    whyRequired: string;
    attemptedSources: string[];
    confidence: number;
  }>;
  escalationPlan: Array<{
    type: "artifact_fetch" | "graph_expand" | "scope_expand" | "pack_rebuild" | "strategy_switch";
    detail: string;
  }>;
  blockedCommands: string[];
  nextRequiredState: "PLAN_REQUIRED";
}

export interface TurnResponse {
  runSessionId: string;
  workId: string;
  agentId: string;
  state: RunState;
  outcome?: TurnOutcome;
  capabilities: string[];
  scope: {
    worktreeRoot: string;
    scratchRoot: string;
  };
  result: Record<string, unknown>;
  denyReasons: string[];
  knowledgeStrategy: {
    strategyId: string;
    reasons: Array<{ reason: string; evidenceRef: string }>;
  };
  budgetStatus: {
    maxTokens: number;
    usedTokens: number;
    thresholdTokens: number;
    blocked: boolean;
  };
  traceRef: string;
  schemaVersion: string;
  subAgentHints: {
    recommended: boolean;
    suggestedSplits: string[];
  };
  packInsufficiency?: PackInsufficiency;
}

export interface TurnExecutionContext {
  request: TurnRequest;
  planGraph?: PlanGraphDocument;
}
