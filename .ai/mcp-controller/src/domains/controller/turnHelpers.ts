import path from "node:path";
import type { CodeRunRequest } from "../code-run/codeRunService";
import type { PatchApplyRequest } from "../patch-exec/patchExecService";
import type { ChangePlanNode, PlanGraphDocument, SideEffectPlanNode } from "../../contracts/planGraph";
import { resolveTargetRepoRoot, workRoot } from "../../shared/fsPaths";

/* ── Request parsing ───────────────────────────────────────── */

export function parsePatchApplyRequest(
  args: Record<string, unknown> | undefined
): PatchApplyRequest | null {
  if (!args) return null;

  const nodeId = String(args.nodeId ?? "");
  const targetFile = String(args.targetFile ?? "");
  const targetSymbols = asStringArray(args.targetSymbols) ?? [];
  const operationRaw = String(args.operation ?? "replace_text");

  if (!nodeId || !targetFile) return null;

  if (operationRaw === "replace_text") {
    const find = String(args.find ?? "");
    const replace = String(args.replace ?? "");
    if (!find) return null;
    return { nodeId, targetFile, targetSymbols, operation: "replace_text", find, replace };
  }

  if (operationRaw !== "ast_codemod") return null;
  const codemodId = String(args.codemodId ?? "").trim();
  const codemodParams = isRecord(args.codemodParams) ? args.codemodParams : {};
  if (!codemodId) return null;
  return { nodeId, targetFile, targetSymbols, operation: "ast_codemod", codemodId, codemodParams };
}

export function parseCodeRunRequest(
  args: Record<string, unknown> | undefined
): CodeRunRequest | null {
  if (!args) return null;

  const nodeId = String(args.nodeId ?? "");
  const iife = String(args.iife ?? "");
  const artifactOutputRef = String(args.artifactOutputRef ?? "");
  const timeoutMs = Number(args.timeoutMs ?? 0);
  const memoryCapMb = Number(args.memoryCapMb ?? 0);
  const declaredInputs = isRecord(args.declaredInputs) ? args.declaredInputs : {};
  const expected = isRecord(args.expectedReturnShape) ? args.expectedReturnShape : { type: "object", requiredKeys: [] };
  const expectedType = String(expected.type ?? "");
  const requiredKeys = asStringArray(expected.requiredKeys) ?? [];

  if (!nodeId || !iife || !artifactOutputRef || timeoutMs <= 0 || memoryCapMb <= 0) return null;
  if (!isExpectedType(expectedType)) return null;

  return {
    nodeId,
    iife,
    declaredInputs,
    timeoutMs,
    memoryCapMb,
    artifactOutputRef,
    expectedReturnShape: { type: expectedType, requiredKeys },
  };
}

/* ── PlanGraph node lookups ────────────────────────────────── */

export function findChangeNode(plan: PlanGraphDocument, nodeId: string): ChangePlanNode | null {
  for (const node of plan.nodes) {
    if (node.nodeId === nodeId && node.kind === "change") return node;
  }
  return null;
}

export function findSideEffectNode(plan: PlanGraphDocument, nodeId: string): SideEffectPlanNode | null {
  for (const node of plan.nodes) {
    if (node.nodeId === nodeId && node.kind === "side_effect") return node;
  }
  return null;
}

export function approvedCommitGates(plan: PlanGraphDocument): string[] {
  return plan.nodes
    .filter((node): node is SideEffectPlanNode => node.kind === "side_effect")
    .map((node) => node.commitGateId);
}

/* ── Worktree validation ───────────────────────────────────── */

export function validatePlanWorktreeRoot(
  worktreeRoot: string,
  workId: string
): { ok: true } | { ok: false; reason: string } {
  if (!worktreeRoot || worktreeRoot.trim().length === 0) {
    return { ok: false, reason: "Plan worktreeRoot is required." };
  }
  const resolved = path.resolve(worktreeRoot);
  const targetRoot = path.resolve(resolveTargetRepoRoot());
  const scopedWorkRoot = path.resolve(workRoot(workId));

  if (isPathWithin(resolved, targetRoot) || isPathWithin(resolved, scopedWorkRoot)) {
    return { ok: true };
  }
  return { ok: false, reason: "Plan worktreeRoot must stay within MCP target repo root or .ai scoped work root." };
}

/* ── Anchor extraction ─────────────────────────────────────── */

export function extractAnchors(args: Record<string, unknown> | undefined): {
  entrypoint?: string;
  definition?: string;
  agGridOriginChain?: string[];
  federationChain?: string[];
} {
  const anchorInput = args?.anchors as Record<string, unknown> | undefined;
  if (!anchorInput) return {};
  return {
    entrypoint: asOptionalString(anchorInput.entrypoint),
    definition: asOptionalString(anchorInput.definition),
    agGridOriginChain: asStringArray(anchorInput.agGridOriginChain),
    federationChain: asStringArray(anchorInput.federationChain),
  };
}

/* ── Misc helpers ──────────────────────────────────────────── */

export function summarizeValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 160);
  try {
    return JSON.stringify(value).slice(0, 160);
  } catch {
    return "[unserializable result]";
  }
}

export function isRejectionCode(value: string): boolean {
  return value.startsWith("PLAN_") || value.startsWith("EXEC_") || value.startsWith("PACK_");
}

export function moduleHint(args: Record<string, unknown> | undefined): string {
  if (!args) return "unknown_module";
  const explicit = String(args.module ?? "");
  if (explicit) return explicit;
  const targetFile = String(args.targetFile ?? "");
  if (targetFile.includes("/")) {
    const parts = targetFile.split("/");
    return parts.slice(0, Math.max(1, parts.length - 1)).join("/");
  }
  return targetFile || "unknown_module";
}

function isPathWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isExpectedType(value: string): value is CodeRunRequest["expectedReturnShape"]["type"] {
  return value === "object" || value === "string" || value === "number" || value === "array" || value === "boolean";
}

/* ── Type coercion utils (exported for handler modules) ──── */

export function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item));
}

export function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
