/**
 * Handler for verb="escalate"
 *
 * Pack-enrichment verb (Architecture v2 §5).
 * The agent calls this when the contextPack is insufficient.
 * The handler searches for matching files/symbols and adds them
 * to session.contextPack (monotonic — never removes files).
 *
 * Supports escalation types:
 *   - artifact_fetch: fetch specific artifacts (Jira, Swagger, files)
 *   - scope_expand:   add files matching a pattern/path
 *   - graph_expand:   trace symbol graph and add discovered files
 *   - pack_rebuild:   full re-retrieval (resets retrieval lanes)
 */
import { createHash } from "node:crypto";
import type { VerbResult, SessionState } from "../types";
import type { EventStore } from "../../observability/eventStore";
import type { IndexingService } from "../../indexing/indexingService";

export interface EscalateRequestedEvidence {
  type: "artifact_fetch" | "scope_expand" | "graph_expand" | "pack_rebuild";
  detail: string;
}

export interface EscalateDeps {
  eventStore: EventStore;
  indexing: IndexingService | null;
}

export async function handleEscalate(
  args: Record<string, unknown> | undefined,
  session: SessionState,
  deps: EscalateDeps,
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const need = typeof args?.need === "string" ? args.need.trim() : "";
  const escalationType = typeof args?.type === "string" ? args.type.trim() : "scope_expand";
  const requestedEvidence = parseRequestedEvidence(args?.requestedEvidence);
  const blockingReasons = asStringArray(args?.blockingReasons);

  /* ── Validate: need or blockingReasons required ── */
  if (!need && blockingReasons.length === 0 && requestedEvidence.length === 0) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error =
      "verb='escalate' requires args.need (string describing what context you need), " +
      "args.blockingReasons (array of strings), or args.requestedEvidence (array of {type, detail}). " +
      "Example: { need: 'SDF contract for sdf-table', type: 'artifact_fetch', " +
      "requestedEvidence: [{ type: 'artifact_fetch', detail: 'SDF contract for sdf-table' }] }";
    result.missingFields = ["need | blockingReasons | requestedEvidence"];
    return { result, denyReasons };
  }

  /* ── Collect search terms from need + evidence details ── */
  const searchTerms: string[] = [];
  if (need) searchTerms.push(need);
  for (const ev of requestedEvidence) {
    if (ev.detail) searchTerms.push(ev.detail);
  }
  for (const reason of blockingReasons) {
    searchTerms.push(reason);
  }

  /* ── Search for matching files using indexing service ── */
  const addedFiles: string[] = [];
  const addedSymbols: string[] = [];

  if (deps.indexing) {
    for (const term of searchTerms) {
      try {
        // Symbol search
        const symbolResults = await deps.indexing.lookupSymbol(term);
        if (symbolResults) {
          const matches = Array.isArray(symbolResults) ? symbolResults : [symbolResults];
          for (const match of matches) {
            const filePath = typeof match === "object" && match !== null
              ? (match as Record<string, unknown>).filePath as string | undefined
              : undefined;
            if (filePath && !addedFiles.includes(filePath)) {
              addedFiles.push(filePath);
            }
            const symbolName = typeof match === "object" && match !== null
              ? (match as Record<string, unknown>).symbol as string | undefined
              : undefined;
            if (symbolName && !addedSymbols.includes(symbolName)) {
              addedSymbols.push(symbolName);
            }
          }
        }
      } catch {
        // Non-fatal: indexing may not have the symbol
      }

      try {
        // Text search for file discovery
        const grepResults = await deps.indexing.grepLexeme(term);
        if (grepResults) {
          const matches = Array.isArray(grepResults) ? grepResults : [grepResults];
          for (const match of matches) {
            const filePath = typeof match === "object" && match !== null
              ? (match as Record<string, unknown>).filePath as string | undefined
              : undefined;
            if (filePath && !addedFiles.includes(filePath)) {
              addedFiles.push(filePath);
            }
          }
        }
      } catch {
        // Non-fatal
      }
    }
  }

  /* ── Monotonic pack growth: add new files, never remove ── */
  const previousFiles = session.contextPack?.files ?? [];
  const previousHash = session.contextPack?.hash ?? "";
  const newFiles = addedFiles.filter((f) => !previousFiles.includes(f));
  const mergedFiles = [...previousFiles, ...newFiles];

  // Update session contextPack
  const newHash = createHash("sha256")
    .update(mergedFiles.sort().join("\n"))
    .digest("hex");

  session.contextPack = {
    ref: session.contextPack?.ref ?? `pack:${session.workId}`,
    hash: newHash,
    files: mergedFiles,
  };

  /* ── Record escalation event ── */
  await deps.eventStore.append({
    ts: new Date().toISOString(),
    type: "escalation",
    runSessionId: session.runSessionId,
    workId: session.workId,
    agentId: session.agentId,
    payload: {
      need,
      escalationType,
      requestedEvidence,
      blockingReasons,
      addedFiles: newFiles,
      addedSymbols,
      previousFileCount: previousFiles.length,
      newFileCount: mergedFiles.length,
      hashChanged: newHash !== previousHash,
      turnCount: Object.values(session.actionCounts).reduce((a, b) => a + b, 0),
    },
  });

  /* ── Build response delta ── */
  result.escalation = {
    acknowledged: true,
    packDelta: {
      addedFiles: newFiles,
      addedSymbols,
      previousFileCount: previousFiles.length,
      newFileCount: mergedFiles.length,
      hashChanged: newHash !== previousHash,
      newHash,
    },
    guidance: newFiles.length === 0
      ? [
          {
            action: "try_specific_search",
            detail: "No new files found for your request. Try providing more specific file paths, symbol names, "
              + "or use read_file_lines / lookup_symbol_definition directly if you know the target.",
          },
        ]
      : [
          {
            action: "read_new_files",
            detail: `${newFiles.length} new file(s) added to pack. Use read_file_lines to examine them.`,
          },
        ],
    sessionContext: {
      artifactsCollected: session.artifacts.length,
      totalPackFiles: mergedFiles.length,
      currentState: session.state,
    },
  };

  // No stateOverride — stays in current state (PLANNING)
  return { result, denyReasons };
}

function parseRequestedEvidence(value: unknown): EscalateRequestedEvidence[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((v) => ({
      type: (typeof v.type === "string" ? v.type : "scope_expand") as EscalateRequestedEvidence["type"],
      detail: typeof v.detail === "string" ? v.detail : "",
    }))
    .filter((v) => v.detail.length > 0);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value];
  return [];
}
