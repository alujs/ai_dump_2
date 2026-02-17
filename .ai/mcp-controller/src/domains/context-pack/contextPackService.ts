import path from "node:path";
import { createHash } from "node:crypto";
import { PACK_BLOCKED_COMMANDS, SCHEMA_VERSION } from "../../shared/constants";
import { contextRoot } from "../../shared/fsPaths";
import { writeText } from "../../shared/fileStore";
import type { PackInsufficiency } from "../../contracts/controller";
import type { RetrievalLaneResult } from "./retrievalLanes";

export interface ContextPackInput {
  runSessionId: string;
  workId: string;
  originalPrompt: string;
  strategyId: string;
  strategyReasons: Array<{ reason: string; evidenceRef: string }>;
  taskConstraints: string[];
  conflicts: string[];
  activePolicies: string[];
  policyVersionSet: Record<string, string>;
  allowedFiles: string[];
  allowedCapabilities: string[];
  validationPlan: string[];
  missingness: string[];
  retrievalLanes?: RetrievalLaneResult;
  schemaLinks?: string[];
  anchors?: {
    entrypoint?: string;
    definition?: string;
    agGridOriginChain?: string[];
    federationChain?: string[];
  };
  requiresAgGridProof?: boolean;
  requiresFederationProof?: boolean;
  executionOptions?: Record<string, unknown>;
  /** Raw Jira ticket payload — stored verbatim in the pack [REF:CP-SECTIONS] */
  rawJiraTicket?: Record<string, unknown>;
  /** Proof chain results if already computed (ag-Grid origin chain) */
  agGridProofChain?: { chain: Array<{ kind: string; id: string; label: string; filePath?: string; source: string }>; complete: boolean; missingLinks: string[]; notes: string[] };
  /** Proof chain results if already computed (federation chain) */
  federationProofChain?: { chain: Array<{ kind: string; id: string; label: string; filePath?: string; source: string }>; complete: boolean; missingLinks: string[]; notes: string[] };
}

export interface ContextPackOutput {
  contextPackRef: string;
  contextPackHash: string;
  packDir: string;
  insufficiency?: PackInsufficiency;
}

export async function createContextPack(input: ContextPackInput): Promise<ContextPackOutput> {
  const packDir = contextRoot(input.runSessionId, input.workId);
  const promptPath = path.join(packDir, "original_prompt.txt");
  const contextPackRef = path.join(packDir, "context_pack.json");

  // Verbatim prompt persistence is a hard invariant.
  await writeText(promptPath, input.originalPrompt);

  const anchorSelection = selectAnchors(input);
  const missingAnchors = evaluateMissingAnchors({
    ...input,
    anchors: anchorSelection.anchors
  });
  const insufficiency = missingAnchors.length > 0 ? buildInsufficiency(missingAnchors) : undefined;

  const payloadBase = {
    header: {
      runSessionId: input.runSessionId,
      workId: input.workId,
      schemaVersion: SCHEMA_VERSION,
      hashAlgorithm: "sha256"
    },
    task: {
      constraints: input.taskConstraints,
      conflicts: input.conflicts
    },
    activePolicySet: {
      ids: input.activePolicies,
      versionSet: input.policyVersionSet
    },
    strategy: {
      id: input.strategyId,
      reasons: input.strategyReasons
    },
    anchors: {
      entrypoint: anchorSelection.anchors.entrypoint ?? "",
      definition: anchorSelection.anchors.definition ?? "",
      agGridOriginChain: anchorSelection.anchors.agGridOriginChain ?? [],
      federationChain: anchorSelection.anchors.federationChain ?? []
    },
    anchorSelection: {
      entrypointSource: anchorSelection.entrypointSource,
      definitionSource: anchorSelection.definitionSource,
      reasons: anchorSelection.reasons
    },
    proofObligations: {
      requiresAgGridProof: Boolean(input.requiresAgGridProof),
      requiresFederationProof: Boolean(input.requiresFederationProof)
    },
    scope: {
      allowedFiles: input.allowedFiles,
      allowedCapabilities: input.allowedCapabilities
    },
    validationPlan: input.validationPlan,
    retrievalLanes: input.retrievalLanes ?? {
      lexicalLane: [],
      symbolLane: [],
      policyLane: [],
      artifactLane: [],
      episodicMemoryLane: []
    },
    retrievalDecision: {
      rerank:
        input.retrievalLanes?.rerank ??
        ({
          algorithmId: "deterministic_lexical_graph_v1",
          selectedAnchors: {},
          topLexical: [],
          topSymbol: []
        } as Record<string, unknown>),
      queryNormalization: input.retrievalLanes?.queryNormalization ?? {
        originalQuery: input.originalPrompt,
        expandedQuery: input.originalPrompt,
        normalizedTerms: [],
        expandedTerms: [],
        expansions: []
      }
    },
    executionOptions: input.executionOptions ?? {},
    missingnessAndConflicts: {
      missingAnchors,
      missingness: input.missingness,
      conflicts: input.conflicts
    },
    schemaLinks:
      input.schemaLinks && input.schemaLinks.length > 0
        ? input.schemaLinks
        : [".ai/config/schema.json", "src/contracts/controller.ts", "src/contracts/planGraph.ts"],
    expectations: {
      highSignalOnly: true,
      minimumSufficientContext: true
    },
    jiraTicket: input.rawJiraTicket ?? null,
    proofChainTrace: {
      agGridOriginChain: input.agGridProofChain ?? null,
      federationChain: input.federationProofChain ?? null,
    }
  };

  const hashSource = JSON.stringify(payloadBase);
  const contextPackHash = createHash("sha256").update(hashSource).digest("hex");
  const payload = {
    ...payloadBase,
    header: {
      ...payloadBase.header,
      contextPackRef,
      contextPackHash
    }
  };
  const serialized = JSON.stringify(payload, null, 2);

  await writeText(contextPackRef, serialized);

  return {
    contextPackRef,
    contextPackHash,
    packDir,
    insufficiency
  };
}

function selectAnchors(input: ContextPackInput): {
  anchors: {
    entrypoint?: string;
    definition?: string;
    agGridOriginChain?: string[];
    federationChain?: string[];
  };
  entrypointSource: "explicit" | "rerank" | "missing";
  definitionSource: "explicit" | "rerank" | "missing";
  reasons: string[];
} {
  const reasons: string[] = [];
  const rerank = asRecord(input.retrievalLanes?.rerank);
  const selected = asRecord(rerank.selectedAnchors);
  const entrypointCandidate = asRecord(selected.entrypointCandidate);
  const definitionCandidate = asRecord(selected.definitionCandidate);

  const explicitEntrypoint = input.anchors?.entrypoint?.trim();
  const explicitDefinition = input.anchors?.definition?.trim();

  const entrypointFromRerank = stringOrUndefined(entrypointCandidate.filePath);
  const definitionFromRerank =
    stringOrUndefined(definitionCandidate.symbol) ?? stringOrUndefined(definitionCandidate.filePath);

  const entrypoint = explicitEntrypoint || entrypointFromRerank;
  const definition = explicitDefinition || definitionFromRerank;

  const entrypointSource: "explicit" | "rerank" | "missing" = explicitEntrypoint
    ? "explicit"
    : entrypointFromRerank
      ? "rerank"
      : "missing";
  const definitionSource: "explicit" | "rerank" | "missing" = explicitDefinition
    ? "explicit"
    : definitionFromRerank
      ? "rerank"
      : "missing";

  if (entrypointSource === "rerank") {
    reasons.push("entrypoint_filled_from_rerank");
  }
  if (definitionSource === "rerank") {
    reasons.push("definition_filled_from_rerank");
  }

  // Merge proof chain results into anchor arrays [REF:PROOF-CHAINS]
  const agGridOriginChain = input.anchors?.agGridOriginChain?.length
    ? input.anchors.agGridOriginChain
    : input.agGridProofChain?.chain?.map((link) => `${link.kind}:${link.label}`) ?? [];

  const federationChain = input.anchors?.federationChain?.length
    ? input.anchors.federationChain
    : input.federationProofChain?.chain?.map((link) => `${link.kind}:${link.label}`) ?? [];

  if (agGridOriginChain.length > 0 && !(input.anchors?.agGridOriginChain?.length)) {
    reasons.push("ag_grid_origin_chain_filled_from_proof_chain_builder");
  }
  if (federationChain.length > 0 && !(input.anchors?.federationChain?.length)) {
    reasons.push("federation_chain_filled_from_proof_chain_builder");
  }

  return {
    anchors: {
      entrypoint,
      definition,
      agGridOriginChain,
      federationChain
    },
    entrypointSource,
    definitionSource,
    reasons
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function evaluateMissingAnchors(input: ContextPackInput): Array<{
  anchorType: string;
  requiredBy: string;
  whyRequired: string;
  attemptedSources: string[];
  confidence: number;
}> {
  const missing: Array<{
    anchorType: string;
    requiredBy: string;
    whyRequired: string;
    attemptedSources: string[];
    confidence: number;
  }> = [];

  if (!input.anchors?.entrypoint) {
    missing.push({
      anchorType: "entrypoint",
      requiredBy: "context_pack_readiness",
      whyRequired: "Plan grounding requires at least one entrypoint anchor.",
      attemptedSources: ["lexical", "symbol"],
      confidence: 0.3
    });
  }
  if (!input.anchors?.definition) {
    missing.push({
      anchorType: "definition",
      requiredBy: "context_pack_readiness",
      whyRequired: "Plan grounding requires at least one definition anchor.",
      attemptedSources: ["symbol", "graph_neighbors"],
      confidence: 0.3
    });
  }
  if (input.requiresAgGridProof && !input.anchors?.agGridOriginChain?.length) {
    missing.push({
      anchorType: "ag_grid_origin_chain",
      requiredBy: "ui_proof_chain",
      whyRequired: "UI/ag-grid tasks require origin chain proof.",
      attemptedSources: ["template_symbols", "grid_registry"],
      confidence: 0.2
    });
  }
  if (input.requiresFederationProof && !input.anchors?.federationChain?.length) {
    missing.push({
      anchorType: "federation_proof_chain",
      requiredBy: "federation_scope",
      whyRequired: "Cross-boundary tasks require host-to-remote proof chain.",
      attemptedSources: ["route_config", "federation_mapping"],
      confidence: 0.2
    });
  }

  return missing;
}

function buildInsufficiency(
  missingAnchors: Array<{
    anchorType: string;
    requiredBy: string;
    whyRequired: string;
    attemptedSources: string[];
    confidence: number;
  }>
): PackInsufficiency {
  return {
    missingAnchors,
    escalationPlan: missingAnchors.map((item) => ({
      type: item.anchorType.includes("federation") ? "scope_expand" : "graph_expand",
      detail: `Resolve ${item.anchorType} for ${item.requiredBy}`
    })),
    blockedCommands: [...PACK_BLOCKED_COMMANDS],
    nextRequiredState: "PLAN_REQUIRED"
  };
}
