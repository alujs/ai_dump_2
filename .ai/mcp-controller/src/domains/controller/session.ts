import type { SessionState } from "./types";
import type { RunState, TurnRequest } from "../../contracts/controller";
import type { EventStore } from "../observability/eventStore";
import { ensureId } from "../../shared/ids";

export function createSession(
  runSessionId: string,
  workId: string,
  agentId: string
): SessionState {
  return {
    runSessionId,
    workId,
    agentId,
    state: "UNINITIALIZED",
    originalPrompt: "",
    rejectionCounts: {},
    actionCounts: {},
    usedTokens: 0,
    scopeAllowlist: null,
    artifacts: [],
  };
}

/**
 * Phase 7: Auto-assign an agentId if one is missing or empty.
 * Returns the provided agentId if valid, otherwise generates a new one.
 */
export function resolveAgentId(incomingAgentId: string | undefined): string {
  if (incomingAgentId && incomingAgentId.trim().length > 0) {
    return incomingAgentId;
  }
  return ensureId(undefined, "agent");
}

export function resolveOriginalPrompt(
  session: SessionState,
  incomingPrompt: string | undefined,
  events: EventStore
): string {
  if (!session.originalPrompt && incomingPrompt && incomingPrompt.trim().length > 0) {
    session.originalPrompt = incomingPrompt;
    return session.originalPrompt;
  }

  if (
    session.originalPrompt &&
    incomingPrompt &&
    incomingPrompt.trim().length > 0 &&
    incomingPrompt !== session.originalPrompt
  ) {
    void events.append({
      ts: new Date().toISOString(),
      type: "prompt_mismatch",
      runSessionId: session.runSessionId,
      workId: session.workId,
      agentId: session.agentId,
      payload: {
        expectedPrompt: session.originalPrompt,
        providedPrompt: incomingPrompt,
      },
    });
  }

  return session.originalPrompt;
}

export function extractLexemes(request: TurnRequest): string[] {
  const candidates = request.args?.lexemes;
  if (!Array.isArray(candidates)) return [];
  return candidates.map((item) => String(item).toLowerCase());
}

export function trackRejections(session: SessionState, denyReasons: string[]): void {
  for (const code of denyReasons) {
    session.rejectionCounts[code] = (session.rejectionCounts[code] ?? 0) + 1;
  }
}
