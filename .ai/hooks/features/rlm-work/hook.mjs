/**
 * .ai/hooks/modules/rlm-work.mjs — RLM Work Orchestration
 *
 * Priority: 40
 * hotPathSafe: true
 * critical: false
 *
 * CONTRACT §14 row 5.
 *
 * Standalone value: enforces "use subagents for bounded work" per policy,
 * maintains context handoffs, and harvests subagent outputs.
 *
 * Reads policy from .ai/hooks/rlm-policy.json (see rlm-policy.schema.json).
 * If policy file is absent → warn-only mode (no enforcement, just logging).
 *
 * Events:
 *   PreToolUse     — check if tool requires subagent delegation per policy
 *   SubagentStart  — inject minimal context packet (IDs + artifact roots + constraints)
 *   SubagentStop   — harvest subagent outputs into artifact registry
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

let _policyCache = null;

// ── Module ───────────────────────────────────────────────────────────────

export default {
  name: 'rlm-work',
  supports: new Set(['PreToolUse', 'SubagentStart', 'SubagentStop']),
  priority: 40,
  hotPathSafe: true,
  critical: false,

  async handle(eventName, ctx) {
    switch (eventName) {
      case 'PreToolUse':    return handlePreToolUse(ctx);
      case 'SubagentStart': return handleSubagentStart(ctx);
      case 'SubagentStop':  return handleSubagentStop(ctx);
      default:              return {};
    }
  },
};

// ── Policy loader ────────────────────────────────────────────────────────

function loadPolicy(ctx) {
  if (_policyCache) return _policyCache;

  try {
    const raw = readFileSync(ctx.paths.policyFile, 'utf-8');
    _policyCache = JSON.parse(raw);
    return _policyCache;
  } catch {
    return null; // no policy → warn-only mode
  }
}

// ── PreToolUse ───────────────────────────────────────────────────────────

function handlePreToolUse(ctx) {
  const policy = loadPolicy(ctx);
  const toolName = ctx.event.toolName;
  if (!toolName) return {};

  const emitEvents = [];
  const warnings = [];
  const statePatch = {};

  // Track that policy was loaded (or not)
  if (policy) {
    const hash = createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
    statePatch.rlm = { policyLoaded: true, lastPolicyHash: hash };
  } else {
    statePatch.rlm = { policyLoaded: false };
  }

  if (!policy) {
    // No policy file → pass through, just log once
    return { decision: 'allow', statePatch };
  }

  // ── Check phase overrides ─────────────────────────────────────────
  const phase = ctx.state.core?.phase || 'UNINITIALIZED';
  const phaseOverride = policy.phaseOverrides?.[phase];

  // ── requireSubagent check ─────────────────────────────────────────
  const skipSubagent = phaseOverride?.requireSubagent === 'skip';

  if (!skipSubagent && Array.isArray(policy.requireSubagent)) {
    const rule = policy.requireSubagent.find(r => r.toolName === toolName);
    if (rule) {
      // Check exemptions
      const toolInput = ctx.event.toolInput || {};
      const targetPath = toolInput.filePath || toolInput.path || '';
      const isExempt = (rule.exemptPatterns || []).some(pat => matchGlob(targetPath, pat));

      if (!isExempt) {
        const mode = rule.mode || policy.defaultMode || 'warn';

        emitEvents.push({
          ts: Date.now(), event: 'PreToolUse', producer: 'rlm-work',
          kind: 'RLM_SUBAGENT_REQUIRED',
          hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
          toolName, decision: mode,
          reason: rule.reason,
          data: { mode, targetPath },
        });

        if (mode === 'deny') {
          return {
            decision: 'deny',
            denyReason: rule.reason || `Tool '${toolName}' requires subagent delegation per RLM policy.`,
            emitEvents, statePatch,
          };
        }
        if (mode === 'ask') {
          return {
            decision: 'ask',
            denyReason: rule.reason || `Tool '${toolName}' should use subagent delegation. Continue anyway?`,
            emitEvents, statePatch,
          };
        }
        // warn mode
        warnings.push(rule.reason || `RLM policy suggests subagent for '${toolName}'.`);
      }
    }
  }

  // ── broadDiscovery check ──────────────────────────────────────────
  const skipBroad = phaseOverride?.broadDiscovery === 'skip';

  if (!skipBroad && policy.broadDiscovery?.rules) {
    const bdMode = policy.broadDiscovery.mode || 'warn';
    const toolInput = ctx.event.toolInput || {};

    for (const rule of policy.broadDiscovery.rules) {
      if (rule.toolName !== toolName) continue;

      let matched = false;
      switch (rule.check) {
        case 'no_include_pattern':
          matched = !toolInput.includePattern;
          break;
        case 'wildcard_query':
          matched = typeof toolInput.query === 'string' && /^\*{1,2}(\.\*)?$/.test(toolInput.query.trim());
          break;
        case 'max_results_high':
          matched = typeof toolInput.maxResults === 'number' && toolInput.maxResults > (rule.threshold || 500);
          break;
        case 'no_scope':
          matched = !toolInput.includePattern && !toolInput.path;
          break;
      }

      if (matched) {
        emitEvents.push({
          ts: Date.now(), event: 'PreToolUse', producer: 'rlm-work',
          kind: 'UNBOUNDED_GREP_WARN',
          hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
          toolName, reason: rule.reason,
          data: { check: rule.check, mode: bdMode },
        });

        // Don't duplicate deny/ask if graph-pretooluse already caught it
        // Just add warning
        warnings.push(rule.reason || `Broad discovery detected: ${rule.check}`);
        break; // first match wins
      }
    }
  }

  return { decision: 'allow', emitEvents, warnings, statePatch };
}

// ── SubagentStart ────────────────────────────────────────────────────────

function handleSubagentStart(ctx) {
  const aid = ctx.event.subagentId || 'a01';
  const agentType = ctx.event.subagentType || 'unknown';
  const saRoot = join(ctx.feature.output, ctx.config.subagentDir || 'sa', agentType, aid);

  const contextPacket = {
    sessionId: ctx.ids.sessionId,
    workId: ctx.ids.workId,
    agentId: aid,
    agentType,
    artifactRoot: saRoot,
    turnId: ctx.ids.turnId,
    phase: ctx.state.core?.phase || 'UNINITIALIZED',
    neo4jAvailable: ctx.cap.neo4j?.reachable || false,
    planGraphPath: ctx.state.plan?.currentPath || null,
  };

  return {
    additionalContext: [{
      key: 'rlm-context-packet',
      value: `RLM context: session=${ctx.ids.sessionId} work=${ctx.ids.workId} agent=${aid} type=${agentType}. Write outputs to: ${saRoot}/`,
    }],
    emitEvents: [{
      ts: Date.now(), event: 'SubagentStart', producer: 'rlm-work',
      kind: 'SUBAGENT_INJECT',
      hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
      data: contextPacket,
    }],
  };
}

// ── SubagentStop ─────────────────────────────────────────────────────────

function handleSubagentStop(ctx) {
  const aid = ctx.event.subagentId || 'a01';
  const agentType = ctx.event.subagentType || 'unknown';
  const saRoot = join(ctx.feature.output, ctx.config.subagentDir || 'sa', agentType, aid);

  const emitEvents = [];
  const registerArtifacts = [];

  // Scan subagent output directory for files to register
  if (existsSync(saRoot)) {
    try {
      const files = readdirSync(saRoot);
      for (const file of files) {
        const fpath = join(saRoot, file);
        try {
          const st = statSync(fpath);
          if (!st.isFile()) continue;

          const raw = readFileSync(fpath, 'utf-8');
          const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);

          registerArtifacts.push({
            ts: Date.now(),
            producer: 'rlm-work',
            kind: 'subagent_output',
            ref: ctx.paths.relRef(fpath),
            workId: ctx.ids.workId,
            hash,
            summary: `Subagent ${agentType}/${aid} output: ${file}`,
            agentId: aid,
          });
        } catch { /* skip unreadable files */ }
      }
    } catch { /* directory listing failed */ }
  }

  emitEvents.push({
    ts: Date.now(), event: 'SubagentStop', producer: 'rlm-work',
    kind: 'SUBAGENT_HARVEST',
    hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
    data: { agentId: aid, agentType, artifactCount: registerArtifacts.length },
  });

  return { emitEvents, registerArtifacts };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Simple glob match: supports ** and * at the end of patterns. */
function matchGlob(path, pattern) {
  if (!path || !pattern) return false;
  const normalPath = path.replace(/\\/g, '/');
  const normalPat = pattern.replace(/\\/g, '/');

  // .ai/tmp/** → anything under .ai/tmp/
  if (normalPat.endsWith('/**')) {
    const prefix = normalPat.slice(0, -3);
    return normalPath.startsWith(prefix);
  }
  // .ai/tmp/* → one level under .ai/tmp/
  if (normalPat.endsWith('/*')) {
    const prefix = normalPat.slice(0, -2);
    return normalPath.startsWith(prefix) && !normalPath.slice(prefix.length + 1).includes('/');
  }
  // Exact match
  return normalPath === normalPat || normalPath.endsWith('/' + normalPat);
}
