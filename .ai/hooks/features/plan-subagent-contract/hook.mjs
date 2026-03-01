/**
 * .ai/hooks/modules/plan-subagent-contract.mjs — Plan Subagent Contract
 *
 * Priority: 30
 * hotPathSafe: false
 * critical: false
 *
 * CONTRACT §14 row 4.
 *
 * Standalone value: makes Plan subagents produce consistent artifacts
 * and makes those artifacts discoverable by planGraph-exec.
 *
 * Events:
 *   SubagentStart — inject schema paths, output paths, session IDs, neo4j cap
 *   SubagentStop  — validate produced planGraph + manifest, register artifacts
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ── Module ───────────────────────────────────────────────────────────────

export default {
  name: 'plan-subagent-contract',
  supports: new Set(['SubagentStart', 'SubagentStop']),
  priority: 30,
  hotPathSafe: false,
  critical: false,

  async handle(eventName, ctx) {
    switch (eventName) {
      case 'SubagentStart': return handleStart(ctx);
      case 'SubagentStop':  return handleStop(ctx);
      default:              return {};
    }
  },
};

// ── SubagentStart ────────────────────────────────────────────────────────

function handleStart(ctx) {
  const agentType = ctx.event.subagentType || '';

  // Only inject for Plan-type subagents
  if (!isPlanAgent(agentType)) return {};

  const aid = ctx.event.subagentId || 'a01';
  const saRoot = join(ctx.feature.output, ctx.config.subagentDir || 'sa', ctx.config.agentTypeDir || 'Plan', aid);
  const schemaDir = ctx.paths.schemaDir;

  const requiredOutputs = ctx.config.requiredOutputs || ['planGraph.json', 'manifest.json'];

  const injection = {
    _hookSessionId: ctx.ids.sessionId,
    _hookWorkId: ctx.ids.workId,
    _hookAgentId: aid,
    _hookOutputRoot: saRoot,
    _hookRequiredOutputs: requiredOutputs,
    _hookSchemaDir: schemaDir,
    _hookNeo4jCapability: ctx.cap.neo4j,
  };

  const emitEvents = [{
    ts: Date.now(),
    event: 'SubagentStart',
    producer: 'plan-subagent-contract',
    kind: 'SUBAGENT_INJECT',
    hookRunId: ctx.ids.hookRunId,
    turnId: ctx.ids.turnId,
    workId: ctx.ids.workId,
    data: { agentType, agentId: aid, outputRoot: saRoot },
  }];

  return {
    additionalContext: [{
      key: 'plan-subagent-contract',
      value: [
        `You are a Plan subagent. Session: ${ctx.ids.sessionId}, Work: ${ctx.ids.workId}.`,
        `Write your planGraph.json to: ${saRoot}/planGraph.json`,
        `Write your manifest.json to: ${saRoot}/manifest.json (optional)`,
        `planGraph must have a "nodes" array. Each node needs: id, tool/tools, description.`,
        `Optional per-node fields: scope (glob array), status, reason, dependencies (node id array).`,
        `Neo4j available: ${ctx.cap.neo4j?.reachable ? 'yes' : 'no'}.`,
      ].join('\n'),
    }],
    emitEvents,
  };
}

// ── SubagentStop ─────────────────────────────────────────────────────────

function handleStop(ctx) {
  const agentType = ctx.event.subagentType || '';
  if (!isPlanAgent(agentType)) return {};

  const aid = ctx.event.subagentId || 'a01';
  const saRoot = join(ctx.feature.output, ctx.config.subagentDir || 'sa', ctx.config.agentTypeDir || 'Plan', aid);
  const requiredOutputs = ctx.config.requiredOutputs || ['planGraph.json', 'manifest.json'];
  const pgPath = join(saRoot, requiredOutputs[0]);
  const mfPath = join(saRoot, requiredOutputs[1] || 'manifest.json');

  const emitEvents = [];
  const registerArtifacts = [];
  const warnings = [];
  const statePatch = {};

  // ── Validate planGraph ─────────────────────────────────────────────
  let planGraphValid = false;
  if (existsSync(pgPath)) {
    try {
      const raw = readFileSync(pgPath, 'utf-8');
      const pg = JSON.parse(raw);

      // Basic structural validation
      if (!pg.nodes || !Array.isArray(pg.nodes)) {
        warnings.push(`planGraph.json from ${aid} is missing required "nodes" array.`);
        emitEvents.push(makeEvent(ctx, 'PLAN_GRAPH_DENY', { agentId: aid, reason: 'missing nodes array' }));
      } else if (pg.nodes.length === 0) {
        warnings.push(`planGraph.json from ${aid} has zero nodes.`);
        emitEvents.push(makeEvent(ctx, 'PLAN_GRAPH_WARN', { agentId: aid, reason: 'empty nodes array' }));
        planGraphValid = true; // structurally valid, just empty
      } else {
        // Validate each node has required fields
        const badNodes = pg.nodes.filter(n => !n.id || !n.description);
        if (badNodes.length > 0) {
          warnings.push(`planGraph.json: ${badNodes.length} node(s) missing id or description.`);
        }
        planGraphValid = true;
      }

      if (planGraphValid) {
        const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
        const st = statSync(pgPath);
        const relPath = ctx.paths.relRef(pgPath);

        registerArtifacts.push({
          ts: Date.now(),
          producer: 'plan-subagent-contract',
          kind: 'plan_graph',
          ref: relPath,
          workId: ctx.ids.workId,
          hash,
          summary: `planGraph from subagent ${aid} with ${pg.nodes.length} nodes`,
          tags: pg.nodes.map(n => n.id).slice(0, 20),
          agentId: aid,
        });

        // Update plan pointer in state so planGraph-exec can find it
        statePatch.plan = {
          currentPath: relPath,
          mtime: st.mtimeMs,
          hash,
          status: 'accepted',
        };

        emitEvents.push(makeEvent(ctx, 'SUBAGENT_HARVEST', {
          agentId: aid, artifact: 'planGraph.json', nodeCount: pg.nodes.length, hash,
        }));
      }
    } catch (err) {
      warnings.push(`planGraph.json from ${aid} failed to parse: ${err.message}`);
      emitEvents.push(makeEvent(ctx, 'PLAN_GRAPH_DENY', { agentId: aid, reason: err.message }));
    }
  } else {
    warnings.push(`Plan subagent ${aid} did not produce planGraph.json at ${pgPath}`);
    emitEvents.push(makeEvent(ctx, 'PLAN_GRAPH_MISSING', { agentId: aid, expectedPath: pgPath }));
  }

  // ── Check manifest (optional) ─────────────────────────────────────
  if (existsSync(mfPath)) {
    try {
      const raw = readFileSync(mfPath, 'utf-8');
      const mf = JSON.parse(raw);
      const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);

      registerArtifacts.push({
        ts: Date.now(),
        producer: 'plan-subagent-contract',
        kind: 'plan_manifest',
        ref: ctx.paths.relRef(mfPath),
        workId: ctx.ids.workId,
        hash,
        summary: `Manifest from subagent ${aid}`,
        agentId: aid,
      });

      emitEvents.push(makeEvent(ctx, 'SUBAGENT_HARVEST', {
        agentId: aid, artifact: 'manifest.json', hash,
      }));
    } catch {
      // Manifest is optional — parse failure is just a warning
      warnings.push(`manifest.json from ${aid} exists but failed to parse.`);
    }
  }

  return { emitEvents, registerArtifacts, warnings, statePatch };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isPlanAgent(type) {
  const t = (type || '').toLowerCase();
  return t === 'plan' || t === 'planner' || t.includes('plan');
}

function makeEvent(ctx, kind, data) {
  return {
    ts: Date.now(),
    event: 'SubagentStop',
    producer: 'plan-subagent-contract',
    kind,
    hookRunId: ctx.ids.hookRunId,
    turnId: ctx.ids.turnId,
    workId: ctx.ids.workId,
    data,
  };
}
