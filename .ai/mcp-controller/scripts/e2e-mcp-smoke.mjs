import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import bootstrapRuntimeModule from "../src/runtime/bootstrapRuntime";
import mcpHandlerModule from "../src/mcp/handler";

const { bootstrapRuntime } = bootstrapRuntimeModule;
const { handleMcpMethod } = mcpHandlerModule;
const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), "..", "..");
const runSessionId = "run_mcp_smoke";
const workId = "work_mcp_smoke";
const agentId = "agent_mcp_smoke";

async function main() {
  await syncGraphDb("pre");

  const runtime = await bootstrapRuntime({
    startDashboard: false
  });

  const worktreeRoot = path.join(repoRoot, ".ai", "tmp", "work", workId);
  await mkdir(worktreeRoot, { recursive: true });
  const targetFileName = "sample-mcp.txt";
  const targetFileAbs = path.join(worktreeRoot, targetFileName);
  await writeFile(targetFileAbs, "const TargetSymbol = 'foo';\n", "utf8");

  const scopeAllowlistRef = path.join(worktreeRoot, "scope.allowlist.json");
  await writeFile(
    scopeAllowlistRef,
    JSON.stringify(
      {
        files: [targetFileName],
        symbolsByFile: {
          [targetFileName]: ["TargetSymbol"]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    const init = await handleMcpMethod({
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: {
          name: "mcp-e2e-smoke",
          version: "1.0.0"
        },
        capabilities: {
          tools: {}
        }
      },
      controller: runtime.controller
    });
    assert.equal(init.protocolVersion, "2024-11-05");
    assert.ok(init.capabilities && typeof init.capabilities === "object");
    assert.ok(init.serverInfo && typeof init.serverInfo.name === "string");

    await handleMcpMethod({
      method: "notifications/initialized",
      params: {},
      controller: runtime.controller
    });

    const tools = await handleMcpMethod({
      method: "tools/list",
      params: {},
      controller: runtime.controller
    });
    assert.ok(Array.isArray(tools.tools));
    assert.ok(tools.tools.some((tool) => tool.name === "controller.turn"));

    const listResponse = await callTurn(runtime.controller, "list", {}, "MCP e2e smoke start");
    assert.equal(listResponse.state, "PLAN_REQUIRED");
    assert.ok(Array.isArray(listResponse.capabilities));
    assert.ok(listResponse.capabilities.includes("submit_plan"));
    assert.equal(Boolean(listResponse.result.patchApplyOptions), true);
    assert.equal(Boolean(listResponse.result.patchApplyOptions?.customCodemodsAllowed), false);

    const contextPackRef = String(listResponse.result.contextPackRef ?? "");
    assert.ok(contextPackRef.length > 0);
    const contextPack = JSON.parse(await readFile(contextPackRef, "utf8"));
    assert.equal(Boolean(contextPack.expectations?.highSignalOnly), true);
    assert.equal(String(contextPack.retrievalDecision?.rerank?.algorithmId ?? ""), "deterministic_lexical_graph_v1");
    assert.equal(Boolean(contextPack.executionOptions?.patchApply), true);
    assert.equal(Boolean(contextPack.executionOptions?.patchApply?.customCodemodsAllowed), false);

    const submitPlanResponse = await callTurn(
      runtime.controller,
      "submit_plan",
      {
        planGraph: makePlanGraph({
          worktreeRoot,
          scopeAllowlistRef,
          targetFileName
        })
      },
      "MCP e2e submit plan"
    );
    assert.equal(submitPlanResponse.state, "PLAN_ACCEPTED");
    assert.equal(String(submitPlanResponse.result.planValidation ?? ""), "passed");

    const patchResponse = await callTurn(
      runtime.controller,
      "patch_apply",
      {
        nodeId: "node_change",
        targetFile: targetFileName,
        targetSymbols: ["TargetSymbol"],
        operation: "replace_text",
        find: "foo",
        replace: "bar"
      },
      "MCP e2e patch"
    );
    assert.equal(patchResponse.state, "EXECUTION_ENABLED");
    assert.equal(Number(patchResponse.result.patchApply?.replacements ?? 0) >= 1, true);
    const patchedContent = await readFile(targetFileAbs, "utf8");
    assert.ok(patchedContent.includes("bar"));

    const astPatchResponse = await callTurn(
      runtime.controller,
      "patch_apply",
      {
        nodeId: "node_change",
        targetFile: targetFileName,
        targetSymbols: ["TargetSymbol"],
        operation: "ast_codemod",
        codemodId: "rename_identifier_in_file",
        codemodParams: {
          from: "TargetSymbol",
          to: "TargetSymbolRenamed"
        }
      },
      "MCP e2e ast codemod"
    );
    assert.equal(astPatchResponse.state, "EXECUTION_ENABLED");
    assert.equal(String(astPatchResponse.result.patchApply?.codemodId ?? ""), "rename_identifier_in_file");
    const astPatchedContent = await readFile(targetFileAbs, "utf8");
    assert.ok(astPatchedContent.includes("TargetSymbolRenamed"));

    const codeRunResponse = await callTurn(
      runtime.controller,
      "code_run",
      {
        nodeId: "node_change",
        iife: "(async () => ({ status: 'ok', count: 1 }))()",
        declaredInputs: {},
        timeoutMs: 3000,
        memoryCapMb: 64,
        artifactOutputRef: "artifact://code-run/out",
        expectedReturnShape: {
          type: "object",
          requiredKeys: ["status"]
        }
      },
      "MCP e2e code run"
    );
    assert.equal(codeRunResponse.state, "EXECUTION_ENABLED");
    assert.equal(String(codeRunResponse.result.codeRun?.preflight ?? ""), "accepted");

    const sideEffectResponse = await callTurn(
      runtime.controller,
      "side_effect",
      {
        nodeId: "node_side",
        commitGateId: "gate_1",
        files: [],
        symbols: [],
        graphMutations: [],
        externalSideEffects: ["gate_1"]
      },
      "MCP e2e side effect"
    );
    assert.equal(sideEffectResponse.state, "EXECUTION_ENABLED");
    assert.equal(Boolean(sideEffectResponse.result.sideEffect?.accepted), true);

    console.log("MCP handler smoke passed.");
  } finally {
    await syncGraphDb("post");
  }
}

async function callTurn(controller, verb, args, prompt) {
  const response = await handleMcpMethod({
    method: "tools/call",
    params: {
      name: "controller.turn",
      arguments: {
        runSessionId,
        workId,
        agentId,
        originalPrompt: prompt,
        verb,
        args: {
          ...baseArgs(),
          ...args
        }
      }
    },
    controller
  });

  assert.equal(response.isError, false);
  assert.ok(response.structuredContent && typeof response.structuredContent === "object");
  return response.structuredContent;
}

function baseArgs() {
  return {
    anchors: {
      entrypoint: "src/index.ts",
      definition: "main",
      agGridOriginChain: [
        "Table",
        "ColumnDef",
        "CellRenderer",
        "NavTrigger",
        "Route",
        "Component"
      ]
    },
    lexemes: ["swagger", "ag-grid"],
    taskConstraints: ["mcp handler smoke"],
    validationPlan: ["npm test"],
    activePolicies: ["policy:core:no_adp"],
    policyVersionSet: {
      core: "1"
    }
  };
}

function makePlanGraph(input) {
  return {
    workId,
    agentId,
    runSessionId,
    repoSnapshotId: "snap_mcp_smoke",
    worktreeRoot: input.worktreeRoot,
    contextPackRef: path.join(repoRoot, ".ai", "tmp", "context", runSessionId, workId, "context_pack.json"),
    contextPackHash: "hash_mcp_smoke",
    policyVersionSet: {
      core: "1"
    },
    scopeAllowlistRef: input.scopeAllowlistRef,
    knowledgeStrategyId: "ui_aggrid_feature",
    knowledgeStrategyReasons: [
      {
        reason: "mcp smoke",
        evidenceRef: "test:mcp_smoke"
      }
    ],
    evidencePolicy: {
      minRequirementSources: 1,
      minCodeEvidenceSources: 1,
      minPolicySources: 0,
      allowSingleSourceWithGuard: true,
      lowEvidenceGuardRules: ["guard_required"],
      distinctSourceDefinition: "artifact-or-file"
    },
    planFingerprint: "fp_mcp_smoke",
    sourceTraceRefs: ["trace_mcp_smoke"],
    schemaVersion: "1.0.0",
    nodes: [
      {
        nodeId: "node_change",
        kind: "change",
        dependsOn: [],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac1"],
          outOfScopeAcceptanceCriteriaIds: ["ac2"],
          inScopeModules: ["sample"],
          outOfScopeModules: ["other"]
        },
        expectedFailureSignatures: ["NOT_FOUND"],
        correctionCandidateOnFail: true,
        operation: "modify",
        targetFile: input.targetFileName,
        targetSymbols: ["TargetSymbol"],
        whyThisFile: "mcp smoke target",
        editIntent: "replace token",
        escalateIf: ["symbol_not_found"],
        citations: ["jira:ABC-123", "codemod:rename_identifier_in_file"],
        codeEvidence: ["sym:TargetSymbol"],
        artifactRefs: ["jira:ABC-123"],
        policyRefs: [],
        verificationHooks: ["npm test"]
      },
      {
        nodeId: "node_validate",
        kind: "validate",
        dependsOn: ["node_change"],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac1"],
          outOfScopeAcceptanceCriteriaIds: ["ac2"],
          inScopeModules: ["sample"],
          outOfScopeModules: ["other"]
        },
        expectedFailureSignatures: ["VALIDATION_FAIL"],
        correctionCandidateOnFail: true,
        verificationHooks: ["npm test"],
        mapsToNodeIds: ["node_change"],
        successCriteria: "mcp smoke checks pass"
      },
      {
        nodeId: "node_side",
        kind: "side_effect",
        dependsOn: ["node_validate"],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac1"],
          outOfScopeAcceptanceCriteriaIds: ["ac2"],
          inScopeModules: ["sample"],
          outOfScopeModules: ["other"]
        },
        expectedFailureSignatures: ["SIDE_EFFECT_FAIL"],
        correctionCandidateOnFail: true,
        sideEffectType: "integration_ping",
        sideEffectPayloadRef: "artifact://side_effect/payload",
        commitGateId: "gate_1"
      }
    ]
  };
}

async function syncGraphDb(phase) {
  if (process.env.E2E_SKIP_GRAPH_RESET === "1") {
    return;
  }
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    await execFileAsync(npmCmd, ["run", "graphops:sync"], {
      cwd: process.cwd(),
      env: process.env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`graphops:sync failed during ${phase}-e2e reset: ${message}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
