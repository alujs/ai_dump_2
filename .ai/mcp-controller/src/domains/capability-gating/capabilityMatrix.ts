import type { RunState } from "../../contracts/controller";
import { POST_PLAN_CAPABILITIES, PRE_PLAN_CAPABILITIES } from "../../shared/constants";

export function capabilitiesForState(state: RunState): string[] {
  if (state === "PLAN_ACCEPTED" || state === "EXECUTION_ENABLED") {
    return [...POST_PLAN_CAPABILITIES];
  }
  if (state === "BLOCKED_BUDGET") {
    return ["list_available_verbs", "get_original_prompt", "request_evidence_guidance"];
  }
  if (state === "FAILED" || state === "COMPLETED") {
    return ["list_available_verbs", "get_original_prompt"];
  }
  return [...PRE_PLAN_CAPABILITIES];
}

export function canExecuteMutation(state: RunState): boolean {
  return state === "PLAN_ACCEPTED" || state === "EXECUTION_ENABLED";
}
