import type { ChangePlanNode, EvidencePolicy } from "../../contracts/planGraph";
import { replaceWithGuard } from "../../shared/replaceGuard";

export interface EvidenceValidationResult {
  ok: boolean;
  rejectionCodes: string[];
  diagnostics: string[];
}

export function validateChangeEvidencePolicy(
  node: ChangePlanNode,
  policy: EvidencePolicy
): EvidenceValidationResult {
  const rejectionCodes: string[] = [];
  const diagnostics: string[] = [];

  const requirementSources = dedupe(node.citations);
  const codeSources = dedupe(node.codeEvidence);
  const policySources = dedupe(node.policyRefs);
  const distinctSources = dedupe([...requirementSources, ...codeSources, ...policySources].map(canonicalSource));

  if (requirementSources.length < Math.max(1, policy.minRequirementSources)) {
    rejectionCodes.push("PLAN_EVIDENCE_INSUFFICIENT");
    diagnostics.push("Requirement evidence minimum not met.");
  }
  if (codeSources.length < Math.max(1, policy.minCodeEvidenceSources)) {
    rejectionCodes.push("PLAN_EVIDENCE_INSUFFICIENT");
    diagnostics.push("Code evidence minimum not met.");
  }
  if (policySources.length < Math.max(0, policy.minPolicySources)) {
    rejectionCodes.push("PLAN_EVIDENCE_INSUFFICIENT");
    diagnostics.push("Policy evidence minimum not met.");
  }

  if (distinctSources.length < 2) {
    const hasLowEvidenceGuard = Boolean(node.lowEvidenceGuard && node.uncertaintyNote && node.requiresHumanReview);
    if (!policy.allowSingleSourceWithGuard || !hasLowEvidenceGuard) {
      rejectionCodes.push("PLAN_EVIDENCE_INSUFFICIENT");
      diagnostics.push("Distinct-source minimum not met and low-evidence guard is absent.");
    }
  }

  return {
    ok: rejectionCodes.length === 0,
    rejectionCodes: dedupe(rejectionCodes),
    diagnostics
  };
}

function canonicalSource(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return trimmed;
  }
  return replaceWithGuard(trimmed, /[?#].*$/, "", "EvidencePolicy:canonicalSource");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter((item) => item.length > 0))];
}
