import path from "node:path";
import { readText, writeText } from "../../shared/fileStore";
import { ensureId } from "../../shared/ids";
import { resolveRepoRoot } from "../../shared/fsPaths";

export type PromotionState = "pending" | "provisional" | "approved" | "rejected" | "expired";
export type PromotionKind = "lexeme_alias" | "retrieval_tuning" | "strategy_hint" | "policy_rule";

export interface PromotionItem {
  id: string;
  kind: PromotionKind;
  state: PromotionState;
  createdAt: string;
  updatedAt: string;
  traceRef: string;
  reason: string;
  metadata: Record<string, unknown>;
}

const CONTEST_WINDOW_HOURS = 48;

export class MemoryPromotionService {
  constructor(private readonly filePath = path.join(resolveRepoRoot(), ".ai", "tmp", "memory", "promotion_items.json")) {}

  async createPending(input: {
    kind: PromotionKind;
    traceRef: string;
    reason: string;
    metadata: Record<string, unknown>;
  }): Promise<PromotionItem> {
    const now = new Date().toISOString();
    const item: PromotionItem = {
      id: ensureId(undefined, "promotion"),
      kind: input.kind,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      traceRef: input.traceRef,
      reason: input.reason,
      metadata: input.metadata
    };
    const current = await this.readAll();
    current.push(item);
    await this.writeAll(current);
    return item;
  }

  async list(state?: PromotionState): Promise<PromotionItem[]> {
    const all = await this.readAll();
    if (!state) {
      return all;
    }
    return all.filter((item) => item.state === state);
  }

  async transition(input: { id: string; nextState: PromotionState; reason?: string }): Promise<PromotionItem | null> {
    const current = await this.readAll();
    const item = current.find((entry) => entry.id === input.id);
    if (!item) {
      return null;
    }
    item.state = input.nextState;
    item.updatedAt = new Date().toISOString();
    if (input.reason) {
      item.metadata.transitionReason = input.reason;
    }
    await this.writeAll(current);
    return item;
  }

  async runAutoPromotion(now = new Date()): Promise<PromotionItem[]> {
    const current = await this.readAll();
    const changed: PromotionItem[] = [];
    const contestWindowMs = CONTEST_WINDOW_HOURS * 60 * 60 * 1000;

    for (const item of current) {
      if (item.state === "pending" && isProvisionalEligible(item.kind)) {
        const ageMs = now.getTime() - new Date(item.createdAt).getTime();
        if (ageMs >= contestWindowMs) {
          item.state = "provisional";
          item.updatedAt = now.toISOString();
          changed.push(item);
        }
      } else if (item.state === "provisional") {
        const ageMs = now.getTime() - new Date(item.updatedAt).getTime();
        if (ageMs >= contestWindowMs) {
          item.state = "expired";
          item.updatedAt = now.toISOString();
          changed.push(item);
        }
      }
    }

    if (changed.length > 0) {
      await this.writeAll(current);
    }
    return changed;
  }

  private async readAll(): Promise<PromotionItem[]> {
    try {
      const raw = await readText(this.filePath);
      const parsed = JSON.parse(raw) as PromotionItem[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeAll(items: PromotionItem[]): Promise<void> {
    await writeText(this.filePath, JSON.stringify(items, null, 2));
  }
}

function isProvisionalEligible(kind: PromotionKind): boolean {
  return kind === "lexeme_alias" || kind === "retrieval_tuning" || kind === "strategy_hint";
}
