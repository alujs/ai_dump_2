import type { TurnRequest, TurnResponse } from "../../contracts/controller";
import type { SessionState } from "./types";
import { DEFAULT_BUDGET_THRESHOLD_PERCENT, DEFAULT_MAX_TOKENS } from "../../shared/constants";

export function consumeBudget(
  session: SessionState,
  request: TurnRequest
): TurnResponse["budgetStatus"] {
  session.usedTokens += estimateTokenCost(request);
  const thresholdTokens = Math.floor(DEFAULT_MAX_TOKENS * DEFAULT_BUDGET_THRESHOLD_PERCENT);
  return {
    maxTokens: DEFAULT_MAX_TOKENS,
    usedTokens: session.usedTokens,
    thresholdTokens,
    blocked: session.usedTokens >= thresholdTokens,
  };
}

export function isBudgetSafeVerb(verb: string): boolean {
  return verb === "list_available_verbs" || verb === "get_original_prompt" || verb === "request_evidence_guidance" || verb === "signal_task_complete";
}

function estimateTokenCost(request: TurnRequest): number {
  let serialized = "";
  try {
    serialized = JSON.stringify({
      verb: request.verb,
      originalPrompt: request.originalPrompt ?? "",
      args: request.args ?? {},
    });
  } catch {
    serialized = request.verb;
  }
  return Math.max(1, Math.ceil(serialized.length / 4));
}
