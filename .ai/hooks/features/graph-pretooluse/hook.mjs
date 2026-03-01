/**
 * graph-pretooluse — Unbounded tool-call guard
 *
 * Priority: 10
 * hotPathSafe: true   (O(1) checks only — no IO, no neo4j on hot path)
 * critical: true
 *
 * What it does:
 *   Rejects unbounded greps/searches and known-bad exploration patterns,
 *   even without a planGraph or Neo4j. Pure pattern matching — no deps.
 *
 * Dependencies: none
 *
 * To copy this feature:
 *   Copy this folder. Zero external dependencies.
 *
 * Events:
 *   PreToolUse — detect and deny/warn/rewrite unbounded tool invocations
 */

// ── Unbounded pattern definitions (O(1) checks) ─────────────────────────

const RULES = [
  // 1. grep_search without includePattern → unbounded repo scan
  (toolName, input) => {
    if (toolName !== 'grep_search') return null;
    if (!input?.includePattern) {
      return {
        decision: 'ask',
        reason: 'grep_search without includePattern scans the entire repo. Add an includePattern to scope the search (e.g., "src/app/**").',
        kind: 'UNBOUNDED_GREP_WARN',
      };
    }
    return null;
  },

  // 2. grep_search with includeIgnoredFiles → scanning node_modules etc.
  (toolName, input) => {
    if (toolName !== 'grep_search') return null;
    if (input?.includeIgnoredFiles === true) {
      return {
        decision: 'ask',
        reason: 'grep_search with includeIgnoredFiles=true will scan node_modules and build outputs. This is almost never what you want.',
        kind: 'UNBOUNDED_GREP_WARN',
      };
    }
    return null;
  },

  // 3. grep_search with very high maxResults
  (toolName, input) => {
    if (toolName !== 'grep_search') return null;
    if (typeof input?.maxResults === 'number' && input.maxResults > 500) {
      return {
        decision: 'ask',
        reason: `grep_search with maxResults=${input.maxResults} is likely unbounded exploration. Consider narrowing the query or adding includePattern.`,
        kind: 'UNBOUNDED_GREP_WARN',
      };
    }
    return null;
  },

  // 4. file_search with overly broad glob (just ** or *)
  (toolName, input) => {
    if (toolName !== 'file_search') return null;
    const q = input?.query;
    if (typeof q === 'string' && /^\*{1,2}(\.\*)?$/.test(q.trim())) {
      return {
        decision: 'ask',
        reason: `file_search with query "${q}" matches everything. Use a more specific glob pattern.`,
        kind: 'UNBOUNDED_GREP_WARN',
      };
    }
    return null;
  },

  // 5. run_in_terminal with broad find/grep commands
  (toolName, input) => {
    if (toolName !== 'run_in_terminal') return null;
    const cmd = input?.command;
    if (typeof cmd !== 'string') return null;
    if (/^\s*(find\s+\/|grep\s+(-[a-zA-Z]*r|--recursive)\s)/.test(cmd)) {
      return {
        decision: 'ask',
        reason: 'Terminal command appears to do a recursive search from root or without a bounded path. Scope it to the relevant directory.',
        kind: 'UNBOUNDED_GREP_WARN',
      };
    }
    return null;
  },
];

// ── Module ───────────────────────────────────────────────────────────────

export default {
  name: 'graph-pretooluse',
  supports: new Set(['PreToolUse']),
  priority: 10,
  hotPathSafe: true,
  critical: true,

  async handle(eventName, ctx) {
    const toolName = ctx.event.toolName;
    const toolInput = ctx.event.toolInput;

    if (!toolName) return {};

    for (const rule of RULES) {
      const result = rule(toolName, toolInput, ctx);
      if (result) {
        const event = {
          ts: Date.now(),
          event: 'PreToolUse',
          producer: 'graph-pretooluse',
          kind: result.kind || 'UNBOUNDED_GREP_WARN',
          hookRunId: ctx.ids.hookRunId,
          turnId: ctx.ids.turnId,
          workId: ctx.ids.workId,
          toolName,
          decision: result.decision,
          reason: result.reason,
        };

        return {
          decision: result.decision,
          denyReason: result.reason,
          emitEvents: [event],
          warnings: [result.reason],
        };
      }
    }

    return { decision: 'allow' };
  },
};
