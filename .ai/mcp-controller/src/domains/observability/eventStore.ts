import { EventEmitter } from "node:events";
import path from "node:path";
import { observabilityRoot } from "../../shared/fsPaths";
import { appendJsonl } from "../../shared/fileStore";

export interface ObservabilityEvent {
  ts: string;
  type: string;
  runSessionId: string;
  workId: string;
  agentId: string;
  payload: Record<string, unknown>;
}

export class EventStore {
  private readonly emitter = new EventEmitter();
  private readonly recentEvents: ObservabilityEvent[] = [];

  async append(event: ObservabilityEvent): Promise<void> {
    const filePath = path.join(observabilityRoot(), "events.jsonl");
    await appendJsonl(filePath, event);
    this.recentEvents.push(event);
    if (this.recentEvents.length > 5000) {
      this.recentEvents.shift();
    }
    this.emitter.emit("event", event);
  }

  onEvent(listener: (event: ObservabilityEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  listRecent(limit = 200): ObservabilityEvent[] {
    return this.recentEvents.slice(-Math.max(1, limit));
  }

  listErrors(limit = 200): ObservabilityEvent[] {
    return this.recentEvents
      .filter((event) => {
        const denyReasons = event.payload.denyReasons;
        return Array.isArray(denyReasons) && denyReasons.length > 0;
      })
      .slice(-Math.max(1, limit));
  }

  listPendingCorrections(limit = 200): ObservabilityEvent[] {
    return this.recentEvents
      .filter((event) => event.type === "pending_correction_created")
      .slice(-Math.max(1, limit));
  }

  rejectionHeatmap(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.recentEvents) {
      const denyReasons = event.payload.denyReasons;
      if (!Array.isArray(denyReasons)) {
        continue;
      }
      for (const code of denyReasons) {
        const key = String(code);
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }

  rejectionTrend(): Array<{ day: string; count: number }> {
    const perDay: Record<string, number> = {};
    for (const event of this.recentEvents) {
      const denyReasons = event.payload.denyReasons;
      if (!Array.isArray(denyReasons) || denyReasons.length === 0) {
        continue;
      }
      const day = event.ts.slice(0, 10);
      perDay[day] = (perDay[day] ?? 0) + denyReasons.length;
    }
    return Object.entries(perDay)
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  topRejectionSignatures(limit = 20): Array<{ signature: string; count: number }> {
    const counts: Record<string, number> = {};
    for (const event of this.recentEvents) {
      const denyReasons = event.payload.denyReasons;
      if (!Array.isArray(denyReasons)) {
        continue;
      }
      const strategy = String(event.payload.strategy ?? "unknown_strategy");
      const module = String(event.payload.module ?? "unknown_module");
      for (const denyReason of denyReasons) {
        const signature = `${strategy}|${module}|${String(denyReason)}`;
        counts[signature] = (counts[signature] ?? 0) + 1;
      }
    }

    return Object.entries(counts)
      .map(([signature, count]) => ({ signature, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(1, limit));
  }

  retrievalHotspots(limit = 20): Array<{ anchorType: string; count: number }> {
    const counts: Record<string, number> = {};
    for (const event of this.recentEvents) {
      const missingAnchors = event.payload.packMissingAnchors;
      if (!Array.isArray(missingAnchors)) {
        continue;
      }
      for (const item of missingAnchors) {
        const anchorType = String((item as { anchorType?: string }).anchorType ?? "unknown_anchor");
        counts[anchorType] = (counts[anchorType] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([anchorType, count]) => ({ anchorType, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(1, limit));
  }
}
