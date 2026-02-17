import path from "node:path";
import { writeText } from "./fileStore";
import { workRoot } from "./fsPaths";

export interface ArtifactBundleInput {
  workId: string;
  runSessionId: string;
  nodeId: string;
  operation: "apply_code_patch" | "run_sandboxed_code" | "execute_gated_side_effect";
  result: Record<string, unknown>;
  opLog: string;
  traceRefs: string[];
  validation: Record<string, unknown>;
  diffSummary?: Record<string, unknown>;
}

export interface ArtifactBundleOutput {
  bundleDir: string;
  resultRef: string;
  opLogRef: string;
  traceRefsRef: string;
  validationRef: string;
  diffSummaryRef?: string;
}

export async function writeArtifactBundle(input: ArtifactBundleInput): Promise<ArtifactBundleOutput> {
  const bundleDir = path.join(
    workRoot(input.workId),
    "artifacts",
    input.runSessionId,
    input.nodeId,
    input.operation
  );
  const resultRef = path.join(bundleDir, "result.json");
  const opLogRef = path.join(bundleDir, "op.log");
  const traceRefsRef = path.join(bundleDir, "trace.refs.json");
  const validationRef = path.join(bundleDir, "validation.json");

  await writeText(resultRef, JSON.stringify(input.result, null, 2));
  await writeText(opLogRef, input.opLog);
  await writeText(traceRefsRef, JSON.stringify(input.traceRefs, null, 2));
  await writeText(validationRef, JSON.stringify(input.validation, null, 2));

  let diffSummaryRef: string | undefined;
  if (input.diffSummary) {
    diffSummaryRef = path.join(bundleDir, "diff.summary.json");
    await writeText(diffSummaryRef, JSON.stringify(input.diffSummary, null, 2));
  }

  return {
    bundleDir,
    resultRef,
    opLogRef,
    traceRefsRef,
    validationRef,
    diffSummaryRef
  };
}
