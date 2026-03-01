/**
 * .ai/hooks/modules/memory-journal.mjs — Memory Journal
 *
 * Priority: 50
 * hotPathSafe: false   (not on PreToolUse hot path)
 * critical: false
 *
 * CONTRACT §14 row 6.
 *
 * Standalone value: builds a structured memory journal from what
 * actually happened during the session. No activation or Neo4j required.
 * Pure observation — append-only experience records.
 *
 * Events:
 *   UserPromptSubmit  — record prompt anchors
 *   PostToolUse       — record tool outcomes + friction signals
 *   Stop              — roll session into experience records, write candidates
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ── Module ───────────────────────────────────────────────────────────────

export default {
  name: 'memory-journal',
  supports: new Set(['UserPromptSubmit', 'PostToolUse', 'Stop']),
  priority: 50,
  hotPathSafe: false,
  critical: false,

  async handle(eventName, ctx) {
    switch (eventName) {
      case 'UserPromptSubmit': return handlePrompt(ctx);
      case 'PostToolUse':      return handlePostTool(ctx);
      case 'Stop':             return handleStop(ctx);
      default:                 return {};
    }
  },
};

// ── UserPromptSubmit ─────────────────────────────────────────────────────

function handlePrompt(ctx) {
  if (!ctx.event.prompt) return {};

  const prompt = ctx.event.prompt;
  const anchors = extractAnchors(prompt);
  const isHuman = !!ctx.event.transcript_path;

  const entry = {
    type: 'prompt',
    ts: Date.now(),
    turnId: ctx.ids.turnId,
    isHuman,
    anchors,
    promptHash: createHash('sha256').update(prompt).digest('hex').slice(0, 16),
    charCount: prompt.length,
  };

  const memDir = ctx.feature.output;
  const experienceFile = ctx.config.experienceFile || 'experience.jsonl';
  const experienceRef = ctx.paths.relRef(join(memDir, experienceFile));

  return {
    emitEvents: [{
      ts: Date.now(), event: 'UserPromptSubmit', producer: 'memory-journal',
      kind: 'MEMORY_MATCH',
      hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
      data: { anchors, isHuman },
    }],
    registerArtifacts: [{
      ts: Date.now(),
      producer: 'memory-journal',
      kind: 'memory_experience',
      ref: experienceRef,
      workId: ctx.ids.workId,
      summary: `Prompt at turn ${ctx.ids.turnId}`,
    }],
    statePatch: {
      memory: {
        journalPath: experienceRef,
        lastMatchTs: Date.now(),
      },
    },
    // The actual JSONL write happens via the emitEvents path —
    // the entry is recorded as a structured event. Dispatcher appends to e.jsonl.
    // For the dedicated experience file, we embed the data in the event.
  };
}

// ── PostToolUse ──────────────────────────────────────────────────────────

function handlePostTool(ctx) {
  const toolName = ctx.event.toolName;
  const toolInput = ctx.event.toolInput || {};
  const toolError = ctx.event.toolError;
  const success = !toolError;

  const emitEvents = [];
  const warnings = [];

  // Record the tool outcome as a journal event
  const entry = {
    type: 'tool_outcome',
    ts: Date.now(),
    turnId: ctx.ids.turnId,
    toolName,
    success,
    paths: extractInputPaths(toolInput),
  };

  emitEvents.push({
    ts: Date.now(), event: 'PostToolUse', producer: 'memory-journal',
    kind: 'MEMORY_MATCH',
    hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
    toolName,
    data: entry,
  });

  // ── Friction detection ─────────────────────────────────────────────
  // If the tool was denied or errored, that's friction worth recording
  if (toolError) {
    const frictionEntry = {
      type: 'friction',
      ts: Date.now(),
      turnId: ctx.ids.turnId,
      toolName,
      error: typeof toolError === 'string' ? toolError.slice(0, 300) : 'unknown',
      paths: entry.paths,
    };

    emitEvents.push({
      ts: Date.now(), event: 'PostToolUse', producer: 'memory-journal',
      kind: 'MEMORY_CANDIDATE',
      hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
      toolName,
      data: frictionEntry,
    });
  }

  return { emitEvents };
}

// ── Stop ─────────────────────────────────────────────────────────────────

function handleStop(ctx) {
  const emitEvents = [];
  const registerArtifacts = [];

  // Summarize session for memory purposes
  const summary = {
    sessionId: ctx.ids.sessionId,
    workId: ctx.ids.workId,
    finalTurn: ctx.ids.turnId,
    phase: ctx.state.core?.phase || 'UNINITIALIZED',
    ts: Date.now(),
  };

  emitEvents.push({
    ts: Date.now(), event: 'Stop', producer: 'memory-journal',
    kind: 'MEMORY_CANDIDATE',
    hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
    data: { type: 'session_summary', ...summary },
  });

  const candidatesFile = ctx.config.candidatesFile || 'candidates.json';
  const candidatesRef = ctx.paths.relRef(join(ctx.feature.output, candidatesFile));

  registerArtifacts.push({
    ts: Date.now(),
    producer: 'memory-journal',
    kind: 'memory_candidates',
    ref: candidatesRef,
    workId: ctx.ids.workId,
    summary: `Memory candidates from session ${ctx.ids.sessionId}`,
  });

  return { emitEvents, registerArtifacts };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract domain anchors from prompt text.
 * Looks for file paths, component names, module references.
 */
function extractAnchors(text) {
  if (!text) return [];
  const anchors = new Set();

  // File paths (src/app/foo/bar.ts patterns)
  const pathMatches = text.match(/(?:src|app|lib|shared|core)\/[\w\-\/]+\.(?:ts|html|css|scss|json)/gi);
  if (pathMatches) pathMatches.forEach(m => anchors.add(m));

  // Component names (FooComponent, BarService, etc.)
  const classMatches = text.match(/\b[A-Z][a-zA-Z]+(?:Component|Service|Module|Directive|Pipe|Guard|Interceptor|Store)\b/g);
  if (classMatches) classMatches.forEach(m => anchors.add(m));

  // ADP/SDF component tags
  const tagMatches = text.match(/\b(?:adp|sdf)-[\w-]+\b/gi);
  if (tagMatches) tagMatches.forEach(m => anchors.add(m.toLowerCase()));

  return [...anchors].slice(0, 20); // cap at 20
}

/** Extract file paths from tool input. */
function extractInputPaths(input) {
  if (!input) return [];
  const paths = [];
  for (const key of ['filePath', 'path', 'includePattern']) {
    if (typeof input[key] === 'string') paths.push(input[key]);
  }
  if (Array.isArray(input.replacements)) {
    for (const r of input.replacements) {
      if (typeof r.filePath === 'string') paths.push(r.filePath);
    }
  }
  return [...new Set(paths)];
}
