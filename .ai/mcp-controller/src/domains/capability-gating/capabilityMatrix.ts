import type { RunState } from "../../contracts/controller";
import { POST_PLAN_CAPABILITIES, PRE_PLAN_CAPABILITIES } from "../../shared/constants";

export function capabilitiesForState(state: RunState): string[] {
  if (state === "PLAN_ACCEPTED" || state === "EXECUTION_ENABLED") {
    return [...POST_PLAN_CAPABILITIES];
  }
  if (state === "BLOCKED_BUDGET") {
    return ["list", "original_prompt", "escalate"];
  }
  if (state === "FAILED" || state === "COMPLETED") {
    return ["list", "original_prompt"];
  }
  return [...PRE_PLAN_CAPABILITIES];
}

export function canExecuteMutation(state: RunState): boolean {
  return state === "PLAN_ACCEPTED" || state === "EXECUTION_ENABLED";
}
