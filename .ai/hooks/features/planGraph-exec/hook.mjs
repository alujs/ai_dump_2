/**
 * planGraph-exec — Plan graph execution guard
 *
 * Priority: 20
 * hotPathSafe: true
 * critical: false
 *
 * What it does:
 *   If a planGraph exists, clamps tool scope to planned directories/files.
 *   If no planGraph exists, warns once per workId and allows all tools.
 *
 * Dependencies: none
 *
 * To copy this feature:
 *   Copy this folder. Zero external dependencies.
 *
 * Events:
 *   PreToolUse — consult planGraph if present; warn or clamp; deny if forbidden
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

// ── Module ───────────────────────────────────────────────────────────────

export default {
  name: 'planGraph-exec',
  supports: new Set(['PreToolUse']),
  priority: 20,
  hotPathSafe: true,
  critical: false,

  async handle(eventName, ctx) {
    const toolName = ctx.event.toolName;
    if (!toolName) return {};

    // ── Load planGraph ─────────────────────────────────────────────────
    const pgState = ctx.state.plan;
    let planGraph = null;
    let pgMeta = null;

    if (pgState?.currentPath) {
      try {
        const absPath = resolve(ctx.paths.sessionRoot, pgState.currentPath);
        const raw = readFileSync(absPath, 'utf-8');
        planGraph = JSON.parse(raw);

        if (!planGraph.nodes || !Array.isArray(planGraph.nodes)) {
          planGraph = null;
        } else {
          const st = statSync(absPath);
          const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
          pgMeta = { path: pgState.currentPath, mtime: st.mtimeMs, hash };
        }
      } catch {
        planGraph = null;
      }
    }

    if (!planGraph) {
      try {
        const defaultPath = join(ctx.feature.output, ctx.config.planGraphFile || 'planGraph.json');
        const raw = readFileSync(defaultPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.nodes && Array.isArray(parsed.nodes)) {
          planGraph = parsed;
          const st = statSync(defaultPath);
          const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
          const relPath = ctx.paths.relRef(defaultPath);
          pgMeta = { path: relPath, mtime: st.mtimeMs, hash };
        }
      } catch { /* no default planGraph */ }
    }

    // ── No planGraph: warn and allow ───────────────────────────────────
    if (!planGraph) {
      const alreadyWarned = ctx.state.plan?.warnedMissing === ctx.ids.workId;

      const emitEvents = [];
      const warnings = [];
      const statePatch = {};

      if (!alreadyWarned) {
        warnings.push(`No planGraph found for work unit ${ctx.ids.workId}. Tool calls are unscoped. Consider creating a plan.`);
        emitEvents.push({
          ts: Date.now(), event: 'PreToolUse', producer: 'planGraph-exec',
          kind: 'PLAN_GRAPH_MISSING',
          hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
          toolName,
          reason: 'No planGraph found',
        });
        statePatch.plan = { warnedMissing: ctx.ids.workId };
      }

      return { decision: 'allow', emitEvents, warnings, statePatch };
    }

    // ── planGraph exists: consult it ───────────────────────────────────
    const statePatch = {};
    if (pgMeta && pgMeta.hash !== pgState?.hash) {
      statePatch.plan = {
        currentPath: pgMeta.path,
        mtime: pgMeta.mtime,
        hash: pgMeta.hash,
        status: 'accepted',
      };
    }

    const relevantNodes = findRelevantNodes(planGraph, toolName, ctx.event.toolInput);

    // Case 1: forbidden
    const forbidden = relevantNodes.find(n => n.status === 'forbidden' || n.status === 'denied');
    if (forbidden) {
      return {
        decision: 'deny',
        denyReason: `planGraph forbids this operation: ${forbidden.reason || forbidden.description || 'out of scope'}`,
        statePatch,
        emitEvents: [{
          ts: Date.now(), event: 'PreToolUse', producer: 'planGraph-exec',
          kind: 'PLAN_GRAPH_DENY',
          hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
          toolName,
          reason: forbidden.reason || 'Forbidden by plan',
          data: { nodeId: forbidden.id },
        }],
      };
    }

    // Case 2: scoped — clamp search tools
    const scoped = relevantNodes.find(n => n.scope);
    if (scoped && isSearchTool(toolName)) {
      const updatedInput = clampSearchScope(toolName, ctx.event.toolInput, scoped.scope);
      if (updatedInput) {
        return {
          decision: 'allow',
          updatedInput,
          statePatch,
          emitEvents: [{
            ts: Date.now(), event: 'PreToolUse', producer: 'planGraph-exec',
            kind: 'PLAN_GRAPH_USED',
            hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
            toolName,
            data: { nodeId: scoped.id, clampedScope: scoped.scope },
          }],
        };
      }
    }

    // Case 3: no specific entry — allow with note
    return {
      decision: 'allow',
      statePatch,
      emitEvents: [{
        ts: Date.now(), event: 'PreToolUse', producer: 'planGraph-exec',
        kind: 'PLAN_GRAPH_USED',
        hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
        toolName,
        data: { matched: relevantNodes.length > 0, nodeIds: relevantNodes.map(n => n.id) },
      }],
    };
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────

function findRelevantNodes(planGraph, toolName, toolInput) {
  if (!planGraph?.nodes) return [];

  return planGraph.nodes.filter(node => {
    if (node.tool === toolName) return true;
    if (Array.isArray(node.tools) && node.tools.includes(toolName)) return true;
    if (node.scope && toolInput) {
      const inputPaths = extractInputPaths(toolInput);
      if (inputPaths.some(p => matchesScope(p, node.scope))) return true;
    }
    return false;
  });
}

function extractInputPaths(input) {
  if (!input) return [];
  const paths = [];
  if (typeof input.filePath === 'string') paths.push(input.filePath);
  if (typeof input.path === 'string') paths.push(input.path);
  if (typeof input.includePattern === 'string') paths.push(input.includePattern);
  if (typeof input.query === 'string' && input.query.includes('/')) paths.push(input.query);
  if (Array.isArray(input.replacements)) {
    for (const r of input.replacements) {
      if (typeof r.filePath === 'string') paths.push(r.filePath);
    }
  }
  return paths;
}

function matchesScope(path, scope) {
  const normalPath = path.replace(/\\/g, '/');
  const scopes = Array.isArray(scope) ? scope : [scope];
  return scopes.some(s => {
    const normalScope = s.replace(/\\/g, '/').replace(/\*\*$/, '');
    return normalPath.startsWith(normalScope) || normalPath.includes(normalScope);
  });
}

function isSearchTool(toolName) {
  return ['grep_search', 'file_search', 'semantic_search', 'list_dir'].includes(toolName);
}

function clampSearchScope(toolName, input, scope) {
  const scopeDir = Array.isArray(scope) ? scope[0] : scope;
  if (!scopeDir) return null;

  const cleanScope = scopeDir.replace(/\/?\*\*$/, '');

  switch (toolName) {
    case 'grep_search': {
      if (!input?.includePattern) {
        return { includePattern: `${cleanScope}/**` };
      }
      const existing = input.includePattern.replace(/\\/g, '/');
      if (!existing.startsWith(cleanScope)) {
        return { includePattern: `${cleanScope}/**` };
      }
      return null;
    }
    case 'file_search': {
      const q = input?.query || '';
      if (!q.startsWith(cleanScope)) {
        return { query: `${cleanScope}/${q.replace(/^(\*\*\/)?/, '')}` };
      }
      return null;
    }
    case 'list_dir': {
      const p = (input?.path || '').replace(/\\/g, '/');
      if (p && !p.includes(cleanScope)) {
        return null;
      }
      return null;
    }
    default:
      return null;
  }
}
