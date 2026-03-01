/**
 * .ai/hooks/lib/paths.mjs
 *
 * Single source of truth for every path in the hook system.
 * Reads layout from workspace.json so modules never construct paths themselves.
 *
 * Layout (per workspace.json v2):
 *   .ai/tmp/<sid>/                        sessionRoot
 *   .ai/tmp/<sid>/state.json              shared session state
 *   .ai/tmp/<sid>/events.jsonl            append-only event log
 *   .ai/tmp/<sid>/registry.jsonl          artifact registry
 *   .ai/tmp/<sid>/<feature>/logs/         per-feature debug logs
 *   .ai/tmp/<sid>/<feature>/output/       per-feature outputs/artifacts
 */

import { resolve, join, relative } from 'node:path';
import { readFileSync } from 'node:fs';

// ── Repo root (3 levels up from .ai/hooks/lib/) ─────────────────────────
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

// ── Defaults ─────────────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  version: 2,
  workRoot: '.ai/tmp',
  session: {
    stateFile:    'state.json',
    eventsFile:   'events.jsonl',
    registryFile: 'registry.jsonl',
  },
  feature: {
    logsDir:   'logs',
    outputDir: 'output',
  },
  hooks: {
    configFile:        'config.json',
    policyFile:        'rlm-policy.json',
    followupRulesFile: 'followup-rules.json',
    manifestFile:      'dispatch.manifest.json',
    schemaDir:         'schema',
  },
});

function mergeDefaults(ws) {
  return {
    version:  ws.version  ?? DEFAULTS.version,
    workRoot: ws.workRoot ?? DEFAULTS.workRoot,
    session:  { ...DEFAULTS.session,  ...ws.session },
    feature:  { ...DEFAULTS.feature,  ...ws.feature },
    hooks:    { ...DEFAULTS.hooks,    ...ws.hooks },
  };
}

// ── Workspace loader ─────────────────────────────────────────────────────

let _cached = null;

/**
 * Load and cache workspace.json. Returns merged config with defaults.
 * Safe to call multiple times — reads file once per process.
 */
export function loadWorkspace() {
  if (_cached) return _cached;
  const wsPath = resolve(REPO_ROOT, '.ai', 'hooks', 'workspace.json');
  try {
    _cached = mergeDefaults(JSON.parse(readFileSync(wsPath, 'utf-8')));
  } catch {
    _cached = mergeDefaults({});
  }
  return _cached;
}

// ── Standalone helpers (no sid needed) ───────────────────────────────────

/** Absolute path to the work root (parent of all session dirs). */
export function getWorkRoot(ws) {
  return resolve(REPO_ROOT, ws.workRoot);
}

/** Absolute path to the hooks configuration directory. */
export function getHooksRoot() {
  return resolve(REPO_ROOT, '.ai', 'hooks');
}

/** Resolved paths to all hook config files. */
export function getHooksConfig(ws) {
  const hr = getHooksRoot();
  return {
    configFile:        join(hr, ws.hooks.configFile),
    policyFile:        join(hr, ws.hooks.policyFile),
    followupRulesFile: join(hr, ws.hooks.followupRulesFile),
    manifestFile:      join(hr, ws.hooks.manifestFile),
    schemaDir:         join(hr, ws.hooks.schemaDir),
  };
}

// ── Path builder ─────────────────────────────────────────────────────────

/**
 * Build all canonical paths for a session.
 *
 * @param {object} ws  - Workspace config (from loadWorkspace())
 * @param {string} sid - 8-hex sessionId
 * @returns {object}    Complete path set.
 */
export function buildPaths(ws, sid) {
  const hooksRoot   = getHooksRoot();
  const workRoot    = getWorkRoot(ws);
  const sessionRoot = resolve(workRoot, sid);
  const hooksConfig = getHooksConfig(ws);

  return {
    // ── Roots ──────────────────────────────────────────────────────
    repoRoot:    REPO_ROOT,
    hooksRoot,
    workRoot,
    sessionRoot,

    // ── Session-level files (shared across all features) ───────────
    stateFile:    join(sessionRoot, ws.session.stateFile),
    eventsFile:   join(sessionRoot, ws.session.eventsFile),
    registryFile: join(sessionRoot, ws.session.registryFile),

    // ── Per-feature path builders ──────────────────────────────────
    /** @param {string} slug - feature module name */
    featureRoot:   (slug) => join(sessionRoot, slug),
    featureLogs:   (slug) => join(sessionRoot, slug, ws.feature.logsDir),
    featureOutput: (slug) => join(sessionRoot, slug, ws.feature.outputDir),

    // ── Hook config files ──────────────────────────────────────────
    ...hooksConfig,

    // ── Relative ref from sessionRoot (for registry entries) ───────
    relRef(absPath) {
      return relative(sessionRoot, absPath).replace(/\\/g, '/');
    },

    // ── Relative ref from repoRoot (for agent-facing metadata) ─────
    repoRelative(absPath) {
      return relative(REPO_ROOT, absPath).replace(/\\/g, '/');
    },
  };
}

export { REPO_ROOT };
