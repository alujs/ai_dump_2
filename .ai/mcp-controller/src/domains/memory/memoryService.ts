/**
 * MemoryService — manages MemoryRecord lifecycle.
 *
 * Replaces the old MemoryPromotionService with a dimensioned memory system.
 * Records are stored as JSON (for local persistence) and can be exported
 * as graph seed data for Neo4j upsert.
 *
 * Responsibilities:
 *   - Create memory records from friction signals, human overrides, retrospectives
 *   - Transition state (pending → provisional → approved/rejected/expired)
 *   - Query active memories by domain anchor intersection
 *   - Auto-promote based on config rules
 *   - Scaffold few-shot records from rejection data
 */

import path from "node:path";
import { readText, writeText, appendJsonl } from "../../shared/fileStore";
import { ensureId } from "../../shared/ids";
import { resolveRepoRoot } from "../../shared/fsPaths";
import { MEMORY_CONFIG, type MemoryConfig } from "./config";
import type {
  MemoryRecord,
  MemoryTrigger,
  MemoryPhase,
  MemoryEnforcementType,
  MemoryState,
  FewShotExample,
  PlanRule,
  StrategySignal,
  FrictionLedgerEntry,
} from "../../contracts/memoryRecord";

/* ── Paths ───────────────────────────────────────────────── */

function memoryStorePath(): string {
  return path.join(resolveRepoRoot(), ".ai", "memory", "records.json");
}

function frictionLedgerPath(): string {
  return path.join(resolveRepoRoot(), ".ai", "tmp", "friction-ledger.jsonl");
}

function changelogPath(): string {
  return path.join(resolveRepoRoot(), ".ai", "memory", "changelog.jsonl");
}

function overridesDir(): string {
  return path.join(resolveRepoRoot(), ".ai", "memory", "overrides");
}

/* ── Main service class ──────────────────────────────────── */

export class MemoryService {
  private readonly config: MemoryConfig;

  constructor(config?: MemoryConfig) {
    this.config = config ?? MEMORY_CONFIG;
  }

  /* ── Create ────────────────────────────────────────────── */

  /**
   * Create a new memory record from a friction event.
   * This is the primary entry point for the 3x rejection pattern.
   */
  async createFromFriction(input: {
    trigger: MemoryTrigger;
    phase: MemoryPhase;
    domainAnchorIds: string[];
    rejectionCodes: string[];
    originStrategyId: string;
    enforcementType: MemoryEnforcementType;
    traceRef: string;
    sessionId: string;
    workId: string;
    agentId: string;
    fewShot?: FewShotExample;
    planRule?: PlanRule;
    strategySignal?: StrategySignal;
    note?: string;
    graphNodeIds?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<MemoryRecord> {
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: ensureId(undefined, "mem"),
      label: "MemoryRecord",
      trigger: input.trigger,
      phase: input.phase,
      domainAnchorIds: input.domainAnchorIds,
      graphNodeIds: input.graphNodeIds ?? [],
      rejectionCodes: input.rejectionCodes,
      originStrategyId: input.originStrategyId,
      enforcementType: input.enforcementType,
      fewShot: input.fewShot,
      planRule: input.planRule,
      strategySignal: input.strategySignal,
      note: input.note,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      traceRef: input.traceRef,
      originSessionId: input.sessionId,
      originWorkId: input.workId,
      originAgentId: input.agentId,
      metadata: input.metadata ?? {},
    };

    const records = await this.readAll();
    records.push(record);
    await this.writeAll(records);

    // Log to friction ledger
    if (this.config.enableFrictionLedger) {
      await this.logFriction({
        ts: now,
        trigger: input.trigger,
        rejectionCodes: input.rejectionCodes,
        domainAnchorIds: input.domainAnchorIds,
        memoryId: record.id,
        rejectionCount: (input.metadata?.rejectionCount as number) ?? 0,
        resolved: false,
        strategyId: input.originStrategyId,
        sessionId: input.sessionId,
        workId: input.workId,
      });
    }

    return record;
  }

  /**
   * Create a memory record from a human override file.
   * Bypasses the pending lifecycle — goes straight to config-defined initial state.
   */
  async createFromHumanOverride(input: {
    domainAnchorIds: string[];
    enforcementType: MemoryEnforcementType;
    fewShot?: FewShotExample;
    planRule?: PlanRule;
    strategySignal?: StrategySignal;
    note?: string;
    traceRef: string;
  }): Promise<MemoryRecord> {
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: ensureId(undefined, "mem"),
      label: "MemoryRecord",
      trigger: "human_override",
      phase: "retrospective",
      domainAnchorIds: input.domainAnchorIds,
      graphNodeIds: [],
      rejectionCodes: [],
      originStrategyId: "human",
      enforcementType: input.enforcementType,
      fewShot: input.fewShot,
      planRule: input.planRule,
      strategySignal: input.strategySignal,
      note: input.note,
      state: this.config.humanOverrideInitialState,
      createdAt: now,
      updatedAt: now,
      traceRef: input.traceRef,
      originSessionId: "human",
      originWorkId: "human",
      originAgentId: "human",
      metadata: { source: "file_drop" },
    };

    const records = await this.readAll();
    records.push(record);
    await this.writeAll(records);

    // Log to changelog
    await this.logChangelog({
      ts: now,
      action: "human_override_created",
      memoryId: record.id,
      enforcementType: input.enforcementType,
      note: input.note ?? "",
    });

    return record;
  }

  /* ── Query ─────────────────────────────────────────────── */

  /**
   * Find all active (approved or provisional) memories that apply
   * to the given domain anchor IDs. This is the main query used
   * during context pack assembly and plan validation.
   */
  async findActiveForAnchors(anchorIds: string[]): Promise<MemoryRecord[]> {
    const all = await this.readAll();
    const anchorSet = new Set(anchorIds);
    return all.filter((record) => {
      if (record.state !== "approved" && record.state !== "provisional") return false;
      return record.domainAnchorIds.some((id) => anchorSet.has(id));
    });
  }

  /**
   * Find all memories in a specific state.
   */
  async findByState(state: MemoryState): Promise<MemoryRecord[]> {
    const all = await this.readAll();
    return all.filter((record) => record.state === state);
  }

  /**
   * List all memories.
   */
  async listAll(): Promise<MemoryRecord[]> {
    return this.readAll();
  }

  /* ── State transitions ─────────────────────────────────── */

  /**
   * Transition a memory to a new state.
   */
  async transition(id: string, nextState: MemoryState, reason?: string): Promise<MemoryRecord | null> {
    const records = await this.readAll();
    const record = records.find((r) => r.id === id);
    if (!record) return null;

    record.state = nextState;
    record.updatedAt = new Date().toISOString();
    record.transitionReason = reason;
    await this.writeAll(records);

    // If approved, mark friction as resolved
    if (nextState === "approved" && this.config.enableFrictionLedger) {
      await this.resolveFriction(id);
    }

    return record;
  }

  /**
   * Run auto-promotion: pending → provisional (if eligible and past contest window).
   * Only auto-promotes enforcement types listed in config.autoPromotableEnforcementTypes.
   */
  async runAutoPromotion(now = new Date()): Promise<MemoryRecord[]> {
    const records = await this.readAll();
    const changed: MemoryRecord[] = [];
    const contestMs = this.config.contestWindowHours * 60 * 60 * 1000;
    const expiryMs = this.config.provisionalExpiryHours * 60 * 60 * 1000;

    for (const record of records) {
      // pending → provisional (if auto-promotable and past contest window)
      if (record.state === "pending") {
        const isAutoPromotable = this.config.autoPromotableEnforcementTypes.includes(record.enforcementType as any);
        const needsHuman = this.config.humanApprovalRequired.includes(record.enforcementType as any);
        if (isAutoPromotable && !needsHuman) {
          const ageMs = now.getTime() - new Date(record.createdAt).getTime();
          if (ageMs >= contestMs) {
            record.state = "provisional";
            record.updatedAt = now.toISOString();
            record.transitionReason = "Auto-promoted: past contest window";
            changed.push(record);
          }
        }
      }
      // provisional → expired (if past expiry window without approval)
      else if (record.state === "provisional") {
        const ageMs = now.getTime() - new Date(record.updatedAt).getTime();
        if (ageMs >= expiryMs) {
          record.state = "expired";
          record.updatedAt = now.toISOString();
          record.transitionReason = "Expired: past provisional window without approval";
          changed.push(record);
        }
      }
    }

    if (changed.length > 0) {
      await this.writeAll(records);
    }
    return changed;
  }

  /* ── Human override file scanning ──────────────────────── */

  /**
   * Scan .ai/memory/overrides/ for JSON files and ingest them as memories.
   * Each file is processed once and renamed with a .processed suffix.
   */
  async ingestOverrideFiles(): Promise<MemoryRecord[]> {
    const dir = overridesDir();
    const { readdir } = await import("node:fs/promises");
    let entries: string[];
    try {
      const dirEntries = await readdir(dir);
      entries = dirEntries.filter((f) => f.endsWith(".json"));
    } catch {
      return []; // Directory doesn't exist yet
    }

    const created: MemoryRecord[] = [];
    const { rename } = await import("node:fs/promises");

    for (const file of entries) {
      const filePath = path.join(dir, file);
      try {
        const raw = await readText(filePath);
        const data = JSON.parse(raw) as {
          domainAnchorIds?: string[];
          enforcementType?: MemoryEnforcementType;
          fewShot?: FewShotExample;
          planRule?: PlanRule;
          strategySignal?: StrategySignal;
          note?: string;
        };

        const record = await this.createFromHumanOverride({
          domainAnchorIds: data.domainAnchorIds ?? [],
          enforcementType: data.enforcementType ?? "informational",
          fewShot: data.fewShot,
          planRule: data.planRule,
          strategySignal: data.strategySignal,
          note: data.note,
          traceRef: `override:${file}`,
        });
        created.push(record);

        // Rename to .processed so it's not ingested again
        await rename(filePath, `${filePath}.processed`);
      } catch {
        // Malformed file, skip
      }
    }

    return created;
  }

  /* ── Friction ledger ───────────────────────────────────── */

  private async logFriction(entry: FrictionLedgerEntry): Promise<void> {
    await appendJsonl(frictionLedgerPath(), entry);
  }

  private async resolveFriction(memoryId: string): Promise<void> {
    // We append a resolution entry rather than modifying existing lines
    await appendJsonl(frictionLedgerPath(), {
      ts: new Date().toISOString(),
      action: "friction_resolved",
      memoryId,
      resolvedAt: new Date().toISOString(),
    });
  }

  /* ── Changelog ─────────────────────────────────────────── */

  private async logChangelog(entry: Record<string, unknown>): Promise<void> {
    await appendJsonl(changelogPath(), entry);
  }

  /* ── Few-shot scaffolding ──────────────────────────────── */

  /**
   * Auto-scaffold a few-shot memory from a rejection pattern.
   * Populates the `before` from the rejected data, leaves `after` for human.
   */
  async scaffoldFewShot(input: {
    rejectionCode: string;
    domainAnchorIds: string[];
    originStrategyId: string;
    traceRef: string;
    sessionId: string;
    workId: string;
    agentId: string;
    rejectedContent?: string;
    targetFile?: string;
    rejectionCount: number;
  }): Promise<MemoryRecord> {
    const fewShot: FewShotExample = {
      instruction: `[AUTO-SCAFFOLDED] Repeated ${input.rejectionCode} in this domain. Fill in the correct 'after' and 'whyWrong'.`,
      before: input.rejectedContent ?? "[No content captured — fill in manually]",
      after: "[TODO: Fill in the correct version]",
      antiPattern: input.rejectedContent,
      whyWrong: "[TODO: Explain why the rejected pattern is wrong]",
      applicableFilePaths: input.targetFile ? [input.targetFile] : undefined,
      scaffolded: true,
    };

    return this.createFromFriction({
      trigger: "rejection_pattern",
      phase: "execution",
      domainAnchorIds: input.domainAnchorIds,
      rejectionCodes: [input.rejectionCode],
      originStrategyId: input.originStrategyId,
      enforcementType: "few_shot",
      fewShot,
      traceRef: input.traceRef,
      sessionId: input.sessionId,
      workId: input.workId,
      agentId: input.agentId,
      metadata: { rejectionCount: input.rejectionCount, scaffolded: true },
    });
  }

  /* ── Graph seed export ─────────────────────────────────── */

  /**
   * Export all active memories as JSONL seed data for graphOps.
   * This allows memories to be upserted into Neo4j as MemoryRecord nodes
   * with :APPLIES_TO relationships to DomainAnchor nodes.
   */
  async exportAsGraphSeed(outPath: string): Promise<number> {
    const records = await this.readAll();
    const active = records.filter((r) => r.state === "approved" || r.state === "provisional");
    let written = 0;

    for (const record of active) {
      // Write the memory node
      await appendJsonl(outPath, {
        kind: "node",
        id: record.id,
        labels: ["Entity", "MemoryRecord"],
        properties: {
          id: record.id,
          trigger: record.trigger,
          phase: record.phase,
          enforcementType: record.enforcementType,
          state: record.state,
          rejectionCodes: JSON.stringify(record.rejectionCodes),
          originStrategyId: record.originStrategyId,
          note: record.note ?? "",
          fewShot: record.fewShot ? JSON.stringify(record.fewShot) : "",
          planRule: record.planRule ? JSON.stringify(record.planRule) : "",
          strategySignal: record.strategySignal ? JSON.stringify(record.strategySignal) : "",
          updated_at: record.updatedAt,
          updated_by: "memory-service",
        },
      });
      written++;

      // Write :APPLIES_TO relationships
      for (const anchorId of record.domainAnchorIds) {
        await appendJsonl(outPath, {
          kind: "relationship",
          from: { id: record.id, label: "MemoryRecord" },
          to: { id: anchorId, label: "DomainAnchor" },
          relType: "APPLIES_TO",
          properties: { updated_at: record.updatedAt, updated_by: "memory-service" },
        });
      }
    }

    return written;
  }

  /* ── Persistence ───────────────────────────────────────── */

  private async readAll(): Promise<MemoryRecord[]> {
    try {
      const raw = await readText(memoryStorePath());
      const parsed = JSON.parse(raw) as MemoryRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeAll(records: MemoryRecord[]): Promise<void> {
    await writeText(memoryStorePath(), JSON.stringify(records, null, 2));
  }
}
