import type { VerbResult, SessionState } from "../types";
import type { EventStore } from "../../observability/eventStore";
import { RecipeRegistry, buildRecipeUsageEvent } from "../../recipes/recipeRegistry";
import { isRecord } from "../turnHelpers";

export async function handleRunRecipe(
  args: Record<string, unknown> | undefined,
  session: SessionState,
  events: EventStore,
  recipes: RecipeRegistry
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const recipeId = String(args?.recipeId ?? "");
  const planNodeId = String(args?.planNodeId ?? "");
  const validatedParams = isRecord(args?.validatedParams) ? args?.validatedParams : {};
  const artifactBundleRef = String(args?.artifactBundleRef ?? "");
  const diffSummaryRef = String(args?.diffSummaryRef ?? "");

  if (!recipeId || !planNodeId || !artifactBundleRef || !diffSummaryRef) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = `run_recipe requires all of: recipeId, planNodeId, artifactBundleRef, diffSummaryRef. Missing: ${[!recipeId && "recipeId", !planNodeId && "planNodeId", !artifactBundleRef && "artifactBundleRef", !diffSummaryRef && "diffSummaryRef"].filter(Boolean).join(", ")}. Available recipe IDs: 'replace_lexeme_in_file', 'run_targeted_validation'.`;
    result.missingFields = [!recipeId && "recipeId", !planNodeId && "planNodeId", !artifactBundleRef && "artifactBundleRef", !diffSummaryRef && "diffSummaryRef"].filter(Boolean);
    return { result, denyReasons };
  }

  const validation = recipes.validate(recipeId, validatedParams);
  if (!validation.ok) {
    denyReasons.push("PLAN_POLICY_VIOLATION");
    result.recipeError = validation.reason;
    return { result, denyReasons };
  }

  const usageEvent = buildRecipeUsageEvent({
    recipeId,
    validatedParams,
    workId: session.workId,
    runSessionId: session.runSessionId,
    planNodeId,
    artifactBundleRef,
    diffSummaryRef,
    validationOutcome: "passed",
  });

  await events.append({
    ts: new Date().toISOString(),
    type: "recipe_usage",
    runSessionId: session.runSessionId,
    workId: session.workId,
    agentId: session.agentId,
    payload: { ...usageEvent },
  });

  result.recipe = { accepted: true, recipeId, planNodeId };
  return { result, denyReasons };
}
