/**
 * Retrospective handler — generates a session digest when the agent
 * signals task completion via signal_task_complete.
 *
 * Produces:
 *   - Friction summary (rejection heatmap, top signatures, hotspots)
 *   - Pending memory candidates (for human review)
 *   - Session statistics (turn count, verb distribution)
 *   - Suggestions for memory creation
 */

import type { VerbResult, SessionState } from "../types";
import type { EventStore } from "../../observability/eventStore";
import type { MemoryService } from "../../memory/memoryService";

export async function handleSignalTaskComplete(
  args: Record<string, unknown> | undefined,
  session: SessionState,
  eventStore: EventStore,
  memoryService: MemoryService,
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  const summary = String(args?.summary ?? "").trim();
  const lessonsLearned = args?.lessonsLearned;

  /* ── Gate: reject if plan nodes remain incomplete (§8) ── */
  if (session.planGraphProgress) {
    const remaining = session.planGraphProgress.totalNodes - session.planGraphProgress.completedNodes;
    if (remaining > 0) {
      const allNodeIds = session.planGraph?.nodes
        ?.filter((n: { kind: string }) => n.kind === "change" || n.kind === "validate" || n.kind === "side_effect")
        .map((n: { nodeId: string }) => n.nodeId) ?? [];
      const incompleteNodeIds = allNodeIds.filter(
        (id: string) => !session.planGraphProgress!.completedNodeIds.includes(id)
      );
      denyReasons.push("WORK_INCOMPLETE");
      result.error = `Cannot signal task complete: ${remaining} plan node(s) remain incomplete.`;
      result.remainingNodes = incompleteNodeIds;
      result.progress = {
        totalNodes: session.planGraphProgress.totalNodes,
        completedNodes: session.planGraphProgress.completedNodes,
        remainingNodes: remaining,
      };
      return { result, denyReasons };
    }
  }

  /* ── Friction digest ───────────────────────────────────── */

  const rejectionHeatmap = eventStore.rejectionHeatmap();
  const topSignatures = eventStore.topRejectionSignatures(10);
  const hotspots = eventStore.retrievalHotspots(10);
  const trend = eventStore.rejectionTrend();
  const pendingCorrections = eventStore.listPendingCorrections(50);

  /* ── Memory candidates ─────────────────────────────────── */

  const pendingMemories = await memoryService.findByState("pending");
  const provisionalMemories = await memoryService.findByState("provisional");
  const approvedMemories = await memoryService.findByState("approved");

  /* ── Session stats ─────────────────────────────────────── */

  const totalTurns = Object.values(session.actionCounts).reduce((sum, c) => sum + c, 0);
  const totalRejections = Object.values(session.rejectionCounts).reduce((sum, c) => sum + c, 0);

  /* ── Build digest ──────────────────────────────────────── */

  result.retrospective = {
    sessionSummary: {
      runSessionId: session.runSessionId,
      workId: session.workId,
      agentId: session.agentId,
      totalTurns,
      totalRejections,
      verbDistribution: { ...session.actionCounts },
      rejectionDistribution: { ...session.rejectionCounts },
      agentProvidedSummary: summary || null,
      lessonsLearned: lessonsLearned ?? null,
    },
    frictionDigest: {
      rejectionHeatmap,
      topSignatures,
      retrievalHotspots: hotspots,
      trend,
      pendingCorrectionCount: pendingCorrections.length,
    },
    memoryStatus: {
      pending: pendingMemories.map((m) => ({
        id: m.id,
        enforcementType: m.enforcementType,
        trigger: m.trigger,
        domainAnchorIds: m.domainAnchorIds,
        rejectionCodes: m.rejectionCodes,
        note: m.note ?? m.fewShot?.instruction ?? m.planRule?.condition ?? m.strategySignal?.reason ?? "",
        scaffolded: m.fewShot?.scaffolded ?? false,
        createdAt: m.createdAt,
      })),
      provisional: provisionalMemories.map((m) => ({
        id: m.id,
        enforcementType: m.enforcementType,
        trigger: m.trigger,
        note: m.note ?? m.fewShot?.instruction ?? "",
      })),
      approvedCount: approvedMemories.length,
    },
    suggestions: buildSuggestions(rejectionHeatmap, topSignatures, pendingMemories),
  };

  result.message = "Session retrospective generated. Review the friction digest and pending memory candidates. "
    + "Scaffolded few-shot memories need human-supplied 'after' and 'whyWrong' fields. "
    + "Drop JSON files in .ai/memory/overrides/ to create memories directly.";

  return { result, denyReasons, stateOverride: "COMPLETED" };
}

function buildSuggestions(
  heatmap: Record<string, number>,
  topSignatures: Array<{ signature: string; count: number }>,
  pendingMemories: import("../../../contracts/memoryRecord").MemoryRecord[],
): string[] {
  const suggestions: string[] = [];

  const highFrictionCodes = Object.entries(heatmap)
    .filter(([, count]) => count >= 5)
    .map(([code]) => code);

  if (highFrictionCodes.length > 0) {
    suggestions.push(
      `High-frequency rejection codes: [${highFrictionCodes.join(", ")}]. Consider creating plan_rule memories to prevent these patterns.`
    );
  }

  if (topSignatures.length > 0 && topSignatures[0].count >= 3) {
    suggestions.push(
      `Top friction signature: "${topSignatures[0].signature}" (${topSignatures[0].count}x). This is a candidate for a few-shot example.`
    );
  }

  const scaffolded = pendingMemories.filter((m) => m.fewShot?.scaffolded);
  if (scaffolded.length > 0) {
    suggestions.push(
      `${scaffolded.length} scaffolded few-shot memory record(s) need human review: fill in 'after' and 'whyWrong' fields.`
    );
  }

  if (suggestions.length === 0) {
    suggestions.push("No significant friction patterns detected. Session was clean.");
  }

  return suggestions;
}
