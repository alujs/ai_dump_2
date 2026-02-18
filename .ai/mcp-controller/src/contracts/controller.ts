import type { PlanGraphDocument } from "./planGraph";

export type RunState =
  | "UNINITIALIZED"
  | "PLANNING"
  | "PLAN_ACCEPTED"
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
  traceMeta?: Record<string, unknown>;
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
  nextRequiredState: "PLANNING";
}

export interface TurnResponse {
  runSessionId: string;
  workId: string;
  agentId: string;
  state: RunState;
  outcome?: TurnOutcome;
  capabilities: string[];
  /** Per-verb description, whenToUse, and argument schema so the agent knows what each verb does. */
  verbDescriptions: Record<string, { description: string; whenToUse: string; requiredArgs: string[]; optionalArgs: string[] }>;
  scope: {
    worktreeRoot: string;
    scratchRoot: string;
  };
  result: Record<string, unknown>;
  denyReasons: string[];
  /** The original user prompt — always present, replaces get_original_prompt verb. */
  originalPrompt: string;
  /** When the controller denies a request, this tells the agent what to do next. */
  suggestedAction?: {
    verb: string;
    reason: string;
    args?: Record<string, unknown>;
  };
  knowledgeStrategy: {
    strategyId: string;
    contextSignature?: Record<string, unknown>;
    reasons: Array<{ reason: string; evidenceRef: string }>;
  };
  progress: {
    totalNodes: number;
    completedNodes: number;
    remainingNodes: number;
    pendingValidations: Array<{ nodeId: string; status: string }>;
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
