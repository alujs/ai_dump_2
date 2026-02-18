import type { RunState } from "../../contracts/controller";
import type { PlanGraphDocument } from "../../contracts/planGraph";
import type { ConnectorArtifact } from "../connectors/connectorRegistry";
import type { ScopeAllowlist } from "../worktree-scope/worktreeScopeService";

export interface SessionState {
  runSessionId: string;
  workId: string;
  agentId: string;
  state: RunState;
  originalPrompt: string;
  rejectionCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  usedTokens: number;
  planGraph?: PlanGraphDocument;
  scopeAllowlist: ScopeAllowlist | null;
  artifacts: ConnectorArtifact[];
  contextPack?: {
    ref: string;
    hash: string;
    files: string[];
  };
  planGraphProgress?: {
    totalNodes: number;
    completedNodes: number;
    completedNodeIds: string[];
  };
}

export interface VerbResult {
  result: Record<string, unknown>;
  denyReasons: string[];
  stateOverride?: RunState;
}
