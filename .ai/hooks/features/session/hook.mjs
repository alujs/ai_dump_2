/**
 * session — Session lifecycle hook
 *
 * Priority: 0 (runs first)
 * hotPathSafe: true
 * critical: true
 *
 * What it does:
 *   Mints IDs, scaffolds directories, stamps metadata, tracks phases, and
 *   audit-logs every tool call. This is the "always-on" bookkeeper.
 *
 * Dependencies:
 *   ./neo4j-cap.mjs  (bundled — optional Neo4j reachability check)
 *
 * To copy this feature:
 *   Copy this entire folder.  Works standalone once loaded by a dispatcher.
 *
 * Events:
 *   SessionStart      — mint IDs, scaffold dirs, init state, neo4j cap check
 *   UserPromptSubmit  — increment turnId, audit prompt, optionally rotate workId
 *   PreToolUse        — stamp inputMetadata with IDs/paths
 *   PostToolUse       — record tool outcome event
 *   PreCompact        — persist compact snapshot
 *   Stop              — final flush + session report pointer
 */

import { mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { neo4jCapability } from './neo4j-cap.mjs';

// ── Phase ordinals (for max-comparison) ──────────────────────────────────
const PHASE_ORD = { UNINITIALIZED: 0, PLANNING: 1, EXECUTING: 2, COMPLETE: 3, BLOCKED: 99 };

function phaseMax(a, b) {
  if (a === 'BLOCKED' || b === 'BLOCKED') return 'BLOCKED';
  return (PHASE_ORD[a] ?? 0) >= (PHASE_ORD[b] ?? 0) ? a : b;
}

// ── Module ───────────────────────────────────────────────────────────────

export default {
  name: 'session',
  supports: new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop']),
  priority: 0,
  hotPathSafe: true,
  critical: true,

  async handle(eventName, ctx) {
    switch (eventName) {
      case 'SessionStart':      return handleSessionStart(ctx);
      case 'UserPromptSubmit':  return handleUserPromptSubmit(ctx);
      case 'PreToolUse':        return handlePreToolUse(ctx);
      case 'PostToolUse':       return handlePostToolUse(ctx);
      case 'PreCompact':        return handlePreCompact(ctx);
      case 'Stop':              return handleStop(ctx);
      default:                  return {};
    }
  },
};

// ── SessionStart ─────────────────────────────────────────────────────────

async function handleSessionStart(ctx) {
  const sid = ctx.ids.sessionId;
  const wid = ctx.ids.workId;
  const now = Date.now();

  const dirs = [
    ctx.paths.sessionRoot,
  ];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
  }

  let capPatch = null;
  try {
    const { statePatch } = await neo4jCapability(ctx, { allowCompute: true });
    capPatch = statePatch;
  } catch { /* non-fatal */ }

  const emitEvents = [{
    ts: now, event: 'SessionStart', producer: 'session', kind: 'SESSION_INIT',
    hookRunId: ctx.ids.hookRunId, turnId: 0, workId: wid,
    data: { sessionId: sid, workId: wid },
  }];

  const corePatch = {
    core: {
      sessionId: sid,
      workId: wid,
      lastTurnId: 0,
      phase: 'UNINITIALIZED',
      createdTs: now,
      lastActiveTs: now,
    },
  };

  const statePatch = capPatch ? { ...corePatch, ...capPatch } : corePatch;

  return {
    statePatch,
    emitEvents,
    additionalContext: [{
      key: 'hook-session-info',
      value: `Session ${sid} initialized. Work unit: ${wid}. Output root: ${ctx.paths.sessionRoot}`,
    }],
  };
}

// ── UserPromptSubmit ─────────────────────────────────────────────────────

async function handleUserPromptSubmit(ctx) {
  const prevTurn = ctx.state.core?.lastTurnId ?? 0;
  const newTurn = prevTurn + 1;
  const now = Date.now();

  const isHuman = !!ctx.event.transcript_path;

  const promptHash = ctx.event.prompt
    ? createHash('sha256').update(ctx.event.prompt).digest('hex').slice(0, 16)
    : null;

  const emitEvents = [{
    ts: now, event: 'UserPromptSubmit', producer: 'session', kind: 'TURN_INCREMENT',
    hookRunId: ctx.ids.hookRunId, turnId: newTurn, workId: ctx.ids.workId,
    data: { previousTurn: prevTurn },
  }];

  if (promptHash) {
    emitEvents.push({
      ts: now, event: 'UserPromptSubmit', producer: 'session', kind: 'PROMPT_AUDIT',
      hookRunId: ctx.ids.hookRunId, turnId: newTurn, workId: ctx.ids.workId,
      data: { promptHash, isHuman, charCount: ctx.event.prompt?.length ?? 0 },
    });
  }

  const currentPhase = ctx.state.core?.phase || 'UNINITIALIZED';
  const newPhase = currentPhase === 'UNINITIALIZED' ? 'PLANNING' : currentPhase;

  const statePatch = {
    core: {
      lastTurnId: newTurn,
      lastActiveTs: now,
      phase: newPhase,
    },
  };

  if (newPhase !== currentPhase) {
    emitEvents.push({
      ts: now, event: 'UserPromptSubmit', producer: 'session', kind: 'PHASE_TRANSITION',
      hookRunId: ctx.ids.hookRunId, turnId: newTurn, workId: ctx.ids.workId,
      phase: newPhase,
      data: { from: currentPhase, to: newPhase },
    });
  }

  return { statePatch, emitEvents };
}

// ── Mutating tool detection ──────────────────────────────────────────────
const MUTATING_TOOLS = new Set([
  'create_file', 'replace_string_in_file', 'multi_replace_string_in_file',
  'run_in_terminal', 'edit_notebook_file', 'run_notebook_cell',
  'create_directory', 'run_vscode_command',
]);

// ── PreToolUse ───────────────────────────────────────────────────────────

async function handlePreToolUse(ctx) {
  const inputMetadata = {
    _hookSessionId: ctx.ids.sessionId,
    _hookWorkId: ctx.ids.workId,
    _hookOutputRoot: ctx.paths.relRef(ctx.paths.sessionRoot),
    _hookTurnId: ctx.ids.turnId,
  };

  const emitEvents = [{
    ts: Date.now(), event: 'PreToolUse', producer: 'session', kind: 'TOOL_DECISION',
    hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
    toolName: ctx.event.toolName,
    decision: 'allow',
    data: { toolInput: summarizeToolInput(ctx.event.toolInput) },
  }];

  const statePatch = { core: { lastActiveTs: Date.now() } };

  // Advance PLANNING → EXECUTING on first mutating tool call
  const currentPhase = ctx.state.core?.phase || 'UNINITIALIZED';
  if (currentPhase === 'PLANNING' && MUTATING_TOOLS.has(ctx.event.toolName)) {
    statePatch.core.phase = 'EXECUTING';
    emitEvents.push({
      ts: Date.now(), event: 'PreToolUse', producer: 'session', kind: 'PHASE_TRANSITION',
      hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
      data: { from: 'PLANNING', to: 'EXECUTING' },
    });
  }

  return {
    decision: 'allow',
    inputMetadata,
    emitEvents,
    statePatch,
  };
}

// ── PostToolUse ──────────────────────────────────────────────────────────

async function handlePostToolUse(ctx) {
  const success = !ctx.event.toolError;

  const emitEvents = [{
    ts: Date.now(), event: 'PostToolUse', producer: 'session', kind: 'TOOL_OUTCOME',
    hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
    toolName: ctx.event.toolName,
    data: {
      success,
      errorSummary: ctx.event.toolError ? ctx.event.toolError.slice(0, 200) : undefined,
      touchedPaths: extractPaths(ctx.event.toolInput),
    },
  }];

  return { emitEvents, statePatch: { core: { lastActiveTs: Date.now() } } };
}

// ── PreCompact ───────────────────────────────────────────────────────────

async function handlePreCompact(ctx) {
  const snapshot = {
    sessionId: ctx.ids.sessionId,
    workId: ctx.ids.workId,
    turnId: ctx.ids.turnId,
    phase: ctx.state.core?.phase || 'UNINITIALIZED',
    ts: Date.now(),
  };

  const emitEvents = [{
    ts: Date.now(), event: 'PreCompact', producer: 'session', kind: 'COMPACT_SNAPSHOT',
    hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
    data: snapshot,
  }];

  return {
    emitEvents,
    additionalContext: [{
      key: 'hook-session-compact',
      value: `[Session ${ctx.ids.sessionId}] Compacting at turn ${ctx.ids.turnId}, phase ${snapshot.phase}, work ${ctx.ids.workId}.`,
    }],
    statePatch: { core: { lastActiveTs: Date.now() } },
  };
}

// ── Stop ─────────────────────────────────────────────────────────────────

async function handleStop(ctx) {
  const currentPhase = ctx.state.core?.phase || 'UNINITIALIZED';
  const finalPhase = (currentPhase === 'EXECUTING' || currentPhase === 'PLANNING') ? 'COMPLETE' : currentPhase;

  const emitEvents = [{
    ts: Date.now(), event: 'Stop', producer: 'session', kind: 'SESSION_STOP',
    hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
    data: {
      sessionId: ctx.ids.sessionId,
      finalPhase,
      finalTurn: ctx.ids.turnId,
    },
  }];

  // Transition to COMPLETE on Stop
  if (finalPhase !== currentPhase) {
    emitEvents.push({
      ts: Date.now(), event: 'Stop', producer: 'session', kind: 'PHASE_TRANSITION',
      hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
      data: { from: currentPhase, to: finalPhase },
    });
  }

  return { emitEvents, statePatch: { core: { lastActiveTs: Date.now(), phase: finalPhase } } };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function summarizeToolInput(input) {
  if (!input) return undefined;
  const summary = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > 200) {
      summary[k] = v.slice(0, 100) + `…(${v.length} chars)`;
    } else {
      summary[k] = v;
    }
  }
  return summary;
}

function extractPaths(input) {
  if (!input) return [];
  const paths = [];
  for (const key of ['filePath', 'path', 'query', 'includePattern']) {
    if (typeof input[key] === 'string') paths.push(input[key]);
  }
  if (Array.isArray(input.replacements)) {
    for (const r of input.replacements) {
      if (typeof r.filePath === 'string') paths.push(r.filePath);
    }
  }
  return [...new Set(paths)];
}
