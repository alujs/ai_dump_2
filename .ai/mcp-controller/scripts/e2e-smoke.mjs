import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const mcpRoot = process.cwd();
const repoRoot = path.resolve(mcpRoot, "..", "..");
const port = 8733;
const baseUrl = `http://127.0.0.1:${port}`;

const runSessionId = "run_e2e_smoke";
const workId = "work_e2e_smoke";
const agentId = "agent_e2e_smoke";
const failRunSessionId = "run_e2e_fail";
const failWorkId = "work_e2e_fail";
const failAgentId = "agent_e2e_fail";
const budgetRunSessionId = "run_e2e_budget";
const budgetWorkId = "work_e2e_budget";
const budgetAgentId = "agent_e2e_budget";
const execFileAsync = promisify(execFile);

async function main() {
  await syncGraphDb("pre");
  const workRoot = path.join(repoRoot, ".ai", "tmp", "work", workId);
  await mkdir(workRoot, { recursive: true });
  const targetFile = path.join(workRoot, "sample.txt");
  await writeFile(targetFile, "const TargetSymbol = 'foo';\n", "utf8");

  const scopeAllowlistRef = path.join(workRoot, "scope.allowlist.json");
  await writeFile(
    scopeAllowlistRef,
    JSON.stringify(
      {
        files: ["sample.txt"],
        symbolsByFile: {
          "sample.txt": ["TargetSymbol"]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const server = spawn("npm", ["start"], {
    cwd: mcpRoot,
    env: {
      ...process.env,
      MCP_DASHBOARD_PORT: String(port)
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth(baseUrl, 30_000);

    const listResponse = await turn("list", {});
    assert.equal(listResponse.state, "PLAN_REQUIRED");
    assert.ok(Array.isArray(listResponse.capabilities));
    assert.ok(listResponse.capabilities.includes("submit_plan"));
    assert.equal(listResponse.subAgentHints.recommended, true);
    assert.ok(Array.isArray(listResponse.subAgentHints.suggestedSplits));
    assert.ok(listResponse.subAgentHints.suggestedSplits.length > 0);
    assert.equal(listResponse.budgetStatus.blocked, false);
    assert.equal(Boolean(listResponse.result.patchApplyOptions), true);
    assert.equal(Boolean(listResponse.result.patchApplyOptions?.customCodemodsAllowed), false);
    assert.ok(Array.isArray(listResponse.result.patchApplyOptions?.astCodemods));

    const contextPackRef = String(listResponse.result.contextPackRef ?? "");
    assert.ok(contextPackRef.length > 0);
    const contextPack = JSON.parse(await readFile(contextPackRef, "utf8"));
    assert.equal(Boolean(contextPack.expectations?.highSignalOnly), true);
    assert.equal(Boolean(contextPack.expectations?.minimumSufficientContext), true);
    assert.ok(Array.isArray(contextPack.scope?.allowedCapabilities));
    assert.equal(String(contextPack.retrievalDecision?.rerank?.algorithmId ?? ""), "deterministic_lexical_graph_v1");
    assert.ok(Array.isArray(contextPack.retrievalDecision?.rerank?.topLexical));
    assert.equal(Boolean(contextPack.executionOptions?.patchApply), true);
    assert.equal(Boolean(contextPack.executionOptions?.patchApply?.customCodemodsAllowed), false);

    const planGraph = makePlanGraph({
      scopeAllowlistRef
    });
    const submitResponse = await turn("submit_plan", { planGraph });
    assert.equal(submitResponse.state, "PLAN_ACCEPTED");
    assert.equal(String(submitResponse.result.planValidation ?? ""), "passed");

    const patchResponse = await turn("patch_apply", {
      nodeId: "node_change",
      targetFile: "sample.txt",
      targetSymbols: ["TargetSymbol"],
      operation: "replace_text",
      find: "foo",
      replace: "bar"
    });
    assert.equal(patchResponse.state, "EXECUTION_ENABLED");
    assert.equal(Number(patchResponse.result.patchApply?.replacements ?? 0) >= 1, true);

    const changed = await readFile(targetFile, "utf8");
    assert.ok(changed.includes("bar"));

    const astPatchResponse = await turn("patch_apply", {
      nodeId: "node_change",
      targetFile: "sample.txt",
      targetSymbols: ["TargetSymbol"],
      operation: "ast_codemod",
      codemodId: "rename_identifier_in_file",
      codemodParams: {
        from: "TargetSymbol",
        to: "TargetSymbolRenamed"
      }
    });
    assert.equal(astPatchResponse.state, "EXECUTION_ENABLED");
    assert.equal(String(astPatchResponse.result.patchApply?.codemodId ?? ""), "rename_identifier_in_file");
    const astChanged = await readFile(targetFile, "utf8");
    assert.ok(astChanged.includes("TargetSymbolRenamed"));

    const patchArtifactRef = String(patchResponse.result.patchApply?.artifactBundleRef ?? "");
    assert.ok(patchArtifactRef.length > 0);
    const patchResultPath = path.join(patchArtifactRef, "result.json");
    const patchResultRaw = await readFile(patchResultPath, "utf8");
    assert.ok(patchResultRaw.includes("\"replacements\""));

    const codeRunResponse = await turn("code_run", {
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
    });
    assert.equal(codeRunResponse.state, "EXECUTION_ENABLED");
    const codeRunArtifactRef = String(codeRunResponse.result.codeRun?.artifactBundleRef ?? "");
    assert.ok(codeRunArtifactRef.length > 0);

    const sideEffectResponse = await turn("side_effect", {
      nodeId: "node_side",
      commitGateId: "gate_1",
      files: [],
      symbols: [],
      graphMutations: [],
      externalSideEffects: ["gate_1"]
    });
    assert.equal(sideEffectResponse.state, "EXECUTION_ENABLED");
    assert.equal(Boolean(sideEffectResponse.result.sideEffect?.accepted), true);

    const recipeResponse = await turn("run_recipe", {
      recipeId: "replace_lexeme_in_file",
      planNodeId: "node_change",
      validatedParams: {
        targetFile: "sample.txt",
        find: "bar",
        replace: "baz"
      },
      artifactBundleRef: patchArtifactRef,
      diffSummaryRef: String(patchResponse.result.patchApply?.diffSummaryRef ?? "")
    });
    assert.equal(recipeResponse.denyReasons.length, 0);

    // Force repeated denials to ensure memory promotion + pending corrections are emitted.
    for (let i = 0; i < 3; i += 1) {
      const denied = await turnWithIdentity(
        {
          runSessionId: failRunSessionId,
          workId: failWorkId,
          agentId: failAgentId
        },
        "patch_apply",
        {
          nodeId: "node_change",
          targetFile: "missing.txt",
          targetSymbols: ["MissingSymbol"],
          operation: "replace_text",
          find: "A",
          replace: "B"
        },
        "Force repeated scope denials for memory promotion"
      );
      assert.ok(denied.denyReasons.includes("PLAN_SCOPE_VIOLATION"));
    }

    // Force token budget gate with a very large prompt payload.
    const budgetResponse = await turnWithIdentity(
      {
        runSessionId: budgetRunSessionId,
        workId: budgetWorkId,
        agentId: budgetAgentId
      },
      "patch_apply",
      {
        nodeId: "node_change",
        targetFile: "sample.txt",
        targetSymbols: ["TargetSymbol"],
        operation: "replace_text",
        find: "foo",
        replace: "bar"
      },
      `B${"x".repeat(260_000)}`
    );
    assert.equal(budgetResponse.state, "BLOCKED_BUDGET");
    assert.ok(budgetResponse.denyReasons.includes("BUDGET_THRESHOLD_EXCEEDED"));
    assert.equal(Boolean(budgetResponse.budgetStatus.blocked), true);

    const budgetList = await turnWithIdentity(
      {
        runSessionId: budgetRunSessionId,
        workId: budgetWorkId,
        agentId: budgetAgentId
      },
      "list",
      {},
      "Budget follow-up list"
    );
    assert.equal(budgetList.state, "BLOCKED_BUDGET");
    assert.ok(Array.isArray(budgetList.result.available));

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const worktrees = await fetchJson(`${baseUrl}/worktrees`);
    assert.ok(Array.isArray(worktrees.worktrees));
    assert.ok(worktrees.worktrees.some((entry) => String(entry.workId) === workId));

    const runs = await fetchJson(`${baseUrl}/runs`);
    assert.ok(Array.isArray(runs.runs));
    assert.ok(runs.runs.some((entry) => String(entry.runSessionId) === runSessionId));

    const errors = await fetchJson(`${baseUrl}/errors`);
    assert.ok(Array.isArray(errors.errors));
    assert.ok(errors.rejectionHeatmap && typeof errors.rejectionHeatmap === "object");

    const metrics = await fetchJson(`${baseUrl}/metrics`);
    assert.ok(typeof metrics.recentEvents === "number");

    const pending = await fetchJson(`${baseUrl}/policies/pending`);
    assert.ok(Array.isArray(pending.pendingCorrections));
    assert.ok(Array.isArray(pending.memoryPromotions));
    assert.ok(pending.pendingCorrections.length > 0);
    assert.ok(pending.memoryPromotions.length > 0);

    const observabilityPath = path.join(repoRoot, ".ai", "tmp", "observability", "events.jsonl");
    const eventRows = (await readFile(observabilityPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && typeof entry.type === "string");
    const eventTypes = new Set(eventRows.map((row) => row.type));
    assert.ok(eventTypes.has("input_envelope"));
    assert.ok(eventTypes.has("retrieval_trace"));
    assert.ok(eventTypes.has("output_envelope"));
    assert.ok(eventTypes.has("pending_correction_created"));

    const streamResponse = await fetch(`${baseUrl}/stream/events`, {
      headers: {
        Accept: "text/event-stream"
      }
    });
    assert.equal(streamResponse.status, 200);
    await streamResponse.body?.cancel();

    console.log("E2E smoke passed.");
    console.log(`Dashboard: ${baseUrl}`);
    console.log(`Run: ${runSessionId} Work: ${workId} Agent: ${agentId}`);
  } finally {
    await stopServer(server);
    await syncGraphDb("post");
    if (server.exitCode !== 0 && server.exitCode !== null) {
      console.error("Server exited non-zero during e2e run.");
      console.error(stdout);
      console.error(stderr);
    }
  }
}

async function syncGraphDb(phase) {
  if (process.env.E2E_SKIP_GRAPH_RESET === "1") {
    return;
  }
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    await execFileAsync(npmCmd, ["run", "graphops:sync"], {
      cwd: mcpRoot,
      env: process.env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`graphops:sync failed during ${phase}-e2e reset: ${message}`);
  }
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
    taskConstraints: ["scope to sample.txt"],
    validationPlan: ["npm test"],
    activePolicies: ["policy:core:no_adp"],
    policyVersionSet: {
      core: "1"
    }
  };
}

async function turn(verb, args) {
  return turnWithIdentity(
    {
      runSessionId,
      workId,
      agentId
    },
    verb,
    args,
    "E2E smoke run"
  );
}

async function turnWithIdentity(identity, verb, args, prompt) {
  const response = await fetch(`${baseUrl}/turn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      runSessionId: identity.runSessionId,
      workId: identity.workId,
      agentId: identity.agentId,
      originalPrompt: prompt,
      verb,
      args: {
        ...baseArgs(),
        ...args
      }
    })
  });
  assert.equal(response.status, 200);
  return response.json();
}

function makePlanGraph({ scopeAllowlistRef }) {
  return {
    workId,
    agentId,
    runSessionId,
    repoSnapshotId: "snap_e2e",
    worktreeRoot: path.join(repoRoot, ".ai", "tmp", "work", workId),
    contextPackRef: path.join(repoRoot, ".ai", "tmp", "context", runSessionId, workId, "context_pack.json"),
    contextPackHash: "hash_e2e",
    policyVersionSet: {
      core: "1"
    },
    scopeAllowlistRef,
    knowledgeStrategyId: "ui_aggrid_feature",
    knowledgeStrategyReasons: [
      {
        reason: "e2e smoke",
        evidenceRef: "test:e2e"
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
    planFingerprint: "fp_e2e",
    sourceTraceRefs: ["trace_e2e"],
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
        targetFile: "sample.txt",
        targetSymbols: ["TargetSymbol"],
        whyThisFile: "e2e smoke target",
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
        successCriteria: "smoke checks pass"
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

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore while warming up
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}/health`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(undefined))),
    sleep(timeoutMs)
  ]);
}

async function stopServer(child) {
  if (child.exitCode !== null) {
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  await waitForExit(child, 3_000);
  if (child.exitCode !== null) {
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  await waitForExit(child, 2_000);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
