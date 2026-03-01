/**
 * .ai/hooks/modules/stop-synth.mjs — Stop Artifact Synthesis
 *
 * Priority: 100
 * hotPathSafe: false
 * critical: false
 *
 * CONTRACT §14 row 8.
 *
 * Standalone value: generates ADR drafts and session summaries at Stop,
 * using the prompt audit trail and event log. Optional — omit entirely
 * if you don't want ADRs.
 *
 * Events:
 *   Stop — read e.jsonl, synthesize summary + optional ADR skeletons
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// ── Module ───────────────────────────────────────────────────────────────

export default {
  name: 'stop-synth',
  supports: new Set(['Stop']),
  priority: 100,
  hotPathSafe: false,
  critical: false,

  async handle(eventName, ctx) {
    if (eventName !== 'Stop') return {};

    const emitEvents = [];
    const registerArtifacts = [];
    const warnings = [];

    // ── Read event log ───────────────────────────────────────────────
    let events = [];
    try {
      const raw = readFileSync(ctx.paths.eventsFile, 'utf-8');
      events = raw.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch {
      warnings.push('Could not read event log for synthesis.');
      return { warnings };
    }

    if (events.length === 0) {
      return { warnings: ['Empty event log — nothing to synthesize.'] };
    }

    // ── Build summary ────────────────────────────────────────────────
    const summary = buildSummary(ctx, events);
    const summaryPath = join(ctx.feature.output, ctx.config.summaryFile || 'summary.md');

    try {
      mkdirSync(dirname(summaryPath), { recursive: true });
      writeFileSync(summaryPath, summary, 'utf-8');

      const hash = createHash('sha256').update(summary).digest('hex').slice(0, 16);
      registerArtifacts.push({
        ts: Date.now(),
        producer: 'stop-synth',
        kind: 'session_summary',
        ref: ctx.paths.relRef(summaryPath),
        workId: ctx.ids.workId,
        hash,
        summary: `Session summary for ${ctx.ids.sessionId}`,
      });
    } catch (err) {
      warnings.push(`Failed to write summary: ${err.message}`);
    }

    // ── Build ADR skeleton (if there were significant decisions) ─────
    const decisions = events.filter(e =>
      e.kind === 'TOOL_DECISION' && (e.decision === 'deny' || e.decision === 'ask')
    );
    const phaseTransitions = events.filter(e => e.kind === 'PHASE_TRANSITION');
    const planEvents = events.filter(e => e.kind?.startsWith('PLAN_GRAPH_'));

    if (decisions.length > 0 || planEvents.length > 0) {
      const adr = buildAdrSkeleton(ctx, events, decisions, phaseTransitions, planEvents);
      const adrDir = join(ctx.feature.output, ctx.config.adrDir || 'adr');
      const adrPath = join(adrDir, `adr-${ctx.ids.sessionId}-${ctx.ids.workId}.md`);

      try {
        mkdirSync(adrDir, { recursive: true });
        writeFileSync(adrPath, adr, 'utf-8');

        const hash = createHash('sha256').update(adr).digest('hex').slice(0, 16);
        registerArtifacts.push({
          ts: Date.now(),
          producer: 'stop-synth',
          kind: 'adr_draft',
          ref: ctx.paths.relRef(adrPath),
          workId: ctx.ids.workId,
          hash,
          summary: `ADR draft: ${decisions.length} decisions, ${planEvents.length} plan events`,
        });
      } catch (err) {
        warnings.push(`Failed to write ADR: ${err.message}`);
      }
    }

    emitEvents.push({
      ts: Date.now(), event: 'Stop', producer: 'stop-synth',
      kind: 'SESSION_STOP',
      hookRunId: ctx.ids.hookRunId, turnId: ctx.ids.turnId, workId: ctx.ids.workId,
      data: {
        summaryWritten: true,
        adrWritten: decisions.length > 0 || planEvents.length > 0,
        totalEvents: events.length,
      },
    });

    return { emitEvents, registerArtifacts, warnings };
  },
};

// ── Summary builder ──────────────────────────────────────────────────────

function buildSummary(ctx, events) {
  const toolCalls = events.filter(e => e.kind === 'TOOL_DECISION');
  const outcomes = events.filter(e => e.kind === 'TOOL_OUTCOME');
  const errors = events.filter(e => e.kind?.startsWith('ERROR_'));
  const denials = events.filter(e => e.kind === 'TOOL_DECISION' && e.decision !== 'allow');
  const phases = events.filter(e => e.kind === 'PHASE_TRANSITION');
  const friction = events.filter(e => e.kind === 'MEMORY_CANDIDATE' && e.data?.type === 'friction');
  const budgetExceeded = events.filter(e => e.kind === 'BUDGET_EXCEEDED');

  const successCount = outcomes.filter(e => e.data?.success).length;
  const failCount = outcomes.filter(e => !e.data?.success).length;

  // Unique tools used
  const toolNames = [...new Set(toolCalls.map(e => e.toolName).filter(Boolean))];

  // Unique files touched
  const touchedPaths = [...new Set(
    outcomes.flatMap(e => e.data?.touchedPaths || [])
  )].slice(0, 30);

  const startTs = events[0]?.ts || Date.now();
  const endTs = events[events.length - 1]?.ts || Date.now();
  const durationMin = Math.round((endTs - startTs) / 60000);

  return [
    `# Session Summary`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Session | \`${ctx.ids.sessionId}\` |`,
    `| Work Unit | \`${ctx.ids.workId}\` |`,
    `| Turns | ${ctx.ids.turnId} |`,
    `| Duration | ~${durationMin} min |`,
    `| Final Phase | ${ctx.state.core?.phase || 'UNINITIALIZED'} |`,
    ``,
    `## Tool Usage`,
    ``,
    `- **${toolCalls.length}** tool calls (${successCount} success, ${failCount} failed)`,
    `- **${denials.length}** denied/asked`,
    `- Tools used: ${toolNames.join(', ') || 'none'}`,
    ``,
    ...(errors.length > 0 ? [
      `## Errors`,
      ``,
      ...errors.map(e => `- \`${e.error?.module || 'unknown'}\`: ${e.error?.message || 'unknown error'}`),
      ``,
    ] : []),
    ...(denials.length > 0 ? [
      `## Denials / Asks`,
      ``,
      ...denials.map(e => `- \`${e.toolName}\`: ${e.reason || e.data?.reason || 'no reason'}`),
      ``,
    ] : []),
    ...(friction.length > 0 ? [
      `## Friction Points`,
      ``,
      ...friction.map(e => `- \`${e.toolName || 'unknown'}\`: ${e.data?.error || 'unknown'}`),
      ``,
    ] : []),
    ...(budgetExceeded.length > 0 ? [
      `## Budget Exceeded`,
      ``,
      ...budgetExceeded.map(e => `- Module \`${e.data?.module}\` at ${e.data?.elapsedMs}ms (budget: ${e.data?.budgetMs}ms)`),
      ``,
    ] : []),
    ...(phases.length > 0 ? [
      `## Phase Transitions`,
      ``,
      ...phases.map(e => `- ${e.data?.from || '?'} → ${e.data?.to || '?'}`),
      ``,
    ] : []),
    `## Files Touched`,
    ``,
    ...(touchedPaths.length > 0
      ? touchedPaths.map(p => `- ${p}`)
      : ['- none recorded']),
    ``,
  ].join('\n');
}

// ── ADR skeleton builder ─────────────────────────────────────────────────

function buildAdrSkeleton(ctx, events, decisions, phaseTransitions, planEvents) {
  const date = new Date().toISOString().slice(0, 10);

  return [
    `# ADR: Session ${ctx.ids.sessionId} / ${ctx.ids.workId}`,
    ``,
    `- **Date:** ${date}`,
    `- **Status:** Draft (auto-generated)`,
    `- **Session:** \`${ctx.ids.sessionId}\``,
    `- **Work Unit:** \`${ctx.ids.workId}\``,
    ``,
    `## Context`,
    ``,
    `This ADR was auto-generated from hook events recorded during the session.`,
    `It captures key decisions and plan graph interactions for review.`,
    ``,
    `## Decisions Made`,
    ``,
    ...(decisions.length > 0
      ? decisions.map(d => `- **${d.decision}** \`${d.toolName}\`: ${d.reason || 'no reason recorded'}`)
      : ['- No deny/ask decisions recorded.']),
    ``,
    ...(planEvents.length > 0 ? [
      `## Plan Graph Events`,
      ``,
      ...planEvents.map(e => `- **${e.kind}**: ${e.reason || JSON.stringify(e.data || {}).slice(0, 100)}`),
      ``,
    ] : []),
    ...(phaseTransitions.length > 0 ? [
      `## Phase Transitions`,
      ``,
      ...phaseTransitions.map(e => `- ${e.data?.from} → ${e.data?.to}`),
      ``,
    ] : []),
    `## Consequences`,
    ``,
    `<!-- Fill in: what changed as a result of these decisions? -->`,
    ``,
    `## Follow-ups`,
    ``,
    `<!-- Fill in: what should be done next? -->`,
    ``,
  ].join('\n');
}
