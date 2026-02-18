/**
 * Phase 5: Enforcement Bundle
 *
 * Computes an enforcement bundle from active memories + graph policy nodes.
 * The bundle is fed to planGraphValidator at plan submission time.
 *
 * Key concepts:
 * - Graph policies (UIIntent, ComponentIntent, MacroConstraint) become ephemeral plan_rules
 * - Policies must be "grounded" (linked to UsageExample) to be enforceable
 * - Ungrounded policies are advisory-only (included in pack but don't deny plans)
 *
 * Spec ref: architecture_v2.md §10, §14
 */
import type { MemoryRecord, PlanRule, PlanRuleStep } from "../../contracts/memoryRecord";

/** A graph policy node shape (UIIntent | ComponentIntent | MacroConstraint) */
export interface GraphPolicyNode {
  id: string;
  type: "ui_intent" | "component_intent" | "macro_constraint";
  /** Whether this policy is grounded (linked to a UsageExample in the same domain) */
  grounded: boolean;
  /** Human-readable condition/description */
  condition: string;
  /** Hard deny or advisory */
  enforcement: "hard_deny" | "advisory";
  /** Required component tags (for UIIntent) */
  requiredComponents?: string[];
  /** Forbidden component tags (for UIIntent) */
  forbiddenComponents?: string[];
  /** Component tag (for ComponentIntent) */
  componentTag?: string;
}

/** Migration rule node from graph seed data */
export interface MigrationRuleNode {
  id: string;
  fromTag: string;
  toTag: string;
  status: "approved" | "candidate" | "unknown" | "no_analog";
}

/** The enforcement bundle passed to planGraphValidator */
export interface EnforcementBundle {
  /** Plan rules derived from active memories */
  memoryPlanRules: MemoryRecord[];
  /** Ephemeral plan rules derived from graph policies (NOT persisted as memories) */
  graphPolicyRules: EphemeralPlanRule[];
  /** Active migration rules for component migration validation */
  migrationRules: MigrationRuleNode[];
  /** Advisory-only policies (ungrounded — shown in pack but don't deny) */
  advisoryPolicies: GraphPolicyNode[];
}

/** An ephemeral plan rule derived from a graph policy — same shape as PlanRule but not persisted */
export interface EphemeralPlanRule {
  sourceNodeId: string;
  sourceType: GraphPolicyNode["type"];
  condition: string;
  denyCode: string;
  requiredSteps: PlanRuleStep[];
}

/**
 * Compute an enforcement bundle from active memories and graph policy nodes.
 *
 * @param activeMemories - Memories queried from the memory service
 * @param graphPolicies  - Policy nodes from the graph (UIIntent, ComponentIntent, MacroConstraint)
 * @param migrationRules - MigrationRule nodes from the graph
 */
export function computeEnforcementBundle(
  activeMemories: MemoryRecord[],
  graphPolicies: GraphPolicyNode[],
  migrationRules: MigrationRuleNode[],
): EnforcementBundle {
  // Memory-carried plan rules (existing behavior)
  const memoryPlanRules = activeMemories.filter(
    (m) => m.enforcementType === "plan_rule" && m.planRule && (m.state === "approved" || m.state === "provisional")
  );

  // Partition graph policies into enforceable (grounded) and advisory (ungrounded)
  const grounded = graphPolicies.filter((p) => p.grounded);
  const ungrounded = graphPolicies.filter((p) => !p.grounded);

  // Convert grounded graph policies to ephemeral plan rules
  const graphPolicyRules = grounded
    .filter((p) => p.enforcement === "hard_deny")
    .map((p) => graphPolicyToEphemeralRule(p));

  return {
    memoryPlanRules,
    graphPolicyRules,
    migrationRules,
    advisoryPolicies: ungrounded,
  };
}

/**
 * Convert a grounded graph policy into an ephemeral PlanRule shape.
 * This lets us reuse the existing validateMemoryRules() machinery
 * without persisting these as memory records.
 */
function graphPolicyToEphemeralRule(policy: GraphPolicyNode): EphemeralPlanRule {
  const requiredSteps: PlanRuleStep[] = [];

  switch (policy.type) {
    case "ui_intent":
      // If an intent forbids certain components, require a change step for each forbidden usage
      if (policy.forbiddenComponents?.length) {
        for (const forbidden of policy.forbiddenComponents) {
          requiredSteps.push({
            kind: "change",
            description: `Migrate away from ${forbidden} per UIIntent: ${policy.condition}`,
            targetPattern: forbidden,
          });
        }
      }
      break;

    case "component_intent":
      // ComponentIntent provides guidance — require a validate step ensuring correct usage
      if (policy.componentTag) {
        requiredSteps.push({
          kind: "validate",
          description: `Verify ${policy.componentTag} is used correctly per ComponentIntent`,
          targetPattern: policy.componentTag,
        });
      }
      break;

    case "macro_constraint":
      // MacroConstraint is a blanket rule — require a validate step for compliance
      requiredSteps.push({
        kind: "validate",
        description: `Ensure compliance with macro constraint: ${policy.condition}`,
      });
      break;
  }

  return {
    sourceNodeId: policy.id,
    sourceType: policy.type,
    condition: policy.condition,
    denyCode: "PLAN_POLICY_VIOLATION",
    requiredSteps,
  };
}

/**
 * Check whether a plan includes policyRefs for all required migration rules.
 * Plans that modify adp-* components must cite the corresponding MigrationRule.
 */
export function checkMigrationRuleCoverage(
  planPolicyRefs: string[],
  planTargetTags: string[],
  migrationRules: MigrationRuleNode[],
): { covered: boolean; missingRules: string[] } {
  const missingRules: string[] = [];
  const refSet = new Set(planPolicyRefs);

  for (const tag of planTargetTags) {
    if (!tag.startsWith("adp-")) continue;
    const rule = migrationRules.find((r) => r.fromTag === tag);
    if (!rule) continue; // No rule exists for this tag — not enforced
    if (rule.status === "approved" && !refSet.has(rule.id)) {
      missingRules.push(rule.id);
    }
  }

  return {
    covered: missingRules.length === 0,
    missingRules,
  };
}
