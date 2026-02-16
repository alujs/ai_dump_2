export interface RecipeDefinition {
  id: string;
  description: string;
  requiredParams: string[];
}

export interface RecipeUsageEvent {
  recipeId: string;
  validatedParams: Record<string, unknown>;
  workId: string;
  runSessionId: string;
  planNodeId: string;
  artifactBundleRef: string;
  diffSummaryRef: string;
  validationOutcome: "passed" | "failed";
  failureSignature?: string;
}

const BUILTIN_RECIPES: RecipeDefinition[] = [
  {
    id: "replace_lexeme_in_file",
    description: "Replace a lexeme in a target file using structured patch rules.",
    requiredParams: ["targetFile", "find", "replace"]
  },
  {
    id: "run_targeted_validation",
    description: "Run deterministic validation command and capture artifact output.",
    requiredParams: ["command", "artifactOutputRef"]
  }
];

export class RecipeRegistry {
  private readonly definitions = new Map(BUILTIN_RECIPES.map((item) => [item.id, item]));

  list(): RecipeDefinition[] {
    return [...this.definitions.values()];
  }

  validate(recipeId: string, params: Record<string, unknown>): { ok: boolean; reason?: string } {
    const recipe = this.definitions.get(recipeId);
    if (!recipe) {
      return { ok: false, reason: "Unknown recipeId." };
    }
    for (const key of recipe.requiredParams) {
      if (!(key in params)) {
        return { ok: false, reason: `Missing recipe param '${key}'.` };
      }
    }
    return { ok: true };
  }
}

export function buildRecipeUsageEvent(input: RecipeUsageEvent): RecipeUsageEvent {
  return {
    recipeId: input.recipeId,
    validatedParams: input.validatedParams,
    workId: input.workId,
    runSessionId: input.runSessionId,
    planNodeId: input.planNodeId,
    artifactBundleRef: input.artifactBundleRef,
    diffSummaryRef: input.diffSummaryRef,
    validationOutcome: input.validationOutcome,
    failureSignature: input.failureSignature
  };
}
