/**
 * MemoryRecord — the core contract for the memory system.
 *
 * A memory record is a graph node that attaches to DomainAnchor nodes
 * via :APPLIES_TO relationships. It carries enforcement mechanisms
 * (few-shot examples, plan rules, strategy signals) that influence
 * the controller's behavior when the associated domain is in scope.
 *
 * Memory records are created from three entry points:
 *   1. Repeated failures (3x rejection → auto-scaffolded)
 *   2. End-of-task retrospective (signal_task_complete verb)
 *   3. Human intervention (side-channel file drop in .ai/memory/overrides/)
 *
 * Records live in the Neo4j graph as MemoryRecord nodes. They're surfaced
 * during trace_symbol_graph traversal and context pack assembly when
 * their attached DomainAnchor is in scope.
 */

/* ── Memory dimensions (who/what/where/why) ─────────────── */

/** What triggered this memory */
export type MemoryTrigger =
  | "rejection_pattern"     // 3x same rejection code
  | "human_override"        // Human dropped a file or approved via retrospective
  | "retrospective"         // End-of-task analysis
  | "rule_violation"        // Plan validator caught a structural issue
  | "friction_signal";      // Friction observer detected a pattern

/** Where in the lifecycle this memory was created */
export type MemoryPhase =
  | "exploration"           // During read/search verbs
  | "planning"              // During context pack / plan submission
  | "execution"             // During patch application
  | "retrospective";        // During end-of-task review

/** What kind of enforcement this memory carries */
export type MemoryEnforcementType =
  | "few_shot"              // Before/after example — passive, surfaces in reads
  | "plan_rule"             // PlanGraph acceptance mutation — active, validator checks
  | "strategy_signal"       // ContextSignature override — influences strategy selection
  | "informational";        // No enforcement — context only (e.g., "this area is fragile")

/** Memory state in the promotion lifecycle */
export type MemoryState =
  | "pending"               // Just created, unverified
  | "provisional"           // Passed contest window, not yet approved
  | "approved"              // Human-approved or auto-promoted
  | "rejected"              // Human-rejected
  | "expired";              // Aged out without promotion

/* ── Few-shot example structure ─────────────────────────── */

export interface FewShotExample {
  /** Natural-language instruction for the agent */
  instruction: string;
  /** The code/config before the change (the "wrong" or "old" version) */
  before: string;
  /** The code/config after the change (the "right" or "new" version) */
  after: string;
  /** The common mistake to avoid — what the agent might generate incorrectly */
  antiPattern?: string;
  /** Why the antiPattern is wrong — grounds the correction */
  whyWrong?: string;
  /** File path context — "this applies when editing files under X" */
  applicableFilePaths?: string[];
  /** Whether this few-shot was auto-scaffolded (before populated, after needs human) */
  scaffolded: boolean;
}

/* ── Plan rule structure ────────────────────────────────── */

export interface PlanRule {
  /** Human-readable condition description */
  condition: string;
  /** Additional plan steps required when this rule is active */
  requiredSteps: PlanRuleStep[];
  /** Deny reason to emit if the rule is violated */
  denyCode: string;
}

export interface PlanRuleStep {
  /** What kind of plan node is required */
  kind: "validate" | "change" | "escalate";
  /** Description of what the step must do */
  description: string;
  /** Which file or symbol pattern this step must target */
  targetPattern?: string;
}

/* ── Strategy signal structure ──────────────────────────── */

export interface StrategySignal {
  /** Which ContextSignature feature to override */
  featureFlag: string;
  /** The value to set */
  value: boolean | string;
  /** Why this override exists */
  reason: string;
}

/* ── The memory record itself ───────────────────────────── */

export interface MemoryRecord {
  /** Unique stable ID — prefixed with "mem:" */
  id: string;
  /** Graph node label — always "MemoryRecord" */
  label: "MemoryRecord";

  /* ── Dimensions ────────────────────────────────────────── */

  /** What triggered this memory's creation */
  trigger: MemoryTrigger;
  /** Where in the lifecycle this was created */
  phase: MemoryPhase;
  /** Domain anchor IDs this memory attaches to (via :APPLIES_TO in graph) */
  domainAnchorIds: string[];
  /** Graph node IDs this memory is relevant to (optional, for fine-grained targeting) */
  graphNodeIds: string[];
  /** Rejection code(s) that triggered this memory (if trigger === "rejection_pattern") */
  rejectionCodes: string[];
  /** Strategy ID active when this memory was created */
  originStrategyId: string;

  /* ── Enforcement ───────────────────────────────────────── */

  /** Primary enforcement type */
  enforcementType: MemoryEnforcementType;
  /** Few-shot example (when enforcementType === "few_shot") */
  fewShot?: FewShotExample;
  /** Plan acceptance rule (when enforcementType === "plan_rule") */
  planRule?: PlanRule;
  /** Strategy signal override (when enforcementType === "strategy_signal") */
  strategySignal?: StrategySignal;
  /** Free-text note for informational memories */
  note?: string;

  /* ── Lifecycle ─────────────────────────────────────────── */

  /** Current promotion state */
  state: MemoryState;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last state change */
  updatedAt: string;
  /** Trace ref back to the originating turn */
  traceRef: string;
  /** Free-text reason for last state transition */
  transitionReason?: string;

  /* ── Metadata ──────────────────────────────────────────── */

  /** Session ID where this memory was created */
  originSessionId: string;
  /** Work ID where this memory was created */
  originWorkId: string;
  /** Agent ID that was active when this memory was created */
  originAgentId: string;
  /** Arbitrary metadata for extensibility */
  metadata: Record<string, unknown>;
}

/* ── Domain anchor node shape ───────────────────────────── */

/**
 * A DomainAnchor is a graph node representing a logical boundary
 * in the codebase (folder, module, feature area). Memories and
 * graph entities connect to it, making it the bridge between
 * lexemes, graph topology, and memory records.
 */
export interface DomainAnchor {
  /** Unique stable ID — e.g., "anchor:operations/billing" */
  id: string;
  /** Graph node labels — always includes "DomainAnchor" */
  labels: ["DomainAnchor", ...string[]];
  /** Human-readable name */
  name: string;
  /** The folder path this anchor represents (relative to repo root) */
  folderPath: string;
  /** Depth in the folder hierarchy (for auto-seeding control) */
  depth: number;
  /** Parent anchor ID (if nested) */
  parentAnchorId?: string;
  /** Whether this anchor was auto-seeded or manually created */
  autoSeeded: boolean;
  /** ISO timestamp of creation/last update */
  updatedAt: string;
}

/* ── Friction ledger entry ──────────────────────────────── */

export interface FrictionLedgerEntry {
  /** ISO timestamp */
  ts: string;
  /** What triggered this friction event */
  trigger: MemoryTrigger;
  /** Rejection code(s) involved */
  rejectionCodes: string[];
  /** Domain anchor ID(s) in scope */
  domainAnchorIds: string[];
  /** Memory record ID (if one was created) */
  memoryId?: string;
  /** Count of the rejection (e.g., 3 for the 3x threshold) */
  rejectionCount: number;
  /** Whether this friction was resolved by a memory */
  resolved: boolean;
  /** ISO timestamp of resolution (if resolved) */
  resolvedAt?: string;
  /** Strategy active at friction time */
  strategyId: string;
  /** Session context */
  sessionId: string;
  workId: string;
}
