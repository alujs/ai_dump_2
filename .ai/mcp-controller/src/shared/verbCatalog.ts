/**
 * Verb catalog: one-line description + required/optional args for every
 * capability the controller exposes. Returned in every TurnResponse so
 * the agent always knows what it can call and how.
 */

export interface VerbDescriptor {
  /** Human-readable one-liner: what the verb does. */
  description: string;
  /** When should the agent call this verb? */
  whenToUse: string;
  /** Argument names the verb requires. */
  requiredArgs: string[];
  /** Optional argument names. */
  optionalArgs: string[];
}

const CATALOG: Record<string, VerbDescriptor> = {
  list_available_verbs: {
    description: "List all verbs available in the current run-state, with descriptions and argument schemas.",
    whenToUse: "At the start of a session or when unsure what verbs are available.",
    requiredArgs: [],
    optionalArgs: [],
  },
  list_scoped_files: {
    description: "List files in scope for reading/patching within the current work unit.",
    whenToUse: "Before reading or patching, to discover which files you have access to.",
    requiredArgs: [],
    optionalArgs: [],
  },
  list_directory_contents: {
    description: "List entries (files and folders) in a directory within the allowed scope.",
    whenToUse: "To explore folder structure before reading specific files.",
    requiredArgs: [],
    optionalArgs: ["targetDir"],
  },
  read_file_lines: {
    description: "Read a line range from a file within the allowed scope. Returns the source code content.",
    whenToUse: "When you need to see specific source code to gather evidence for your plan.",
    requiredArgs: ["filePath"],
    optionalArgs: ["startLine", "endLine"],
  },
  lookup_symbol_definition: {
    description: "Look up a symbol (function, class, variable) in the code index. Returns its definition location and signature.",
    whenToUse: "When you know a symbol name and need its definition or location.",
    requiredArgs: ["symbol"],
    optionalArgs: ["fileHint"],
  },
  trace_symbol_graph: {
    description: "Find symbols related to a given symbol via the code graph (callers, callees, imports, dependencies).",
    whenToUse: "When tracing how a symbol is used or what depends on it.",
    requiredArgs: ["symbol"],
    optionalArgs: ["direction", "depth"],
  },
  search_codebase_text: {
    description: "Search files for a text pattern (exact or regex) within scope. Returns matching lines with context.",
    whenToUse: "When searching for code patterns, string literals, or identifiers across the codebase.",
    requiredArgs: ["pattern"],
    optionalArgs: ["isRegex", "fileGlob", "maxResults"],
  },
  fetch_jira_ticket: {
    description: "Fetch a Jira ticket by key. Returns ticket summary, description, acceptance criteria, and labels.",
    whenToUse: "When the work references a Jira ticket and you need its requirements.",
    requiredArgs: ["ticketKey"],
    optionalArgs: [],
  },
  fetch_api_spec: {
    description: "Fetch an OpenAPI/Swagger spec by URL or alias. Returns endpoint schemas and contracts.",
    whenToUse: "When the work involves API endpoints and you need the API contract.",
    requiredArgs: ["specUrl"],
    optionalArgs: [],
  },
  get_original_prompt: {
    description: "Retrieve the original user prompt for this work unit.",
    whenToUse: "When you need to re-read the original task description.",
    requiredArgs: [],
    optionalArgs: [],
  },
  write_scratch_file: {
    description: "Write a temporary file to the scratch area (not the worktree). For intermediate drafts, not final patches.",
    whenToUse: "To store intermediate data or drafts that are not final patches.",
    requiredArgs: ["fileName", "content"],
    optionalArgs: [],
  },
  submit_execution_plan: {
    description: "Submit an execution plan (PlanGraphDocument) for validation. Must include evidence citations from at least 2 distinct sources.",
    whenToUse: "After gathering enough evidence (minimum 2 distinct sources), submit your plan to advance to execution state.",
    requiredArgs: ["plan"],
    optionalArgs: [],
  },
  request_evidence_guidance: {
    description: "Signal that you are stuck and need guidance on gathering evidence. Returns targeted advice, available evidence-gathering verbs, and the evidence threshold you must meet.",
    whenToUse: "When you cannot find enough evidence to submit a plan, when you are unsure what to do next, or when your plan was denied for insufficient evidence.",
    requiredArgs: ["blockingReasons"],
    optionalArgs: ["requestedEvidence", "knownSymbols", "exploredFiles", "note"],
  },
  apply_code_patch: {
    description: "Apply a structured code patch to a file in the worktree. Requires an accepted execution plan.",
    whenToUse: "After your plan is accepted, to make the actual code changes.",
    requiredArgs: ["filePath", "patch"],
    optionalArgs: [],
  },
  run_sandboxed_code: {
    description: "Run a sandboxed code snippet (IIFE) in the project context. Requires an accepted execution plan.",
    whenToUse: "After your plan is accepted, to run builds, tests, or scripts.",
    requiredArgs: ["command"],
    optionalArgs: ["cwd", "timeout"],
  },
  execute_gated_side_effect: {
    description: "Execute a gated side-effect action (e.g. git commit) that requires an approved commit gate. Requires an accepted execution plan.",
    whenToUse: "After your plan is accepted, for operations that modify external state.",
    requiredArgs: ["action"],
    optionalArgs: ["args"],
  },
  run_automation_recipe: {
    description: "Run a named automation recipe (e.g. scaffold, migrate, replace_lexeme_in_file).",
    whenToUse: "When a pre-built recipe exists for the task.",
    requiredArgs: ["recipeName"],
    optionalArgs: ["recipeArgs"],
  },
  signal_task_complete: {
    description: "Signal that all implementation tasks are complete and trigger a session retrospective. Returns a friction digest, pending memory candidates, and suggestions for the user.",
    whenToUse: "When all planned implementation work is done and you want to generate a retrospective summary for the user.",
    requiredArgs: [],
    optionalArgs: ["summary", "lessonsLearned"],
  },
};

/**
 * Return verb descriptors for the given list of capability names.
 * Unknown verbs are included with a generic fallback descriptor.
 */
export function verbDescriptionsForCapabilities(
  capabilities: string[]
): Record<string, VerbDescriptor> {
  const result: Record<string, VerbDescriptor> = {};
  for (const cap of capabilities) {
    result[cap] = CATALOG[cap] ?? {
      description: `Execute the '${cap}' verb.`,
      whenToUse: "Refer to controller documentation.",
      requiredArgs: [],
      optionalArgs: [],
    };
  }
  return result;
}
