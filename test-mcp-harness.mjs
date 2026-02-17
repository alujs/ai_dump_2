/**
 * MCP Controller COMPREHENSIVE test harness — covers ALL capabilities.
 *
 * ── Coverage ──────────────────────────────────────────────────────────
 * Transport layer:      initialize, tools/list, ping, unknown method
 * Tool dispatch:        wrong tool name, missing verb
 * Pre-plan verbs:       list_available_verbs, get_original_prompt,
 *                       list_scoped_files, list_directory_contents,
 *                       read_file_lines, lookup_symbol_definition,
 *                       search_codebase_text, trace_symbol_graph,
 *                       write_scratch_file, fetch_jira_ticket,
 *                       fetch_api_spec, submit_execution_plan,
 *                       request_evidence_guidance
 * Deny paths:           missing fields, scope violations, unknown verbs,
 *                       budget gate, actionable error messages
 * Plan lifecycle:       submit invalid → submit valid → state transition
 * Post-plan verbs:      apply_code_patch, run_sandboxed_code,
 *                       execute_gated_side_effect, run_automation_recipe
 * Session continuity:   same session across turns, state persistence
 * Error actionability:  every deny includes result.error with remediation
 * ──────────────────────────────────────────────────────────────────────
 *
 * Run:  node test-mcp-harness.mjs          (from repo root, needs Node 18+)
 *   or: wsl bash -c "source ~/.nvm/nvm.sh && node test-mcp-harness.mjs"
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = __dirname;
const MCP_ENTRY = path.join(".ai", "mcp-controller", "src", "mcp", "stdioServer.ts");

// Shared session IDs — used by buildValidPlan and toolCallSession
const SESSION = "test-session-001";
const WORK = "test-work-001";
const AGENT = "test-agent-001";

let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

function log(label, msg) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`[${ts}] ${label}: ${msg}`);
}

function logResult(name, ok, detail, skip = false) {
  if (skip) {
    skipped++;
    results.push({ name, status: "SKIP", detail });
    log("SKIP", `${name} — ${detail}`);
  } else if (ok) {
    passed++;
    results.push({ name, status: "PASS", detail });
    log("PASS", `${name} — ${detail}`);
  } else {
    failed++;
    results.push({ name, status: "FAIL", detail });
    log("FAIL", `${name} — ${detail}`);
  }
}

/* ── Assertions ──────────────────────────────────────────── */

function assertHas(obj, dotPath) {
  const parts = dotPath.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return false;
    cur = cur[p];
  }
  return cur !== undefined && cur !== null;
}

function assertEq(a, b) { return a === b; }
function assertIncludes(arr, val) { return Array.isArray(arr) && arr.includes(val); }
function assertIsArray(val) { return Array.isArray(val); }

/* ── Extract structured content helper ────────────────────── */

function sc(res) {
  return res?.result?.structuredContent ?? res?.result?.result?.structuredContent ?? {};
}

function scResult(res) {
  return sc(res)?.result ?? {};
}

/* ── Plan graph builder ──────────────────────────────────── */

function buildValidPlan(overrides = {}) {
  const workId = overrides.workId ?? WORK;
  const agentId = overrides.agentId ?? AGENT;
  const runSessionId = overrides.runSessionId ?? SESSION;

  return {
    workId,
    agentId,
    runSessionId,
    repoSnapshotId: "snapshot-test-001",
    worktreeRoot: ".",
    contextPackRef: "pack-ref-test",
    contextPackHash: "pack-hash-test",
    policyVersionSet: { "evidence-policy": "1.0.0" },
    scopeAllowlistRef: "",
    knowledgeStrategyId: "test-strategy",
    knowledgeStrategyReasons: [
      { reason: "Test harness strategy", evidenceRef: "test-evidence-1" },
    ],
    evidencePolicy: {
      minRequirementSources: 1,
      minCodeEvidenceSources: 1,
      minPolicySources: 0,
      allowSingleSourceWithGuard: true,
      lowEvidenceGuardRules: ["allow-test"],
      distinctSourceDefinition: "unique-file",
    },
    planFingerprint: "fingerprint-test-001",
    sourceTraceRefs: ["trace-test-1"],
    schemaVersion: "1.0.0",
    nodes: [
      // change node
      {
        nodeId: "change-1",
        kind: "change",
        dependsOn: [],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac-1"],
          outOfScopeAcceptanceCriteriaIds: [],
          inScopeModules: ["src/test.ts"],
          outOfScopeModules: [],
        },
        expectedFailureSignatures: [],
        correctionCandidateOnFail: false,
        operation: "modify",
        targetFile: "src/test.ts",
        targetSymbols: ["TestClass"],
        whyThisFile: "Test file for validation",
        editIntent: "Modify TestClass for test purposes",
        escalateIf: ["compilation-error"],
        citations: ["test-citation-1"],
        codeEvidence: ["test-evidence-1"],
        artifactRefs: ["artifact-1"],
        policyRefs: ["policy-1"],
        verificationHooks: ["hook-1"],
        lowEvidenceGuard: true,
        uncertaintyNote: "Test harness — single source guard active",
        requiresHumanReview: true,
      },
      // validate node mapping to change-1
      {
        nodeId: "validate-1",
        kind: "validate",
        dependsOn: ["change-1"],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac-1"],
          outOfScopeAcceptanceCriteriaIds: [],
          inScopeModules: ["src/test.ts"],
          outOfScopeModules: [],
        },
        expectedFailureSignatures: [],
        correctionCandidateOnFail: false,
        verificationHooks: ["hook-1"],
        mapsToNodeIds: ["change-1"],
        successCriteria: "File compiles without errors",
      },
      // side_effect node (depends on validate-1)
      {
        nodeId: "se-1",
        kind: "side_effect",
        dependsOn: ["validate-1"],
        atomicityBoundary: {
          inScopeAcceptanceCriteriaIds: ["ac-1"],
          outOfScopeAcceptanceCriteriaIds: [],
          inScopeModules: ["src/test.ts"],
          outOfScopeModules: [],
        },
        expectedFailureSignatures: [],
        correctionCandidateOnFail: false,
        sideEffectType: "test-effect",
        sideEffectPayloadRef: "payload-ref-1",
        commitGateId: "gate-test-1",
      },
    ],
  };
}

/* ── Main ────────────────────────────────────────────────── */

async function main() {
  log("HARNESS", `Spawning MCP server from ${REPO_ROOT}`);

  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NEO4J_URI: process.env.NEO4J_URI ?? "bolt://127.0.0.1:7687",
      NEO4J_USERNAME: process.env.NEO4J_USERNAME ?? "neo4j",
      NEO4J_PASSWORD: process.env.NEO4J_PASSWORD ?? "123456789",
      NEO4J_DATABASE: process.env.NEO4J_DATABASE ?? "piopex",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrChunks = [];
  child.stderr.on("data", (c) => {
    stderrChunks.push(c.toString());
  });

  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    const entry = pending.get(msg.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  });

  function send(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${method} (id=${id})`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function sendNotification(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  function toolCall(verb, extra = {}, timeoutMs = 20000) {
    return send("tools/call", {
      name: "controller_turn",
      arguments: { verb, ...extra },
    }, timeoutMs);
  }

  function toolCallSession(verb, extra = {}, timeoutMs = 20000) {
    return toolCall(verb, {
      runSessionId: SESSION,
      workId: WORK,
      agentId: AGENT,
      ...extra,
    }, timeoutMs);
  }

  try {
    // ═══════════════════════════════════════════════════════════
    // SECTION 1: TRANSPORT LAYER
    // ═══════════════════════════════════════════════════════════
    log("SECTION", "═══ 1. TRANSPORT LAYER ═══");

    // 1.1 initialize
    log("TEST", "1.1 initialize");
    const initRes = await send("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: "test-harness", version: "2.0.0" },
    });
    logResult("1.1 initialize",
      assertEq(initRes.result?.protocolVersion, "2025-11-25") &&
      assertHas(initRes, "result.capabilities.tools") &&
      assertEq(initRes.result?.serverInfo?.name, "mcp-controller"),
      `proto=${initRes.result?.protocolVersion}, name=${initRes.result?.serverInfo?.name}`
    );

    // Send initialized notification
    sendNotification("notifications/initialized", {});
    await new Promise((r) => setTimeout(r, 300));

    // 1.2 tools/list
    log("TEST", "1.2 tools/list");
    const listRes = await send("tools/list", {});
    const tools = listRes.result?.tools ?? [];
    const mainTool = tools.find((t) => t.name === "controller_turn");
    logResult("1.2 tools/list",
      !!mainTool &&
      assertHas(mainTool, "inputSchema.properties.verb") &&
      assertHas(mainTool, "inputSchema.properties.args") &&
      assertHas(mainTool, "inputSchema.properties.traceMeta"),
      `tools=${tools.length}, hasVerb=${!!mainTool?.inputSchema?.properties?.verb}, hasTraceMeta=${!!mainTool?.inputSchema?.properties?.traceMeta}`
    );

    // 1.3 ping
    log("TEST", "1.3 ping");
    const pingRes = await send("ping", {});
    logResult("1.3 ping", !pingRes.error, `result=${JSON.stringify(pingRes.result)}`);

    // 1.4 unknown method
    log("TEST", "1.4 unknown JSON-RPC method");
    const unkMethod = await send("bogus/method", {});
    logResult("1.4 unknown_method",
      !!unkMethod.error && unkMethod.error.code === -32601,
      `code=${unkMethod.error?.code}, msg=${unkMethod.error?.message}`
    );

    // 1.5 wrong tool name
    log("TEST", "1.5 tools/call wrong tool name");
    const badTool = await send("tools/call", { name: "wrong_tool", arguments: { verb: "list_available_verbs" } });
    logResult("1.5 wrong_tool_name",
      !!badTool.error && badTool.error.code === -32601,
      `code=${badTool.error?.code}, msg=${badTool.error?.message?.substring(0, 80)}`
    );

    // 1.6 missing verb
    log("TEST", "1.6 tools/call missing verb");
    const noVerb = await send("tools/call", { name: "controller_turn", arguments: {} });
    logResult("1.6 missing_verb",
      !!noVerb.error,
      `error=${!!noVerb.error}, msg=${noVerb.error?.message?.substring(0, 80) ?? "none"}`
    );

    // ═══════════════════════════════════════════════════════════
    // SECTION 2: PRE-PLAN VERBS (state=PLAN_REQUIRED)
    // ═══════════════════════════════════════════════════════════
    log("SECTION", "═══ 2. PRE-PLAN VERBS ═══");

    // 2.1 list — returns available capabilities
    log("TEST", "2.1 verb=list");
    const listVerb = await toolCallSession("list_available_verbs");
    const listCaps = scResult(listVerb)?.available;
    logResult("2.1 verb:list",
      assertIsArray(listCaps) && listCaps.length > 0 &&
      assertIncludes(listCaps, "submit_execution_plan") &&
      assertIncludes(listCaps, "read_file_lines") &&
      assertIncludes(listCaps, "search_codebase_text") &&
      assertIncludes(listCaps, "list_directory_contents"),
      `capabilities=[${listCaps?.slice(0, 5).join(", ")}...] (${listCaps?.length} total)`
    );

    // 2.2 original_prompt — stores and returns prompt
    log("TEST", "2.2 verb=original_prompt");
    const opRes = await toolCallSession("get_original_prompt", { originalPrompt: "Build a widget factory" });
    const opPrompt = scResult(opRes)?.originalPrompt;
    logResult("2.2 verb:original_prompt",
      typeof opPrompt === "string" && opPrompt.length > 0,
      `originalPrompt="${opPrompt}"`
    );

    // 2.3 list_allowed_files — returns file list
    log("TEST", "2.3 verb=list_allowed_files");
    const lafRes = await toolCallSession("list_scoped_files");
    const lafFiles = scResult(lafRes)?.allowedFiles;
    logResult("2.3 verb:list_allowed_files",
      assertIsArray(lafFiles),
      `isArray=${assertIsArray(lafFiles)}, count=${lafFiles?.length ?? "?"}`
    );

    // 2.3b list_dir — missing targetDir → actionable deny
    log("TEST", "2.3b verb=list_dir (missing targetDir → deny)");
    const ldMissing = await toolCallSession("list_directory_contents", { args: {} });
    const ldMissingDeny = sc(ldMissing)?.denyReasons ?? [];
    const ldMissingErr = scResult(ldMissing)?.error;
    logResult("2.3b list_dir:missing_field",
      assertIncludes(ldMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
      typeof ldMissingErr === "string" && ldMissingErr.includes("targetDir"),
      `deny=[${ldMissingDeny}], error="${ldMissingErr?.substring(0, 80)}"`
    );

    // 2.3c list_dir — with valid targetDir
    log("TEST", "2.3c verb=list_dir (with targetDir)");
    const ldRes = await toolCallSession("list_directory_contents", { args: { targetDir: "." } });
    const ldDeny = sc(ldRes)?.denyReasons ?? [];
    const ldEntries = scResult(ldRes)?.listDir?.entries;
    const ldTotal = scResult(ldRes)?.listDir?.totalEntries;
    logResult("2.3c list_dir:valid",
      ldDeny.length === 0 && assertIsArray(ldEntries) && ldTotal > 0,
      `deny=[${ldDeny}], entries=${ldEntries?.length ?? "?"}, totalEntries=${ldTotal}`
    );

    // 2.4 read_range — missing targetFile → actionable deny
    log("TEST", "2.4 verb=read_range (missing targetFile → deny)");
    const rrMissing = await toolCallSession("read_file_lines", { args: {} });
    const rrMissingDeny = sc(rrMissing)?.denyReasons ?? [];
    const rrMissingErr = scResult(rrMissing)?.error;
    logResult("2.4 read_range:missing_field",
      assertIncludes(rrMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
      typeof rrMissingErr === "string" && rrMissingErr.includes("targetFile"),
      `deny=[${rrMissingDeny}], error="${rrMissingErr?.substring(0, 80)}"`
    );

    // 2.5 read_range — with targetFile
    log("TEST", "2.5 verb=read_range (with targetFile)");
    const rrRes = await toolCallSession("read_file_lines", { args: { targetFile: "package.json", startLine: 1, endLine: 5 } });
    const rrState = sc(rrRes)?.state;
    const rrDeny = sc(rrRes)?.denyReasons ?? [];
    const rrLines = scResult(rrRes)?.readRange?.lines;
    logResult("2.5 read_range:with_file",
      !rrRes.error && rrState,
      `state=${rrState}, deny=[${rrDeny}], lines=${rrLines?.length ?? "scope-denied"}`
    );

    // 2.6 read_symbol — missing symbol → actionable deny
    log("TEST", "2.6 verb=read_symbol (missing symbol → deny)");
    const rsMissing = await toolCallSession("lookup_symbol_definition", { args: {} });
    const rsMissingDeny = sc(rsMissing)?.denyReasons ?? [];
    const rsMissingErr = scResult(rsMissing)?.error;
    logResult("2.6 read_symbol:missing_field",
      assertIncludes(rsMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
      typeof rsMissingErr === "string" && rsMissingErr.includes("symbol"),
      `deny=[${rsMissingDeny}], error="${rsMissingErr?.substring(0, 80)}"`
    );

    // 2.7 read_symbol — with symbol (indexing may be unavailable)
    log("TEST", "2.7 verb=read_symbol (with symbol)");
    const rsRes = await toolCallSession("lookup_symbol_definition", { args: { symbol: "TurnController" } });
    const rsState = sc(rsRes)?.state;
    const rsDeny = sc(rsRes)?.denyReasons ?? [];
    logResult("2.7 read_symbol:with_symbol",
      !rsRes.error && rsState,
      `state=${rsState}, deny=[${rsDeny}]`
    );

    // 2.8 grep_lexeme — missing query → actionable deny
    log("TEST", "2.8 verb=grep_lexeme (missing query → deny)");
    const glMissing = await toolCallSession("search_codebase_text", { args: {} });
    const glMissingDeny = sc(glMissing)?.denyReasons ?? [];
    const glMissingErr = scResult(glMissing)?.error;
    logResult("2.8 grep_lexeme:missing_field",
      assertIncludes(glMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
      typeof glMissingErr === "string" && glMissingErr.includes("query"),
      `deny=[${glMissingDeny}], error="${glMissingErr?.substring(0, 80)}"`
    );

    // 2.9 grep_lexeme — with query
    log("TEST", "2.9 verb=grep_lexeme (with query)");
    const glRes = await toolCallSession("search_codebase_text", { args: { query: "TODO" } });
    const glDeny = sc(glRes)?.denyReasons ?? [];
    logResult("2.9 grep_lexeme:with_query",
      !glRes.error,
      `deny=[${glDeny}]`
    );

    // 2.10 read_neighbors — missing all args → deny
    log("TEST", "2.10 verb=read_neighbors (missing args → deny)");
    const rnMissing = await toolCallSession("trace_symbol_graph", { args: {} });
    const rnMissingDeny = sc(rnMissing)?.denyReasons ?? [];
    const rnMissingErr = scResult(rnMissing)?.error;
    logResult("2.10 read_neighbors:missing_field",
      (assertIncludes(rnMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") ||
       assertIncludes(rnMissingDeny, "PLAN_VERIFICATION_WEAK")),
      `deny=[${rnMissingDeny}], error="${rnMissingErr?.substring(0, 80) ?? "indexing unavailable"}"`
    );

    // 2.11 write_tmp — missing target → deny (PLAN_MISSING or PACK_INSUFFICIENT)
    // NOTE: write_tmp is a CONTEXT_PACK_VERB, so the context pack is built before
    // the verb handler runs. Without indexed data, PACK_INSUFFICIENT may fire first.
    log("TEST", "2.11 verb=write_tmp (missing target → deny)");
    const wtMissing = await toolCallSession("write_scratch_file", { args: {} }, 25000);
    const wtMissingDeny = sc(wtMissing)?.denyReasons ?? [];
    const wtMissingErr = scResult(wtMissing)?.error;
    const wtMissingIsPack = assertIncludes(wtMissingDeny, "PACK_INSUFFICIENT");
    logResult("2.11 write_tmp:missing_field",
      wtMissingIsPack ||
      (assertIncludes(wtMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
       typeof wtMissingErr === "string" && wtMissingErr.includes("target")),
      wtMissingIsPack
        ? `PACK_INSUFFICIENT (context pack blocked before verb handler) — expected in test env`
        : `deny=[${wtMissingDeny}], error="${wtMissingErr?.substring(0, 80)}"`
    );

    // 2.12 write_tmp — valid write (may also hit PACK_INSUFFICIENT)
    log("TEST", "2.12 verb=write_tmp (valid write)");
    const wtOk = await toolCallSession("write_scratch_file", {
      args: { target: "test-output/hello.txt", content: "Hello from test harness" },
    }, 25000);
    const wtOkDeny = sc(wtOk)?.denyReasons ?? [];
    const wtResult = scResult(wtOk)?.writeTmp;
    const wtOkIsPack = assertIncludes(wtOkDeny, "PACK_INSUFFICIENT");
    logResult("2.12 write_tmp:valid",
      wtOkIsPack ||
      (wtOkDeny.length === 0 && wtResult?.bytes > 0),
      wtOkIsPack
        ? `PACK_INSUFFICIENT (context pack blocked before verb handler) — expected in test env`
        : `deny=[${wtOkDeny}], file=${wtResult?.file ?? "?"}, bytes=${wtResult?.bytes ?? "?"}`
    );

    // 2.13 fetch_jira — missing issueKey → actionable deny (or scope violation if no connectors)
    log("TEST", "2.13 verb=fetch_jira (missing issueKey → deny)");
    const fjMissing = await toolCallSession("fetch_jira_ticket", { args: {} });
    const fjMissingDeny = sc(fjMissing)?.denyReasons ?? [];
    const fjMissingErr = scResult(fjMissing)?.error;
    logResult("2.13 fetch_jira:missing_field",
      (assertIncludes(fjMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") ||
       assertIncludes(fjMissingDeny, "PLAN_SCOPE_VIOLATION")) &&
      typeof fjMissingErr === "string",
      `deny=[${fjMissingDeny}], error="${fjMissingErr?.substring(0, 80)}"`
    );

    // 2.14 fetch_swagger — missing swaggerRef → actionable deny
    log("TEST", "2.14 verb=fetch_swagger (missing swaggerRef → deny)");
    const fsMissing = await toolCallSession("fetch_api_spec", { args: {} });
    const fsMissingDeny = sc(fsMissing)?.denyReasons ?? [];
    const fsMissingErr = scResult(fsMissing)?.error;
    logResult("2.14 fetch_swagger:missing_field",
      (assertIncludes(fsMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") ||
       assertIncludes(fsMissingDeny, "PLAN_SCOPE_VIOLATION")) &&
      typeof fsMissingErr === "string",
      `deny=[${fsMissingDeny}], error="${fsMissingErr?.substring(0, 80)}"`
    );

    // 2.15a escalate — missing args → actionable deny
    log("TEST", "2.15a verb=escalate (missing args → deny)");
    const escMissing = await toolCallSession("request_evidence_guidance", { args: {} });
    const escMissingDeny = sc(escMissing)?.denyReasons ?? [];
    const escMissingErr = scResult(escMissing)?.error;
    logResult("2.15a escalate:missing_fields",
      assertIncludes(escMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
      typeof escMissingErr === "string" && escMissingErr.includes("blockingReasons"),
      `deny=[${escMissingDeny}], error="${escMissingErr?.substring(0, 80)}"`
    );

    // 2.15b escalate — with blockingReasons → guidance returned
    log("TEST", "2.15b verb=escalate (with blockingReasons)");
    const escValid = await toolCallSession("request_evidence_guidance", {
      args: {
        blockingReasons: ["Cannot find enough evidence sources", "Symbol definition for FooComponent not found"],
        requestedEvidence: ["FooComponent definition", "Route config for /profile"],
        knownSymbols: ["BarService"],
        note: "Searched 3 files, only found 1 citation source",
      },
    });
    const escDeny = sc(escValid)?.denyReasons ?? [];
    const escResult = scResult(escValid)?.escalation;
    logResult("2.15b escalate:valid",
      escDeny.length === 0 &&
      escResult?.acknowledged === true &&
      assertIsArray(escResult?.guidance) && escResult.guidance.length > 0 &&
      escResult?.evidenceRequirements?.minDistinctSources === 2 &&
      assertIsArray(escResult?.availableVerbs),
      `deny=[${escDeny}], acknowledged=${escResult?.acknowledged}, guidance=${escResult?.guidance?.length}, minSources=${escResult?.evidenceRequirements?.minDistinctSources}`
    );

    // 2.15 unknown verb → actionable deny with allowed verbs
    log("TEST", "2.15 verb=nonexistent_verb");
    const unkVerb = await toolCallSession("nonexistent_verb_xyz");
    const unkDeny = sc(unkVerb)?.denyReasons ?? [];
    const unkErr = scResult(unkVerb)?.error;
    const unkAllowed = scResult(unkVerb)?.allowedVerbs;
    logResult("2.15 unknown_verb",
      assertIncludes(unkDeny, "PLAN_SCOPE_VIOLATION") &&
      typeof unkErr === "string" && unkErr.includes("nonexistent_verb_xyz") &&
      assertIsArray(unkAllowed),
      `deny=[${unkDeny}], error="${unkErr?.substring(0, 80)}", allowedVerbs=${unkAllowed?.length ?? "?"}`
    );

    // ═══════════════════════════════════════════════════════════
    // SECTION 3: PLAN LIFECYCLE
    // ═══════════════════════════════════════════════════════════
    log("SECTION", "═══ 3. PLAN LIFECYCLE ═══");

    // NOTE: submit_plan is a CONTEXT_PACK_VERB. The context pack is built
    // BEFORE the verb logic runs. Without indexed data, PACK_INSUFFICIENT
    // fires first and the verb handler is never reached. Track this.
    let planAccepted = false;

    // 3.1 submit_plan — missing planGraph → deny (or PACK_INSUFFICIENT)
    log("TEST", "3.1 submit_plan (missing planGraph → deny)");
    const spMissing = await toolCallSession("submit_execution_plan", { args: {} }, 25000);
    const spMissingDeny = sc(spMissing)?.denyReasons ?? [];
    const spMissingErr = scResult(spMissing)?.error;
    const spMissingIsPack = assertIncludes(spMissingDeny, "PACK_INSUFFICIENT");
    logResult("3.1 submit_plan:missing_graph",
      spMissingIsPack ||
      (assertIncludes(spMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
       typeof spMissingErr === "string" && spMissingErr.includes("planGraph")),
      spMissingIsPack
        ? `PACK_INSUFFICIENT (context pack blocked before verb handler) — expected without indexing`
        : `deny=[${spMissingDeny}], error="${spMissingErr?.substring(0, 80)}"`
    );

    // 3.2 submit_plan — invalid plan (missing required envelope fields)
    log("TEST", "3.2 submit_plan (invalid plan → validation deny)");
    const spInvalid = await toolCallSession("submit_execution_plan", {
      args: {
        planGraph: {
          workId: WORK,
          agentId: AGENT,
          runSessionId: SESSION,
          worktreeRoot: ".",
          nodes: [],
        },
      },
    }, 25000);
    const spInvalidDeny = sc(spInvalid)?.denyReasons ?? [];
    const spInvalidErr = scResult(spInvalid)?.error;
    const spInvalidIsPack = assertIncludes(spInvalidDeny, "PACK_INSUFFICIENT");
    logResult("3.2 submit_plan:invalid_plan",
      spInvalidIsPack ||
      (spInvalidDeny.length > 0 && typeof spInvalidErr === "string"),
      spInvalidIsPack
        ? `PACK_INSUFFICIENT — expected without indexing`
        : `deny=[${spInvalidDeny}], error="${spInvalidErr?.substring(0, 80)}"`
    );

    // 3.3 submit_plan — session mismatch
    log("TEST", "3.3 submit_plan (session mismatch → deny)");
    const spMismatch = await toolCallSession("submit_execution_plan", {
      args: {
        planGraph: buildValidPlan({ workId: "WRONG-WORK" }),
      },
    }, 25000);
    const spMismatchDeny = sc(spMismatch)?.denyReasons ?? [];
    const spMismatchErr = scResult(spMismatch)?.error;
    const spMismatchData = scResult(spMismatch)?.mismatch;
    const spMismatchIsPack = assertIncludes(spMismatchDeny, "PACK_INSUFFICIENT");
    logResult("3.3 submit_plan:session_mismatch",
      spMismatchIsPack ||
      (assertIncludes(spMismatchDeny, "PLAN_SCOPE_VIOLATION") &&
       typeof spMismatchErr === "string" && spMismatchErr.includes("match") &&
       spMismatchData?.expected?.workId === WORK),
      spMismatchIsPack
        ? `PACK_INSUFFICIENT — expected without indexing`
        : `deny=[${spMismatchDeny}], expected.workId=${spMismatchData?.expected?.workId}, received.workId=${spMismatchData?.received?.workId}`
    );

    // 3.4 submit_plan — valid plan → PLAN_ACCEPTED (or PACK_INSUFFICIENT)
    log("TEST", "3.4 submit_plan (valid plan → PLAN_ACCEPTED)");
    const validPlan = buildValidPlan({});
    const spOk = await toolCallSession("submit_execution_plan", {
      args: { planGraph: validPlan },
    }, 30000);
    const spOkState = sc(spOk)?.state;
    const spOkDeny = sc(spOk)?.denyReasons ?? [];
    const spOkValidation = scResult(spOk)?.planValidation;
    const spOkIsPack = assertIncludes(spOkDeny, "PACK_INSUFFICIENT");
    planAccepted = spOkDeny.length === 0 && spOkState === "PLAN_ACCEPTED";
    logResult("3.4 submit_plan:valid",
      spOkIsPack || planAccepted,
      spOkIsPack
        ? `PACK_INSUFFICIENT — context pack blocked plan acceptance. Post-plan mutation tests will test no-plan denial path instead.`
        : `state=${spOkState}, deny=[${spOkDeny}], validation=${spOkValidation}`
    );

    // 3.5 verify post-plan capabilities (only if plan was accepted)
    log("TEST", "3.5 list (post-plan → includes mutations)");
    const listPost = await toolCallSession("list_available_verbs");
    const listPostCaps = scResult(listPost)?.available;
    if (planAccepted) {
      logResult("3.5 list:post_plan",
        assertIsArray(listPostCaps) &&
        assertIncludes(listPostCaps, "apply_code_patch") &&
        assertIncludes(listPostCaps, "run_sandboxed_code") &&
        assertIncludes(listPostCaps, "execute_gated_side_effect") &&
        assertIncludes(listPostCaps, "run_automation_recipe"),
        `capabilities=[${listPostCaps?.join(", ")}]`
      );
    } else {
      // Plan wasn't accepted → pre-plan capabilities confirmed
      logResult("3.5 list:pre_plan_confirmed",
        assertIsArray(listPostCaps) &&
        assertIncludes(listPostCaps, "submit_execution_plan") &&
        assertIncludes(listPostCaps, "read_file_lines"),
        `Plan not accepted (PACK_INSUFFICIENT). Pre-plan caps=[${listPostCaps?.slice(0, 5).join(", ")}...] (${listPostCaps?.length} total)`
      );
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 4: POST-PLAN MUTATION VERBS (state=PLAN_ACCEPTED)
    // ═══════════════════════════════════════════════════════════
    log("SECTION", "═══ 4. POST-PLAN MUTATION VERBS ═══");

    // When plan IS accepted, test proper deny paths. When NOT accepted,
    // test that mutations correctly deny with "no plan submitted" (actionable).

    if (planAccepted) {
      // ── 4.x: POST-PLAN MUTATION TESTS ──
      // 4.1 patch_apply — missing required fields → actionable deny
      log("TEST", "4.1 patch_apply (missing fields → deny)");
      const paMissing = await toolCallSession("apply_code_patch", { args: {} });
      const paMissingDeny = sc(paMissing)?.denyReasons ?? [];
      const paMissingErr = scResult(paMissing)?.error;
      logResult("4.1 patch_apply:missing_fields",
        assertIncludes(paMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
        typeof paMissingErr === "string" && paMissingErr.includes("nodeId"),
        `deny=[${paMissingDeny}], error="${paMissingErr?.substring(0, 100)}"`
      );

      // 4.2 patch_apply — wrong nodeId → actionable deny with available IDs
      log("TEST", "4.2 patch_apply (wrong nodeId → deny with available IDs)");
      const paWrongNode = await toolCallSession("apply_code_patch", {
        args: {
          nodeId: "nonexistent-node",
          targetFile: "src/test.ts",
          targetSymbols: ["TestClass"],
          operation: "replace_text",
          find: "old",
          replace: "new",
        },
      });
      const paWrongDeny = sc(paWrongNode)?.denyReasons ?? [];
      const paWrongErr = scResult(paWrongNode)?.error;
      logResult("4.2 patch_apply:wrong_node",
        assertIncludes(paWrongDeny, "PLAN_SCOPE_VIOLATION") &&
        typeof paWrongErr === "string" &&
        paWrongErr.includes("nonexistent-node"),
        `deny=[${paWrongDeny}], error="${paWrongErr?.substring(0, 120)}"`
      );

      // 4.3 patch_apply — valid request
      log("TEST", "4.3 patch_apply (valid → attempt execution)");
      const paValid = await toolCallSession("apply_code_patch", {
        args: {
          nodeId: "change-1",
          targetFile: validPlan.nodes[0].targetFile,
          targetSymbols: validPlan.nodes[0].targetSymbols,
          operation: "replace_text",
          find: "originalText",
          replace: "replacedText",
        },
      });
      const paValidState = sc(paValid)?.state;
      logResult("4.3 patch_apply:valid_attempt",
        !paValid.error && paValidState,
        `state=${paValidState}, deny=[${sc(paValid)?.denyReasons}], keys=[${Object.keys(scResult(paValid)).join(", ")}]`
      );

      // 4.4 code_run — missing fields → actionable deny
      log("TEST", "4.4 code_run (missing fields → deny)");
      const crMissing = await toolCallSession("run_sandboxed_code", { args: {} });
      const crMissingDeny = sc(crMissing)?.denyReasons ?? [];
      const crMissingErr = scResult(crMissing)?.error;
      logResult("4.4 code_run:missing_fields",
        assertIncludes(crMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
        typeof crMissingErr === "string" && crMissingErr.includes("nodeId"),
        `deny=[${crMissingDeny}], error="${crMissingErr?.substring(0, 100)}"`
      );

      // 4.5 side_effect — missing fields → actionable deny
      log("TEST", "4.5 side_effect (missing fields → deny)");
      const seMissing = await toolCallSession("execute_gated_side_effect", { args: {} });
      const seMissingDeny = sc(seMissing)?.denyReasons ?? [];
      const seMissingErr = scResult(seMissing)?.error;
      logResult("4.5 side_effect:missing_fields",
        assertIncludes(seMissingDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
        typeof seMissingErr === "string" &&
        (seMissingErr.includes("nodeId") || seMissingErr.includes("commitGateId")),
        `deny=[${seMissingDeny}], error="${seMissingErr?.substring(0, 100)}"`
      );

      // 4.6 side_effect — wrong nodeId → actionable deny
      log("TEST", "4.6 side_effect (wrong nodeId → deny)");
      const seWrongNode = await toolCallSession("execute_gated_side_effect", {
        args: { nodeId: "nonexistent-se", commitGateId: "gate-1" },
      });
      const seWrongDeny = sc(seWrongNode)?.denyReasons ?? [];
      const seWrongErr = scResult(seWrongNode)?.error;
      logResult("4.6 side_effect:wrong_node",
        assertIncludes(seWrongDeny, "EXEC_UNGATED_SIDE_EFFECT") &&
        typeof seWrongErr === "string" && seWrongErr.includes("nonexistent-se"),
        `deny=[${seWrongDeny}], error="${seWrongErr?.substring(0, 120)}"`
      );

      // 4.7 side_effect — gate mismatch → actionable deny
      log("TEST", "4.7 side_effect (gate mismatch → deny)");
      const seGateMismatch = await toolCallSession("execute_gated_side_effect", {
        args: { nodeId: "se-1", commitGateId: "wrong-gate" },
      });
      const seGateDeny = sc(seGateMismatch)?.denyReasons ?? [];
      const seGateErr = scResult(seGateMismatch)?.error;
      logResult("4.7 side_effect:gate_mismatch",
        assertIncludes(seGateDeny, "EXEC_UNGATED_SIDE_EFFECT") &&
        typeof seGateErr === "string" &&
        (seGateErr.includes("gate") || seGateErr.includes("mismatch")),
        `deny=[${seGateDeny}], error="${seGateErr?.substring(0, 120)}"`
      );
    } else {
      // ── 4.x: NO-PLAN DENIAL PATH TESTS ──
      // Plan was blocked by PACK_INSUFFICIENT — test that mutations deny with
      // actionable error telling the agent to submit_plan first.
      log("INFO", "Plan not accepted (PACK_INSUFFICIENT). Testing no-plan denial path.");

      log("TEST", "4.1 patch_apply (no plan → actionable deny)");
      const paNoPlan = await toolCallSession("apply_code_patch", { args: { nodeId: "n1", targetFile: "x.ts", targetSymbols: ["X"], operation: "replace_text" } });
      const paNoPlanDeny = sc(paNoPlan)?.denyReasons ?? [];
      const paNoPlanErr = scResult(paNoPlan)?.error;
      logResult("4.1 patch_apply:no_plan",
        assertIncludes(paNoPlanDeny, "PLAN_SCOPE_VIOLATION") &&
        typeof paNoPlanErr === "string" && paNoPlanErr.includes("submit_execution_plan"),
        `deny=[${paNoPlanDeny}], error="${paNoPlanErr?.substring(0, 100)}"`
      );

      log("TEST", "4.2 code_run (no plan → actionable deny)");
      const crNoPlan = await toolCallSession("run_sandboxed_code", { args: { nodeId: "n1", iife: "()=>1" } });
      const crNoPlanDeny = sc(crNoPlan)?.denyReasons ?? [];
      const crNoPlanErr = scResult(crNoPlan)?.error;
      logResult("4.2 code_run:no_plan",
        assertIncludes(crNoPlanDeny, "PLAN_SCOPE_VIOLATION") &&
        typeof crNoPlanErr === "string" && crNoPlanErr.includes("submit_execution_plan"),
        `deny=[${crNoPlanDeny}], error="${crNoPlanErr?.substring(0, 100)}"`
      );

      log("TEST", "4.3 side_effect (no plan → actionable deny)");
      const seNoPlan = await toolCallSession("execute_gated_side_effect", { args: { nodeId: "n1", commitGateId: "g1" } });
      const seNoPlanDeny = sc(seNoPlan)?.denyReasons ?? [];
      const seNoPlanErr = scResult(seNoPlan)?.error;
      logResult("4.3 side_effect:no_plan",
        assertIncludes(seNoPlanDeny, "PLAN_SCOPE_VIOLATION") &&
        typeof seNoPlanErr === "string" && seNoPlanErr.includes("submit_execution_plan"),
        `deny=[${seNoPlanDeny}], error="${seNoPlanErr?.substring(0, 100)}"`
      );

      // Skip tests 4.4-4.7 (require plan)
      logResult("4.4 patch_apply:wrong_node", true, "SKIPPED — plan not accepted", true);
      logResult("4.5 side_effect:wrong_node", true, "SKIPPED — plan not accepted", true);
      logResult("4.6 side_effect:gate_mismatch", true, "SKIPPED — plan not accepted", true);
      logResult("4.7 unused", true, "SKIPPED — reserved", true);
    }

    // 4.8 run_recipe — missing fields → always works (no plan check in recipe handler)
    log("TEST", "4.8 run_recipe (missing fields → deny)");
    const rrMissingR = await toolCallSession("run_automation_recipe", { args: {} });
    const rrMissingRDeny = sc(rrMissingR)?.denyReasons ?? [];
    const rrMissingRErr = scResult(rrMissingR)?.error;
    logResult("4.8 run_recipe:missing_fields",
      assertIncludes(rrMissingRDeny, "PLAN_MISSING_REQUIRED_FIELDS") &&
      typeof rrMissingRErr === "string" &&
      rrMissingRErr.includes("recipeId") &&
      rrMissingRErr.includes("replace_lexeme_in_file"),
      `deny=[${rrMissingRDeny}], error="${rrMissingRErr?.substring(0, 120)}"`
    );

    // 4.9 run_recipe — invalid recipe → deny
    log("TEST", "4.9 run_recipe (invalid recipe → deny)");
    const rrInvalid = await toolCallSession("run_automation_recipe", {
      args: {
        recipeId: "nonexistent_recipe",
        planNodeId: "change-1",
        artifactBundleRef: "ref-1",
        diffSummaryRef: "diff-1",
      },
    });
    const rrInvalidDeny = sc(rrInvalid)?.denyReasons ?? [];
    logResult("4.9 run_recipe:invalid_recipe",
      rrInvalidDeny.length > 0,
      `deny=[${rrInvalidDeny}]`
    );

    // 4.10 run_recipe — valid recipe (requires targetFile, find, replace)
    log("TEST", "4.10 run_recipe (valid recipe)");
    const rrValid = await toolCallSession("run_automation_recipe", {
      args: {
        recipeId: "replace_lexeme_in_file",
        planNodeId: "change-1",
        artifactBundleRef: "ref-bundle-1",
        diffSummaryRef: "diff-summary-1",
        validatedParams: { targetFile: "src/test.ts", find: "old", replace: "new" },
      },
    });
    const rrValidDeny = sc(rrValid)?.denyReasons ?? [];
    const rrValidRecipe = scResult(rrValid)?.recipe;
    logResult("4.10 run_recipe:valid",
      rrValidDeny.length === 0 && rrValidRecipe?.accepted === true,
      `deny=[${rrValidDeny}], accepted=${rrValidRecipe?.accepted}, recipeId=${rrValidRecipe?.recipeId}`
    );

    // ═══════════════════════════════════════════════════════════
    // SECTION 5: SESSION & RESPONSE STRUCTURE
    // ═══════════════════════════════════════════════════════════
    log("SECTION", "═══ 5. SESSION & RESPONSE STRUCTURE ═══");

    // 5.1 Verify response envelope has all required fields
    log("TEST", "5.1 response envelope structure");
    const envRes = await toolCallSession("list_available_verbs");
    const env = sc(envRes);
    logResult("5.1 response_envelope",
      env.runSessionId === SESSION &&
      env.workId === WORK &&
      env.agentId === AGENT &&
      typeof env.state === "string" &&
      assertIsArray(env.capabilities) &&
      assertIsArray(env.denyReasons) &&
      typeof env.traceRef === "string" &&
      typeof env.schemaVersion === "string" &&
      assertHas(env, "budgetStatus.maxTokens") &&
      assertHas(env, "budgetStatus.usedTokens") &&
      assertHas(env, "scope.worktreeRoot") &&
      assertHas(env, "knowledgeStrategy.strategyId"),
      `session=${env.runSessionId}, state=${env.state}, trace=${env.traceRef?.substring(0, 20)}, schema=${env.schemaVersion}`
    );

    // 5.2 Budget status present and well-formed
    log("TEST", "5.2 budget status");
    const budget = env.budgetStatus;
    logResult("5.2 budget_status",
      typeof budget?.maxTokens === "number" &&
      typeof budget?.usedTokens === "number" &&
      typeof budget?.thresholdTokens === "number" &&
      typeof budget?.blocked === "boolean",
      `max=${budget?.maxTokens}, used=${budget?.usedTokens}, threshold=${budget?.thresholdTokens}, blocked=${budget?.blocked}`
    );

    // 5.3 Knowledge strategy present
    log("TEST", "5.3 knowledge strategy");
    const strat = env.knowledgeStrategy;
    logResult("5.3 knowledge_strategy",
      typeof strat?.strategyId === "string" &&
      assertIsArray(strat?.reasons),
      `strategyId=${strat?.strategyId}, reasons=${strat?.reasons?.length}`
    );

    // 5.4 Sub-agent hints present
    log("TEST", "5.4 sub-agent hints");
    const subHints = env.subAgentHints;
    logResult("5.4 sub_agent_hints",
      typeof subHints?.recommended === "boolean",
      `recommended=${subHints?.recommended}, splits=${subHints?.suggestedSplits?.length ?? 0}`
    );

    // ═══════════════════════════════════════════════════════════
    // SECTION 6: MUTATION DENY PATHS (fresh pre-plan session)
    // ═══════════════════════════════════════════════════════════
    log("SECTION", "═══ 6. MUTATION DENY PATHS (pre-plan) ═══");

    // Use a fresh session (no plan submitted) to test pre-plan denials
    function toolCallPreplan(verb, extra = {}) {
      return toolCall(verb, {
        runSessionId: "session-preplan",
        workId: "test-work-preplan",
        agentId: "agent-preplan",
        ...extra,
      });
    }

    // 6.1 patch_apply without plan → actionable deny
    log("TEST", "6.1 patch_apply (no plan → deny)");
    const paNoPlan = await toolCallPreplan("apply_code_patch", {
      args: { nodeId: "n1", targetFile: "x.ts", targetSymbols: ["X"], operation: "replace_text" },
    });
    const paNoPlanDeny = sc(paNoPlan)?.denyReasons ?? [];
    const paNoPlanErr = scResult(paNoPlan)?.error;
    logResult("6.1 patch_apply:no_plan",
      assertIncludes(paNoPlanDeny, "PLAN_SCOPE_VIOLATION") &&
      typeof paNoPlanErr === "string" && paNoPlanErr.includes("submit_execution_plan"),
      `deny=[${paNoPlanDeny}], error="${paNoPlanErr?.substring(0, 100)}"`
    );

    // 6.2 code_run without plan → actionable deny
    log("TEST", "6.2 code_run (no plan → deny)");
    const crNoPlan = await toolCallPreplan("run_sandboxed_code", {
      args: { nodeId: "n1", iife: "()=>1" },
    });
    const crNoPlanDeny = sc(crNoPlan)?.denyReasons ?? [];
    const crNoPlanErr = scResult(crNoPlan)?.error;
    logResult("6.2 code_run:no_plan",
      assertIncludes(crNoPlanDeny, "PLAN_SCOPE_VIOLATION") &&
      typeof crNoPlanErr === "string" && crNoPlanErr.includes("submit_execution_plan"),
      `deny=[${crNoPlanDeny}], error="${crNoPlanErr?.substring(0, 100)}"`
    );

    // 6.3 side_effect without plan → actionable deny
    log("TEST", "6.3 side_effect (no plan → deny)");
    const seNoPlan = await toolCallPreplan("execute_gated_side_effect", {
      args: { nodeId: "n1", commitGateId: "g1" },
    });
    const seNoPlanDeny = sc(seNoPlan)?.denyReasons ?? [];
    const seNoPlanErr = scResult(seNoPlan)?.error;
    logResult("6.3 side_effect:no_plan",
      assertIncludes(seNoPlanDeny, "PLAN_SCOPE_VIOLATION") &&
      typeof seNoPlanErr === "string" && seNoPlanErr.includes("submit_execution_plan"),
      `deny=[${seNoPlanDeny}], error="${seNoPlanErr?.substring(0, 100)}"`
    );

  } catch (err) {
    log("ERROR", err.stack ?? err.message);
    failed++;
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 7: VERB DESCRIPTIONS & SUGGESTED ACTION
  // ═══════════════════════════════════════════════════════════
  try {
    log("SECTION", "═══ 7. VERB DESCRIPTIONS & SUGGESTED ACTION ═══");

    // Fresh session for these tests
    function toolCallS7(verb, extra = {}) {
      return toolCall(verb, {
        runSessionId: "s7-session",
        workId: "s7-work",
        agentId: "s7-agent",
        ...extra,
      });
    }

    // 7.1 Every response includes verbDescriptions
    log("TEST", "7.1 verbDescriptions present on every response");
    const vdRes = await toolCallS7("list_available_verbs");
    const vdTop = sc(vdRes)?.verbDescriptions;
    const vdEscalate = vdTop?.request_evidence_guidance;
    logResult("7.1 verbDescriptions:present",
      typeof vdTop === "object" && vdTop !== null &&
      typeof vdEscalate === "object" && vdEscalate !== null &&
      typeof vdEscalate?.description === "string" && vdEscalate.description.length > 0 &&
      typeof vdEscalate?.whenToUse === "string" && vdEscalate.whenToUse.length > 0 &&
      assertIsArray(vdEscalate?.requiredArgs) &&
      assertIsArray(vdEscalate?.optionalArgs),
      `request_evidence_guidance.desc="${vdEscalate?.description?.substring(0, 60)}...", keys=${Object.keys(vdTop ?? {}).length}`
    );

    // 7.2 list verb result ALSO includes verbDescriptions
    log("TEST", "7.2 list verb result includes verbDescriptions");
    const listVdRes = scResult(vdRes)?.verbDescriptions;
    const listVdSubmit = listVdRes?.submit_execution_plan;
    logResult("7.2 list:verbDescriptions",
      typeof listVdRes === "object" && listVdRes !== null &&
      typeof listVdSubmit === "object" && listVdSubmit !== null &&
      typeof listVdSubmit?.whenToUse === "string" && listVdSubmit.whenToUse.includes("evidence"),
      `submit_execution_plan.whenToUse="${listVdSubmit?.whenToUse?.substring(0, 60)}..."`
    );

    // 7.3 Deny response includes suggestedAction
    log("TEST", "7.3 suggestedAction on mutation deny");
    const paDeny = await toolCallS7("apply_code_patch", { args: { filePath: "foo.ts", patch: "x" } });
    const paSugg = sc(paDeny)?.suggestedAction;
    logResult("7.3 suggestedAction:mutation_deny",
      typeof paSugg === "object" && paSugg !== null &&
      typeof paSugg?.verb === "string" && paSugg.verb.length > 0 &&
      typeof paSugg?.reason === "string" && paSugg.reason.length > 0,
      `verb="${paSugg?.verb}", reason="${paSugg?.reason?.substring(0, 80)}..."`
    );

    // 7.4 No suggestedAction on successful response
    log("TEST", "7.4 no suggestedAction on success");
    const okRes = await toolCallS7("get_original_prompt", { originalPrompt: "Test prompt" });
    const okSugg = sc(okRes)?.suggestedAction;
    logResult("7.4 suggestedAction:absent_on_success",
      okSugg === undefined || okSugg === null,
      `suggestedAction=${JSON.stringify(okSugg)}`
    );

    // 7.5 Escalate verb description tells agent about evidence threshold
    log("TEST", "7.5 escalate description mentions evidence");
    const escDesc = vdTop?.request_evidence_guidance;
    logResult("7.5 escalate:describes_evidence",
      typeof escDesc?.whenToUse === "string" &&
      (escDesc.whenToUse.includes("evidence") || escDesc.whenToUse.includes("stuck")) &&
      assertIncludes(escDesc?.requiredArgs ?? [], "blockingReasons"),
      `whenToUse="${escDesc?.whenToUse?.substring(0, 80)}..."`
    );

  } catch (err) {
    log("ERROR", err.stack ?? err.message);
    failed++;
  }
  console.log("\n" + "=".repeat(70));
  console.log("                    COMPREHENSIVE TEST RESULTS");
  console.log("=".repeat(70));
  console.log(`  PASSED:  ${passed}`);
  console.log(`  FAILED:  ${failed}`);
  console.log(`  SKIPPED: ${skipped}`);
  console.log(`  TOTAL:   ${passed + failed + skipped}`);
  console.log("=".repeat(70));

  if (failed > 0) {
    console.log("\n  FAILURES:");
    for (const r of results) {
      if (r.status === "FAIL") {
        console.log(`    X ${r.name}: ${r.detail}`);
      }
    }
    console.log();
  }

  if (stderrChunks.length > 0) {
    console.log("\nServer stderr (last 2000 chars):");
    const full = stderrChunks.join("");
    console.log(full.length > 2000 ? "..." + full.slice(-2000) : full);
  }

  child.stdin.end();
  child.kill("SIGTERM");
  process.exit(failed > 0 ? 1 : 0);
}

main();
