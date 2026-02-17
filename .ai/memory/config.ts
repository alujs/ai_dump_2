/**
 * Memory system configuration.
 *
 * Edit this file to tune memory behavior. All thresholds and toggles
 * are surfaced here so you don't have to dig into source code.
 *
 * Location: .ai/memory/config.ts
 * Consumed by: MemoryService, FrictionLedger, PlanValidator, StrategySelector
 */

export interface MemoryConfig {
  /* ── Friction detection thresholds ─────────────────────── */

  /** Number of identical rejection codes before creating a memory candidate */
  rejectionThreshold: number;

  /** Hours a pending memory waits before auto-promoting to provisional */
  contestWindowHours: number;

  /** Hours a provisional memory waits before expiring (if not approved) */
  provisionalExpiryHours: number;

  /* ── Human override behavior ───────────────────────────── */

  /** Human overrides skip pending→provisional and go straight to this state */
  humanOverrideInitialState: "approved" | "provisional";

  /* ── Enforcement toggles ───────────────────────────────── */

  /** Whether few-shot examples are injected into read results */
  enableFewShotInjection: boolean;

  /** Whether memory-carried plan rules are enforced by the validator */
  enablePlanRuleMutation: boolean;

  /** Whether memory-carried strategy signals override ContextSignature */
  enableStrategyOverride: boolean;

  /* ── Domain anchor auto-seeding ────────────────────────── */

  /** Maximum folder depth for auto-seeding domain anchors (relative to repo root) */
  anchorAutoSeedMaxDepth: number;

  /** Folder patterns to exclude from auto-seeding (glob-style) */
  anchorExcludePatterns: string[];

  /** Folder patterns to always include even if excluded by depth (exact relative paths) */
  anchorIncludeOverrides: string[];

  /* ── Friction ledger ───────────────────────────────────── */

  /** Whether the friction ledger is enabled */
  enableFrictionLedger: boolean;

  /** Maximum entries in the friction ledger before rotation */
  frictionLedgerMaxEntries: number;

  /* ── Retrospective ─────────────────────────────────────── */

  /** Whether to auto-scaffold few-shot records from rejected plans */
  enableAutoScaffoldFromRejections: boolean;

  /** Minimum rejection count before auto-scaffolding a few-shot */
  autoScaffoldMinRejections: number;

  /* ── Memory state promotion rules ──────────────────────── */

  /** Which enforcement types can auto-promote from pending to provisional */
  autoPromotableEnforcementTypes: Array<"few_shot" | "plan_rule" | "strategy_signal" | "informational">;

  /** Which enforcement types require human approval (will never auto-promote) */
  humanApprovalRequired: Array<"few_shot" | "plan_rule" | "strategy_signal" | "informational">;
}

/**
 * Default configuration — sensible starting point.
 * Override by editing the values below.
 */
export const MEMORY_CONFIG: MemoryConfig = {
  /* ── Friction detection ────────────────────────────────── */
  rejectionThreshold: 3,
  contestWindowHours: 48,
  provisionalExpiryHours: 48,

  /* ── Human override ────────────────────────────────────── */
  humanOverrideInitialState: "approved",

  /* ── Enforcement toggles ───────────────────────────────── */
  enableFewShotInjection: true,
  enablePlanRuleMutation: true,
  enableStrategyOverride: true,

  /* ── Domain anchor auto-seeding ────────────────────────── */
  anchorAutoSeedMaxDepth: 3,
  anchorExcludePatterns: [
    "node_modules",
    ".git",
    ".ai",
    "dist",
    "build",
    "coverage",
    ".angular",
    ".nx",
    "tmp",
    "__pycache__",
  ],
  anchorIncludeOverrides: [],

  /* ── Friction ledger ───────────────────────────────────── */
  enableFrictionLedger: true,
  frictionLedgerMaxEntries: 5000,

  /* ── Retrospective ─────────────────────────────────────── */
  enableAutoScaffoldFromRejections: true,
  autoScaffoldMinRejections: 3,

  /* ── Promotion rules ───────────────────────────────────── */
  autoPromotableEnforcementTypes: ["informational", "strategy_signal"],
  humanApprovalRequired: ["plan_rule"],
};
