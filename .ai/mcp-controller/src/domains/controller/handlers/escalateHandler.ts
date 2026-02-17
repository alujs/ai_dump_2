/**
 * Handler for verb="escalate"
 *
 * The agent calls this when it cannot gather enough evidence to meet
 * the 2-distinct-source minimum ([REF:EVIDENCE-POLICY]), or when it
 * identifies blocking reasons that prevent plan submission.
 *
 * The handler:
 *  1. Validates that blockingReasons + requestedEvidence are supplied
 *  2. Records an escalation event in the event store
 *  3. Returns structured guidance on what the agent should do next
 *     (which verbs to call, what symbols/files to look for)
 */
import type { VerbResult, SessionState } from "../types";
import type { EventStore } from "../../observability/eventStore";

export interface EscalateArgs {
  /** Why the agent is stuck — at least one reason required. */
  blockingReasons?: string[];
  /** What evidence the agent needs — e.g. "symbol definition for FooComponent" */
  requestedEvidence?: string[];
  /** Optional: symbols the agent has already found but couldn't trace further */
  knownSymbols?: string[];
  /** Optional: files the agent has already read */
  exploredFiles?: string[];
  /** Optional: free-text note from the agent explaining the situation */
  note?: string;
}

const EVIDENCE_FETCH_VERBS = [
  "read_file_lines — read a specific file + line range to gather code evidence",
  "lookup_symbol_definition — search for a symbol definition across the indexed codebase",
  "search_codebase_text — full-text search for a string pattern",
  "trace_symbol_graph — find related symbols/files near an anchor",
  "list_directory_contents — explore directory structure to find relevant modules",
  "fetch_jira_ticket — pull a Jira ticket for requirement-level citations",
  "fetch_api_spec — pull a Swagger/OpenAPI spec for API contract evidence",
] as const;

export async function handleEscalate(
  args: Record<string, unknown> | undefined,
  session: SessionState,
  eventStore: EventStore,
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const blockingReasons = asStringArray(args?.blockingReasons);
  const requestedEvidence = asStringArray(args?.requestedEvidence);
  const knownSymbols = asStringArray(args?.knownSymbols);
  const exploredFiles = asStringArray(args?.exploredFiles);
  const note = typeof args?.note === "string" ? args.note.trim() : undefined;

  /* ── Validate: at least one of blockingReasons or requestedEvidence ── */
  if (blockingReasons.length === 0 && requestedEvidence.length === 0) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error =
      "verb='escalate' requires at least one of: args.blockingReasons (array of strings explaining why you cannot proceed) " +
      "or args.requestedEvidence (array of strings describing what evidence you need). " +
      "Example: { blockingReasons: ['Cannot find definition of FooComponent'], " +
      "requestedEvidence: ['symbol definition for FooComponent', 'route config that loads FooModule'] }";
    result.missingFields = ["blockingReasons | requestedEvidence"];
    return { result, denyReasons };
  }

  /* ── Build guidance based on what the agent says is missing ── */
  const guidance: Array<{ action: string; detail: string }> = [];

  for (const reason of blockingReasons) {
    const lower = reason.toLowerCase();
    if (lower.includes("evidence") || lower.includes("citation") || lower.includes("source")) {
      guidance.push({
        action: "gather_more_evidence",
        detail: "Use read_file_lines, lookup_symbol_definition, fetch_jira_ticket, or fetch_api_spec to collect at least 2 distinct sources. "
          + "Each citation should reference a different origin (e.g., one from code, one from a Jira ticket or Swagger spec).",
      });
    }
    if (lower.includes("symbol") || lower.includes("definition") || lower.includes("cannot find")) {
      guidance.push({
        action: "symbol_search",
        detail: "Use lookup_symbol_definition with the symbol name, or search_codebase_text with a partial match. "
          + "Then use trace_symbol_graph to find related code. If the symbol might be in an unexplored directory, use list_directory_contents first.",
      });
    }
    if (lower.includes("route") || lower.includes("module") || lower.includes("federation")) {
      guidance.push({
        action: "trace_module_boundary",
        detail: "Use search_codebase_text to search for route configurations (loadChildren, loadRemoteModule). "
          + "Then read_file_lines the routing file to understand module boundaries.",
      });
    }
    if (lower.includes("scope") || lower.includes("file") || lower.includes("path")) {
      guidance.push({
        action: "explore_scope",
        detail: "Use list_directory_contents to explore the directory structure. Use list_scoped_files to check what's in worktree scope. "
          + "Use read_file_lines on files you find to gather evidence.",
      });
    }
  }

  // Default guidance if nothing specific matched
  if (guidance.length === 0) {
    guidance.push({
      action: "general_evidence_gathering",
      detail: "You need at least 2 distinct evidence sources to submit a plan. "
        + "Use any combination of: read_file_lines (code evidence), lookup_symbol_definition (symbol definitions), "
        + "fetch_jira_ticket (requirement citations), fetch_api_spec (API contract evidence). "
        + "Each source should be from a different origin.",
    });
  }

  /* ── Record escalation event ── */
  await eventStore.append({
    ts: new Date().toISOString(),
    type: "escalation",
    runSessionId: session.runSessionId,
    workId: session.workId,
    agentId: session.agentId,
    payload: {
      blockingReasons,
      requestedEvidence,
      knownSymbols,
      exploredFiles,
      note,
      turnCount: Object.values(session.actionCounts).reduce((a, b) => a + b, 0),
    },
  });

  /* ── Build response ── */
  result.escalation = {
    acknowledged: true,
    blockingReasons,
    requestedEvidence,
    guidance,
    evidenceRequirements: {
      minDistinctSources: 2,
      acceptedSourceTypes: [
      "code — from read_file_lines or lookup_symbol_definition (reference as file path + line)",
        "requirement — from fetch_jira_ticket (reference as JIRA issue key)",
        "api_contract — from fetch_api_spec (reference as Swagger operation ID or path)",
        "policy — from project policy documents (reference as policy file path)",
      ],
      lowEvidenceGuardAlternative:
        "If you genuinely cannot find 2 sources, you may set lowEvidenceGuard=true, " +
        "uncertaintyNote='<explain why>', and requiresHumanReview=true on the change node. " +
        "This flags the change for human review instead of blocking it.",
    },
    availableVerbs: [...EVIDENCE_FETCH_VERBS],
    sessionContext: {
      artifactsCollected: session.artifacts.length,
      exploredFiles: exploredFiles?.length ?? 0,
      knownSymbols: knownSymbols?.length ?? 0,
      currentState: session.state,
    },
  };

  return { result, denyReasons };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value];
  return [];
}
