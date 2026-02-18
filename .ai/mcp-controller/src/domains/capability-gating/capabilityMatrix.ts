import type { RunState } from "../../contracts/controller";
import { POST_PLAN_CAPABILITIES, PRE_PLAN_CAPABILITIES, UNINITIALIZED_CAPABILITIES } from "../../shared/constants";

export function capabilitiesForState(state: RunState): string[] {
  if (state === "UNINITIALIZED") {
    return [...UNINITIALIZED_CAPABILITIES];
  }
  if (state === "PLAN_ACCEPTED") {
    return [...POST_PLAN_CAPABILITIES];
  }
  if (state === "BLOCKED_BUDGET") {
    return ["initialize_work", "escalate", "signal_task_complete"];
  }
  if (state === "FAILED" || state === "COMPLETED") {
    return ["signal_task_complete"];
  }
  // PLANNING gets pre-plan capabilities
  return [...PRE_PLAN_CAPABILITIES];
}

export function canExecuteMutation(state: RunState): boolean {
  return state === "PLAN_ACCEPTED";
}
