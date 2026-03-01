#!/usr/bin/env node
/**
 * .ai/hooks/dispatch.mjs — Hook Dispatcher v1
 *
 * Single entrypoint for all VS Code Copilot Agent hook events.
 * See CONTRACT.md for the authoritative specification.
 *
 * Usage:  node .ai/hooks/dispatch.mjs <EventName>
 * stdin:  JSON per hook-input.schema.json
 * stdout: JSON per hook-output.schema.json  (exactly one object, nothing else)
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomBytes, createHash } from 'node:crypto';
import { loadWorkspace, buildPaths, getWorkRoot, getHooksConfig, REPO_ROOT } from './lib/paths.mjs';

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_EVENTS = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PreCompact', 'Stop', 'SubagentStart', 'SubagentStop',
]);

const DEFAULT_BUDGET = 1000; // ms

// ── VS Code ↔ Internal format translation ────────────────────────────────────

/**
 * Normalize VS Code hook stdin into the internal format.
 * VS Code sends snake_case fields; our modules expect camelCase.
 *
 * VS Code format:
 *   { hookEventName, tool_name, tool_input, tool_response, tool_use_id,
 *     agent_id, agent_type, prompt, transcript_path, source, trigger,
 *     stop_hook_active, sessionId, cwd, timestamp }
 *
 * Internal format:
 *   { event, toolName, toolInput, toolOutput, toolError, prompt,
 *     transcript_path, subagentId, subagentType, subagentPrompt,
 *     subagentResult, compactSummary, sessionId }
 */
function normalizeInput(raw, argvEvent) {
  // Accept both VS Code format and legacy internal format
  return {
    event:           raw.hookEventName  || raw.event          || argvEvent,
    toolName:        raw.tool_name       || raw.toolName,
    toolInput:       raw.tool_input      || raw.toolInput,
    toolOutput:      raw.tool_response   || raw.toolOutput,
    toolError:       raw.toolError,       // VS Code doesn't send this; only internal
    prompt:          raw.prompt,
    transcript_path: raw.transcript_path,
    subagentId:      raw.agent_id         || raw.subagentId,
    subagentType:    raw.agent_type       || raw.subagentType,
    subagentPrompt:  raw.subagentPrompt,  // VS Code doesn't send this directly
    subagentResult:  raw.subagentResult,  // VS Code doesn't send this directly
    compactSummary:  raw.compactSummary   || raw.summary,
    sessionId:       raw.sessionId,
    // VS Code-specific fields preserved for logging
    _vscode: {
      tool_use_id:      raw.tool_use_id,
      stop_hook_active: raw.stop_hook_active,
      source:           raw.source,
      trigger:          raw.trigger,
      cwd:              raw.cwd,
      timestamp:        raw.timestamp,
    },
  };
}

/**
 * Convert internal output into VS Code hook output format.
 *
 * VS Code expects:
 *   PreToolUse:  { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason, updatedInput, additionalContext } }
 *   PostToolUse: { hookSpecificOutput: { hookEventName, additionalContext }, decision?, reason? }
 *   SessionStart/SubagentStart: { hookSpecificOutput: { hookEventName, additionalContext } }
 *   Stop/SubagentStop: { hookSpecificOutput: { hookEventName, decision: "block", reason } }
 *   Others: { continue?, stopReason?, systemMessage? }
 */
function formatOutput(eventName, internalOutput) {
  const out = {};

  // Flatten additionalContext array → single string for VS Code
  const contextStr = (internalOutput.additionalContext || [])
    .map(c => typeof c === 'string' ? c : `[${c.key}] ${c.value}`)
    .join('\n') || undefined;

  // Warnings as systemMessage
  const warnStr = (internalOutput.warnings || []).join('; ') || undefined;

  switch (eventName) {
    case 'PreToolUse': {
      const decision = internalOutput.decision || 'allow';
      const hso = { hookEventName: 'PreToolUse' };

      // Map allow/ask/deny → permissionDecision
      hso.permissionDecision = decision;
      if (decision !== 'allow') {
        hso.permissionDecisionReason = internalOutput.denyReason || warnStr || 'Blocked by hook';
      }
      if (internalOutput.updatedInput && Object.keys(internalOutput.updatedInput).length) {
        hso.updatedInput = internalOutput.updatedInput;
      }
      if (contextStr) {
        hso.additionalContext = contextStr;
      }
      out.hookSpecificOutput = hso;
      break;
    }

    case 'PostToolUse': {
      const hso = { hookEventName: 'PostToolUse' };
      if (contextStr) hso.additionalContext = contextStr;
      out.hookSpecificOutput = hso;
      if (warnStr) out.systemMessage = warnStr;
      break;
    }

    case 'SessionStart':
    case 'SubagentStart': {
      const hso = { hookEventName: eventName };
      if (contextStr) hso.additionalContext = contextStr;
      out.hookSpecificOutput = hso;
      break;
    }

    case 'Stop':
    case 'SubagentStop': {
      // Internal modules can set a 'blockStop' flag if they want to prevent stopping
      if (internalOutput._blockStop) {
        out.hookSpecificOutput = {
          hookEventName: eventName,
          decision: 'block',
          reason: internalOutput._blockStopReason || 'Hook requests continuation',
        };
      } else {
        const hso = { hookEventName: eventName };
        if (contextStr) hso.additionalContext = contextStr;
        out.hookSpecificOutput = hso;
      }
      break;
    }

    default: {
      // UserPromptSubmit, PreCompact — use common format
      out.continue = true;
      if (warnStr) out.systemMessage = warnStr;
      break;
    }
  }

  // Always attach debug (VS Code ignores unknown keys)
  if (internalOutput._debug) {
    out._debug = internalOutput._debug;
  }

  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read all of stdin synchronously (VS Code pipes JSON then closes). */
function readStdinSync() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '{}';
  }
}

/** Deep merge b into a (one level of nesting). Mutates a. */
function mergePatch(a, b) {
  if (!b || typeof b !== 'object') return a;
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') {
      mergePatch(a[k], v);
    } else {
      a[k] = v;
    }
  }
  return a;
}

/** sha256 first 8 hex chars of a string, for error dedup */
function stackHash(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 8);
}

/** Ensure a directory exists (recursive). */
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/** Atomic JSON write: write .tmp then rename. */
function atomicJsonWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  ensureDir(dirname(filePath));
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

/** Append a JSONL line. */
function appendJsonl(filePath, record) {
  ensureDir(dirname(filePath));
  appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
}

/** Read JSON file or return fallback. */
function readJsonOr(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// ── Workspace config (loaded once) ───────────────────────────────────────────
const _ws = loadWorkspace();

// ── Trace log — always-on, pre-session, append-only ──────────────────────────
// Lives in workRoot (not hooks dir) so it's alongside session data.
// Proves VS Code is actually invoking the dispatcher.

const DISPATCH_LOG = join(getWorkRoot(_ws), 'dispatch.log');

// Ensure workRoot exists for dispatch log (before session resolution)
try { mkdirSync(getWorkRoot(_ws), { recursive: true }); } catch { /* best effort */ }

function trace(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    appendFileSync(DISPATCH_LOG, line, 'utf-8');
  } catch { /* best effort — if this fails, nothing we can do */ }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = performance.now();
  const eventName = process.argv[2];

  trace(`INVOKE ${eventName || '(none)'} pid=${process.pid} argv=${JSON.stringify(process.argv.slice(2))}`);

  // Validate event name
  if (!eventName || !VALID_EVENTS.has(eventName)) {
    trace(`REJECT unknown event: ${eventName}`);
    process.stdout.write(JSON.stringify({ decision: 'allow', warnings: [`Unknown event: ${eventName}`] }));
    process.exit(0);
  }

  // Read stdin and normalize from VS Code format
  let input;
  try {
    const raw = readStdinSync();
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    input = normalizeInput(parsed, eventName);
    trace(`INPUT normalized tool=${input.toolName || '(none)'} vscode_fields=${JSON.stringify(input._vscode || {})}`);
  } catch (e) {
    trace(`INPUT parse error: ${e.message}`);
    input = normalizeInput({}, eventName);
  }

  // Load manifest (path from workspace config)
  const manifestPath = getHooksConfig(_ws).manifestFile;
  const manifest = readJsonOr(manifestPath, { version: 1, budgets: {}, modules: {}, enforcePhases: false, phasePolicy: {}, rewriteOwner: {} });

  const budgetMs = manifest.budgets?.[eventName] ?? DEFAULT_BUDGET;

  // ── Resolve session ID ───────────────────────────────────────────────────
  // On SessionStart, the session module will mint a new sid.
  // On other events, we need to find the current session.
  // Strategy: check env, then input, then scan for most-recent session dir.

  let sid = process.env.COPILOT_SESSION_ID?.slice(0, 8)
         || input.sessionId?.slice(0, 8)
         || findCurrentSession();

  const isSessionStart = eventName === 'SessionStart';

  // If no session found and not SessionStart, fail open
  if (!sid && !isSessionStart) {
    process.stdout.write(JSON.stringify({ decision: 'allow', warnings: ['No active session found'] }));
    process.exit(0);
  }

  // For SessionStart, mint a provisional sid (session module will finalize)
  if (!sid) {
    sid = randomBytes(4).toString('hex');
  }

  // GC old session dirs on SessionStart (best-effort, non-blocking)
  if (isSessionStart) {
    gcSessionDirs(manifest.gc);
  }

  // ── Load state ───────────────────────────────────────────────────────────

  // Use a default workId; session module will set the real one (not a path level)
  let wid = 'w001';

  const paths = buildPaths(_ws, sid);
  let state = readJsonOr(paths.stateFile, null);

  if (state?.core?.workId) {
    wid = state.core.workId;
  }

  if (!state) {
    state = {
      core: {
        sessionId: sid,
        workId: wid,
        lastTurnId: 0,
        phase: 'UNINITIALIZED',
        createdTs: Date.now(),
        lastActiveTs: Date.now(),
      },
    };
  }

  // ── Build ctx ────────────────────────────────────────────────────────────

  const hookRunId = `${eventName}-${state.core?.lastTurnId ?? 0}-${Date.now()}`;

  /** Per-feature debug logger — rebound before each module call */
  let _featureDebugLines = [];
  function log(level, msg, data) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
    _featureDebugLines.push(line);
    trace(`[${level}] ${msg}`);  // also echo to dispatch.log
  }

  const ctx = {
    ids: {
      sessionId: sid,
      workId: wid,
      agentId: 'u00',
      turnId: state.core?.lastTurnId ?? 0,
      hookRunId,
    },
    event: {
      name: eventName,
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolOutput: input.toolOutput,
      toolError: input.toolError,
      prompt: input.prompt,
      transcript_path: input.transcript_path,
      subagentId: input.subagentId,
      subagentType: input.subagentType,
      subagentPrompt: input.subagentPrompt,
      subagentResult: input.subagentResult,
      compactSummary: input.compactSummary,
    },
    paths,
    state,
    cap: {
      neo4j: state.cap?.neo4j ?? { enabled: false, reachable: false, schemaVersion: '', lastCheckTs: 0 },
    },
    timers: {
      startMs,
      budgetMs,
      elapsed: () => performance.now() - startMs,
    },
    log,
    config: {},
    feature: { root: null, logs: null, output: null },
  };

  // ── Load per-feature config ───────────────────────────────────────────────
  const _hookConfig = readJsonOr(paths.configFile, {});

  // ── Load and filter modules ──────────────────────────────────────────────

  const moduleEntries = Object.entries(manifest.modules || {})
    .filter(([, cfg]) => cfg.enabled)
    .sort(([, a], [, b]) => (a.priority ?? 999) - (b.priority ?? 999));

  const modules = [];
  for (const [name, cfg] of moduleEntries) {
    try {
      const modPath = resolve(dirname(manifestPath), cfg.path);
      const mod = await import(modPath);
      const impl = mod.default;
      if (!impl || typeof impl.handle !== 'function') {
        log('warn', `Module ${name} has no handle() — skipping`);
        continue;
      }
      // Apply manifest overrides
      modules.push({
        name,
        supports: impl.supports instanceof Set ? impl.supports : new Set(impl.supports || []),
        priority: cfg.priority ?? impl.priority ?? 999,
        hotPathSafe: cfg.hotPathSafe ?? impl.hotPathSafe ?? false,
        critical: cfg.critical ?? impl.critical ?? false,
        handle: impl.handle,
      });
    } catch (err) {
      log('error', `Failed to load module ${name}: ${err.message}`);
    }
  }

  // Filter: must support this event, and pass hotPathSafe gate
  const runnable = modules
    .filter(m => m.supports.has(eventName))
    .filter(m => eventName !== 'PreToolUse' || m.hotPathSafe);

  // ── Execute modules ──────────────────────────────────────────────────────

  const results = [];
  let finalDecision = 'allow';
  let firstDenyReason = undefined;
  let inputMetadata = null;
  let updatedInput = null;
  let updatedInputOwner = null;
  const allAdditionalContext = [];
  const allWarnings = [];
  const allEvents = [];
  const allArtifacts = [];
  const statePatches = [];
  let stopped = false;

  for (const mod of runnable) {
    if (stopped) break;

    // Budget check
    if (ctx.timers.elapsed() > budgetMs) {
      log('warn', `Budget exceeded (${Math.round(ctx.timers.elapsed())}ms > ${budgetMs}ms) at module ${mod.name}`);
      allEvents.push({
        ts: Date.now(), event: eventName, producer: 'dispatcher', kind: 'BUDGET_EXCEEDED',
        hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
        data: { module: mod.name, elapsedMs: Math.round(ctx.timers.elapsed()), budgetMs },
      });
      break;
    }

    // Set per-feature context, config section, and reset debug buffer
    ctx.feature = {
      root:   ctx.paths.featureRoot(mod.name),
      logs:   ctx.paths.featureLogs(mod.name),
      output: ctx.paths.featureOutput(mod.name),
    };
    ctx.config = _hookConfig[mod.name] || {};
    _featureDebugLines = [];

    const modStart = performance.now();

    try {
      const action = await mod.handle(eventName, ctx) || {};
      const modMs = performance.now() - modStart;

      results.push({ module: mod.name, action, ms: modMs });

      // Collect outputs
      if (action.emitEvents?.length)        allEvents.push(...action.emitEvents);
      if (action.registerArtifacts?.length)  allArtifacts.push(...action.registerArtifacts);
      if (action.warnings?.length)           allWarnings.push(...action.warnings);
      if (action.additionalContext?.length)   allAdditionalContext.push(...action.additionalContext);
      if (action.statePatch)                 statePatches.push(action.statePatch);

      // inputMetadata — only from the configured owner
      if (action.inputMetadata && mod.name === (manifest.rewriteOwner?.inputMetadata ?? 'session')) {
        inputMetadata = action.inputMetadata;
      } else if (action.inputMetadata) {
        log('warn', `Module ${mod.name} returned inputMetadata but is not the configured owner — ignored`);
        allWarnings.push(`${mod.name} returned inputMetadata but is not the rewrite owner`);
      }

      // updatedInput — first writer wins
      if (action.updatedInput) {
        if (!updatedInput) {
          updatedInput = action.updatedInput;
          updatedInputOwner = mod.name;
        } else {
          log('warn', `Module ${mod.name} returned updatedInput but ${updatedInputOwner} already set it — ignored`);
          allWarnings.push(`${mod.name} returned updatedInput but ${updatedInputOwner} already owns it`);
        }
      }

      // Decision short-circuit (PreToolUse only)
      if (eventName === 'PreToolUse' && action.decision) {
        if (action.decision === 'deny') {
          finalDecision = 'deny';
          firstDenyReason = action.denyReason || `Denied by ${mod.name}`;
          stopped = true;
        } else if (action.decision === 'ask' && finalDecision !== 'deny') {
          finalDecision = 'ask';
          firstDenyReason = action.denyReason || `Ask triggered by ${mod.name}`;
          stopped = true;
        }
      }

      // Update ctx.ids/state if session module patched them (so subsequent modules see fresh IDs)
      if (mod.name === 'session' && action.statePatch?.core) {
        if (action.statePatch.core.sessionId) { ctx.ids.sessionId = action.statePatch.core.sessionId; ctx.paths = buildPaths(_ws, ctx.ids.sessionId); }
        if (action.statePatch.core.workId)    ctx.ids.workId = action.statePatch.core.workId;
        if (action.statePatch.core.lastTurnId !== undefined) ctx.ids.turnId = action.statePatch.core.lastTurnId;
      }

    } catch (err) {
      const modMs = performance.now() - modStart;
      const hash = stackHash(err.stack || err.message || '');
      const kind = mod.critical ? 'ERROR_MODULE_CRITICAL' : 'ERROR_MODULE';

      log('error', `${kind} in ${mod.name}: ${err.message}`);

      allEvents.push({
        ts: Date.now(), event: eventName, producer: 'dispatcher', kind,
        hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
        error: { module: mod.name, message: err.message, stackHash: hash },
        ms: modMs,
      });

      if (mod.critical) {
        finalDecision = 'deny';
        firstDenyReason = `Critical module ${mod.name} crashed: ${err.message}`;
        stopped = true;
      }
      // Non-critical: continue
    } finally {
      // Flush per-feature debug log
      if (_featureDebugLines.length && ctx.feature.logs) {
        try {
          ensureDir(ctx.feature.logs);
          appendFileSync(join(ctx.feature.logs, 'debug.log'), _featureDebugLines.join('\n') + '\n', 'utf-8');
        } catch { /* best effort */ }
      }
    }
  }

  // ── Phase enforcement (if enabled) ─────────────────────────────────────

  if (eventName === 'PreToolUse' && manifest.enforcePhases && finalDecision === 'allow') {
    const phase = ctx.state.core?.phase || 'UNINITIALIZED';
    const policy = manifest.phasePolicy?.[phase];
    const toolName = ctx.event.toolName;

    if (policy && policy.allowTools !== '*' && toolName) {
      const allowed = Array.isArray(policy.allowTools) ? policy.allowTools : [];
      if (!allowed.includes(toolName)) {
        if (policy.mode === 'deny') {
          finalDecision = 'deny';
          firstDenyReason = `Phase ${phase} does not allow tool '${toolName}'`;
        } else if (policy.mode === 'warn') {
          allWarnings.push(`Phase ${phase}: tool '${toolName}' is outside the allowed set`);
        }
      }
    }
  }

  // ── Commit: state, events, artifacts ───────────────────────────────────

  // Rebuild final paths (session module may have changed sid/wid)
  const finalSid = ctx.ids.sessionId;
  const finalPaths = buildPaths(_ws, finalSid);

  // Apply state patches
  let finalState = JSON.parse(JSON.stringify(ctx.state)); // deep clone
  for (const patch of statePatches) {
    mergePatch(finalState, patch);
  }
  // Always update lastActiveTs
  if (!finalState.core) finalState.core = {};
  finalState.core.lastActiveTs = Date.now();

  // Write state atomically
  try {
    atomicJsonWrite(finalPaths.stateFile, finalState);
  } catch (err) {
    log('error', `Failed to write state: ${err.message}`);
  }

  // Append events
  try {
    for (const evt of allEvents) {
      appendJsonl(finalPaths.eventsFile, evt);
    }
  } catch (err) {
    log('error', `Failed to append events: ${err.message}`);
  }

  // Append artifacts
  try {
    for (const art of allArtifacts) {
      appendJsonl(finalPaths.registryFile, art);
    }
  } catch (err) {
    log('error', `Failed to append artifacts: ${err.message}`);
  }

  // (Per-feature debug logs are flushed after each module in the loop above)

  // ── Build internal output ──────────────────────────────────────────────

  const internalOutput = {};

  if (eventName === 'PreToolUse') {
    internalOutput.decision = finalDecision;
    if (finalDecision !== 'allow') {
      internalOutput.denyReason = firstDenyReason;
    }
  }

  // Merge rewrite channels for PreToolUse
  if (eventName === 'PreToolUse' && (inputMetadata || updatedInput)) {
    const merged = {};
    if (inputMetadata) Object.assign(merged, inputMetadata);
    if (updatedInput)  Object.assign(merged, updatedInput);
    if (Object.keys(merged).length) internalOutput.updatedInput = merged;
  }

  if (allAdditionalContext.length) {
    internalOutput.additionalContext = allAdditionalContext;
  }

  if (allWarnings.length) {
    internalOutput.warnings = allWarnings;
  }

  internalOutput._debug = {
    hookRunId: ctx.ids.hookRunId,
    modulesRan: results.map(r => r.module),
    elapsedMs: Math.round(ctx.timers.elapsed()),
    budgetMs,
    budgetExceeded: ctx.timers.elapsed() > budgetMs,
  };

  // ── Convert to VS Code format and write to stdout ──────────────────────

  const output = formatOutput(eventName, internalOutput);

  trace(`DONE ${eventName} sid=${ctx.ids.sessionId} modules=[${results.map(r => r.module).join(',')}] decision=${internalOutput.decision || 'n/a'} elapsed=${Math.round(ctx.timers.elapsed())}ms`);

  process.stdout.write(JSON.stringify(output));
}

// ── Session finder ─────────────────────────────────────────────────────────

/** Scan workRoot for the most recently modified session directory. */
function findCurrentSession() {
  try {
    const wDir = getWorkRoot(_ws);
    const entries = readdirSync(wDir);
    let best = null;
    let bestMtime = 0;
    for (const name of entries) {
      if (!/^[a-f0-9]{8}$/.test(name)) continue;
      try {
        const sFile = resolve(wDir, name, _ws.session.stateFile);
        const st = statSync(sFile);
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          best = name;
        }
      } catch { /* no state file — skip */ }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * GC old session dirs from .ai/tmp/w/.
 * Triggered on SessionStart only. Best-effort — errors are silent.
 * @param {{ maxAgeDays?: number, maxSessions?: number }} gcConfig
 */
function gcSessionDirs(gcConfig) {
  if (!gcConfig) return;
  try {
    const wDir = getWorkRoot(_ws);
    const entries = readdirSync(wDir);
    const sessions = [];
    for (const name of entries) {
      if (!/^[a-f0-9]{8}$/.test(name)) continue;
      try {
        const sFile = resolve(wDir, name, _ws.session.stateFile);
        const st = statSync(sFile);
        sessions.push({ name, mtimeMs: st.mtimeMs, dir: resolve(wDir, name) });
      } catch {
        // No s.json — stale dir, mark as very old
        sessions.push({ name, mtimeMs: 0, dir: resolve(wDir, name) });
      }
    }

    // Sort newest first
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const maxAge = (gcConfig.maxAgeDays ?? 7) * 86400000;
    const maxCount = gcConfig.maxSessions ?? 20;
    const cutoff = Date.now() - maxAge;

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const tooOld = s.mtimeMs > 0 && s.mtimeMs < cutoff;
      const overLimit = i >= maxCount;
      if (tooOld || overLimit) {
        try { rmRecursive(s.dir); } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
}

/** rm -rf equivalent. */
function rmRecursive(dirPath) {
  rmSync(dirPath, { recursive: true, force: true });
}

// ── Top-level safety net ───────────────────────────────────────────────────

try {
  await main();
} catch (err) {
  // Catastrophic failure: fail open (CONTRACT §3.3)
  trace(`CRASH ${err.message}\n${err.stack}`);
  try {
    // VS Code format: continue=true means fail-open
    process.stdout.write(JSON.stringify({
      continue: true,
      systemMessage: `Dispatcher crash: ${err.message}`,
      _debug: { crash: true, error: err.message },
    }));
  } catch { /* nothing left to do */ }
  process.exit(0);
}
