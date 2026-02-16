import { runAsyncIife } from "../../infrastructure/vm/safeVmRunner";

export interface CodeRunRequest {
  nodeId: string;
  iife: string;
  declaredInputs: Record<string, unknown>;
  timeoutMs: number;
  memoryCapMb: number;
  artifactOutputRef: string;
  expectedReturnShape: {
    type: "object" | "string" | "number" | "array" | "boolean";
    requiredKeys?: string[];
  };
}

export interface CodeRunExecutionResult {
  ok: boolean;
  rejectionCode?: "PLAN_MISSING_REQUIRED_FIELDS" | "PLAN_VERIFICATION_WEAK";
  reason?: string;
  value?: unknown;
}

export async function executeCodeRun(request: CodeRunRequest): Promise<CodeRunExecutionResult> {
  const preflight = validatePreflight(request);
  if (!preflight.ok) {
    return preflight;
  }

  try {
    const value = await runAsyncIife({
      iife: request.iife,
      timeoutMs: request.timeoutMs,
      context: request.declaredInputs
    });
    const shape = validateReturnShape(value, request.expectedReturnShape);
    if (!shape.ok) {
      return shape;
    }
    if (isPlaceholderOrNonSubstantive(value)) {
      return {
        ok: false,
        rejectionCode: "PLAN_VERIFICATION_WEAK",
        reason: "Code run returned placeholder or non-substantive result."
      };
    }
    return {
      ok: true,
      value
    };
  } catch (error) {
    return {
      ok: false,
      rejectionCode: "PLAN_VERIFICATION_WEAK",
      reason: error instanceof Error ? error.message : "CODE_RUN_FAILED"
    };
  }
}

function validatePreflight(request: CodeRunRequest): CodeRunExecutionResult {
  if (!request.iife.includes("(async () =>") || !request.iife.includes(")()")) {
    return {
      ok: false,
      rejectionCode: "PLAN_MISSING_REQUIRED_FIELDS",
      reason: "Input must be an async IIFE."
    };
  }
  if (!request.artifactOutputRef || request.artifactOutputRef.trim().length === 0) {
    return {
      ok: false,
      rejectionCode: "PLAN_MISSING_REQUIRED_FIELDS",
      reason: "artifactOutputRef is required."
    };
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    return {
      ok: false,
      rejectionCode: "PLAN_MISSING_REQUIRED_FIELDS",
      reason: "timeoutMs must be positive."
    };
  }
  if (!Number.isFinite(request.memoryCapMb) || request.memoryCapMb <= 0) {
    return {
      ok: false,
      rejectionCode: "PLAN_MISSING_REQUIRED_FIELDS",
      reason: "memoryCapMb must be positive."
    };
  }
  return { ok: true };
}

function validateReturnShape(
  value: unknown,
  expected: CodeRunRequest["expectedReturnShape"]
): CodeRunExecutionResult {
  switch (expected.type) {
    case "array":
      if (!Array.isArray(value)) {
        return {
          ok: false,
          rejectionCode: "PLAN_VERIFICATION_WEAK",
          reason: "Expected array return shape."
        };
      }
      return { ok: true };
    case "object":
      if (!isRecord(value)) {
        return {
          ok: false,
          rejectionCode: "PLAN_VERIFICATION_WEAK",
          reason: "Expected object return shape."
        };
      }
      if (expected.requiredKeys) {
        const missing = expected.requiredKeys.filter((key) => !(key in value));
        if (missing.length > 0) {
          return {
            ok: false,
            rejectionCode: "PLAN_VERIFICATION_WEAK",
            reason: `Missing required keys: ${missing.join(",")}`
          };
        }
      }
      return { ok: true };
    default:
      if (typeof value !== expected.type) {
        return {
          ok: false,
          rejectionCode: "PLAN_VERIFICATION_WEAK",
          reason: `Expected ${expected.type} return shape.`
        };
      }
      return { ok: true };
  }
}

function isPlaceholderOrNonSubstantive(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === "string") {
    const lowered = value.toLowerCase().trim();
    if (lowered.length < 3) {
      return true;
    }
    return ["todo", "placeholder", "tbd", "n/a"].some((item) => lowered.includes(item));
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isRecord(value)) {
    const serialized = JSON.stringify(value).toLowerCase();
    if (Object.keys(value).length === 0) {
      return true;
    }
    return ["todo", "placeholder", "tbd"].some((item) => serialized.includes(item));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
