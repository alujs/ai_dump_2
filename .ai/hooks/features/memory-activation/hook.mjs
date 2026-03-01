/**
 * .ai/hooks/modules/memory-activation.mjs — Memory Activation
 *
 * Priority: 60
 * hotPathSafe: true    (rule evaluation is O(rules), no IO on hot path)
 * critical: false
 *
 * CONTRACT §14 row 7.
 *
 * Standalone value: evaluates static followup rules from
 * .ai/hooks/followup-rules.json. Works without journal or Neo4j.
 *
 * Progressive: if memory-journal artifacts exist, can enrichment followups
 * with prior experience data. If Neo4j is reachable, can add policy context.
 *
 * Events:
 *   PreToolUse   — evaluate rules triggered by PreToolUse, inject/warn/ask
 *   PostToolUse  — evaluate rules triggered by PostToolUse, enqueue followups
 */

import { readFileSync } from 'node:fs';

let _rulesCache = null;
// Per-invocation cooldown tracking (persisted via state for cross-invocation)
// In-process we just check state for prior fires.

// ── Module ───────────────────────────────────────────────────────────────

export default {
  name: 'memory-activation',
  supports: new Set(['PreToolUse', 'PostToolUse']),
  priority: 60,
  hotPathSafe: true,
  critical: false,

  async handle(eventName, ctx) {
    const rules = loadRules(ctx);
    if (!rules || rules.length === 0) return {};

    switch (eventName) {
      case 'PreToolUse':  return evaluateRules(ctx, rules, 'PreToolUse');
      case 'PostToolUse': return evaluateRules(ctx, rules, 'PostToolUse');
      default:            return {};
    }
  },
};

// ── Rules loader ─────────────────────────────────────────────────────────

function loadRules(ctx) {
  if (_rulesCache) return _rulesCache;

  try {
    const raw = readFileSync(ctx.paths.followupRulesFile, 'utf-8');
    const parsed = JSON.parse(raw);
    _rulesCache = (parsed.rules || []).filter(r => r.enabled !== false);
    return _rulesCache;
  } catch {
    _rulesCache = [];
    return _rulesCache;
  }
}

// ── Rule evaluation ──────────────────────────────────────────────────────

function evaluateRules(ctx, rules, eventName) {
  const toolName = ctx.event.toolName || '';
  const toolInput = ctx.event.toolInput || {};
  const emitEvents = [];
  const warnings = [];
  const additionalContext = [];
  let decision = undefined;
  let denyReason = undefined;

  // Get pending followups from state for cooldown tracking
  const pending = ctx.state.memory?.pendingFollowups || {};
  const statePatch = {};

  for (const rule of rules) {
    // Must match the event type
    if (rule.trigger.event !== eventName) continue;

    // ── Tool name matching ───────────────────────────────────────────
    if (rule.trigger.toolName && rule.trigger.toolName !== toolName) continue;
    if (rule.trigger.toolNamePattern) {
      try {
        if (!new RegExp(rule.trigger.toolNamePattern, 'i').test(toolName)) continue;
      } catch { continue; } // bad regex → skip rule
    }

    // ── Path matching ────────────────────────────────────────────────
    const inputPaths = extractPaths(toolInput);
    let matchedPath = null;

    if (rule.trigger.pathPatterns?.length) {
      matchedPath = inputPaths.find(p => rule.trigger.pathPatterns.some(pat => matchGlob(p, pat)));
      if (!matchedPath) continue; // no path matched
    }

    // ── Exclude patterns ─────────────────────────────────────────────
    if (rule.trigger.excludePathPatterns?.length && matchedPath) {
      if (rule.trigger.excludePathPatterns.some(pat => matchGlob(matchedPath, pat))) continue;
    }

    // ── Additional conditions ────────────────────────────────────────
    if (rule.trigger.conditions?.length) {
      const allMet = rule.trigger.conditions.every(cond => checkCondition(cond, ctx));
      if (!allMet) continue;
    }

    // ── Cooldown check ───────────────────────────────────────────────
    if (rule.cooldown) {
      const fires = pending[rule.id];
      if (fires) {
        if (rule.cooldown.perWorkId && (fires.workIdCount || 0) >= rule.cooldown.perWorkId) continue;
        if (rule.cooldown.perSession && (fires.sessionCount || 0) >= rule.cooldown.perSession) continue;
        if (rule.cooldown.intervalMs && fires.lastFiredTs && (Date.now() - fires.lastFiredTs < rule.cooldown.intervalMs)) continue;
      }
    }

    // ── Rule matched — apply followup ────────────────────────────────
    const followup = rule.followup;
    const templateVars = { matchedPath: matchedPath || '', toolName, workId: ctx.ids.workId };

    emitEvents.push({
      ts: Date.now(), event: eventName, producer: 'memory-activation',
      kind: 'MEMORY_FOLLOWUP_TRIGGER',
      hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
      toolName,
      data: { ruleId: rule.id, action: followup.action, matchedPath },
    });

    switch (followup.action) {
      case 'inject_context':
        if (followup.contextKey && followup.contextValue) {
          additionalContext.push({
            key: followup.contextKey,
            value: templateReplace(followup.contextValue, templateVars),
          });
        }
        break;

      case 'warn':
        if (followup.message) {
          warnings.push(templateReplace(followup.message, templateVars));
        }
        break;

      case 'ask':
        if (!decision || decision === 'allow') {
          decision = 'ask';
          denyReason = followup.message || `Followup rule '${rule.id}' requires confirmation.`;
        }
        break;

      case 'enqueue_tool':
        // Record the followup as pending for the next PreToolUse to pick up
        additionalContext.push({
          key: `followup-${rule.id}`,
          value: followup.message || `Followup: ${rule.description || rule.id}`,
        });
        break;
    }

    // Update cooldown tracking
    const existing = pending[rule.id] || { workIdCount: 0, sessionCount: 0, lastFiredTs: 0 };
    statePatch.memory = statePatch.memory || {};
    statePatch.memory.pendingFollowups = statePatch.memory.pendingFollowups || {};
    statePatch.memory.pendingFollowups[rule.id] = {
      rule: rule.id,
      triggeredAt: Date.now(),
      status: 'pending',
      workIdCount: (existing.workIdCount || 0) + 1,
      sessionCount: (existing.sessionCount || 0) + 1,
      lastFiredTs: Date.now(),
    };

    // First match wins (per followup-rules.schema: "first match wins unless multiMatch")
    break;
  }

  const result = {};
  if (decision)                  { result.decision = decision; result.denyReason = denyReason; }
  if (additionalContext.length)  result.additionalContext = additionalContext;
  if (warnings.length)           result.warnings = warnings;
  if (emitEvents.length)         result.emitEvents = emitEvents;
  if (Object.keys(statePatch).length) result.statePatch = statePatch;

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractPaths(input) {
  if (!input) return [];
  const paths = [];
  if (typeof input.filePath === 'string') paths.push(input.filePath);
  if (typeof input.path === 'string') paths.push(input.path);
  if (typeof input.includePattern === 'string') paths.push(input.includePattern);
  if (Array.isArray(input.replacements)) {
    for (const r of input.replacements) {
      if (typeof r.filePath === 'string') paths.push(r.filePath);
    }
  }
  return [...new Set(paths)];
}

/** Simple glob match supporting ** and * wildcards. */
function matchGlob(path, pattern) {
  if (!path || !pattern) return false;
  const p = path.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');

  // **/*.ext → match any file with that extension
  if (pat.startsWith('**/')) {
    const suffix = pat.slice(3);
    if (suffix.startsWith('*')) {
      // **/*.ts → ends with .ts
      const ext = suffix.slice(1);
      return p.endsWith(ext);
    }
    // **/foo.ts → contains /foo.ts or is foo.ts
    return p.endsWith('/' + suffix) || p === suffix;
  }

  // foo/** → starts with foo/
  if (pat.endsWith('/**')) {
    const prefix = pat.slice(0, -3);
    return p.startsWith(prefix + '/') || p === prefix;
  }

  // foo/* → one level under foo/
  if (pat.endsWith('/*')) {
    const prefix = pat.slice(0, -2);
    const remainder = p.slice(prefix.length + 1);
    return p.startsWith(prefix + '/') && !remainder.includes('/');
  }

  // src/**/*.ts → starts with src/ and ends with .ts
  const dblStar = pat.indexOf('/**/');
  if (dblStar !== -1) {
    const prefix = pat.slice(0, dblStar);
    const suffix = pat.slice(dblStar + 4);
    if (!p.startsWith(prefix + '/') && p !== prefix) return false;
    if (suffix.startsWith('*')) {
      return p.endsWith(suffix.slice(1));
    }
    return p.endsWith('/' + suffix) || p === suffix;
  }

  // Exact match
  return p === pat;
}

/** Eval a condition against ctx. */
function checkCondition(cond, ctx) {
  const val = resolveFieldPath(cond.field, ctx);
  switch (cond.op) {
    case 'eq':        return val === cond.value;
    case 'neq':       return val !== cond.value;
    case 'contains':  return typeof val === 'string' && val.includes(String(cond.value));
    case 'matches':   try { return typeof val === 'string' && new RegExp(String(cond.value), 'i').test(val); } catch { return false; }
    case 'exists':    return val !== undefined && val !== null;
    case 'notExists': return val === undefined || val === null;
    default:          return false;
  }
}

/** Resolve a dot-path like "toolInput.filePath" or "state.core.phase" */
function resolveFieldPath(field, ctx) {
  if (!field) return undefined;
  // Map top-level field prefixes to ctx properties
  const parts = field.split('.');
  let obj;
  if (parts[0] === 'state') {
    obj = ctx.state;
    parts.shift();
  } else if (parts[0] === 'toolInput') {
    obj = ctx.event.toolInput;
    parts.shift();
  } else if (parts[0] === 'event') {
    obj = ctx.event;
    parts.shift();
  } else {
    // Try ctx.event first
    obj = ctx.event;
  }

  for (const part of parts) {
    if (obj == null) return undefined;
    obj = obj[part];
  }
  return obj;
}

/** Simple {{variable}} template replacement. */
function templateReplace(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}
