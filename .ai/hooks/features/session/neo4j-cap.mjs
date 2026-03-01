/**
 * Neo4j capability check — bundled with session feature.
 *
 * Never imported on PreToolUse hot path with compute=true.
 * Returns cached data there.
 *
 * CONTRACT §11:
 *   - If lastCheckTs < 5 min ago → return cached
 *   - If allowCompute=false → return cached or unavailable
 *   - Otherwise → probe bolt connection, return result + statePatch
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FIVE_MIN_MS = 5 * 60 * 1000;

const UNAVAILABLE = Object.freeze({
  enabled: false,
  reachable: false,
  schemaVersion: '',
  lastCheckTs: 0,
});

function loadNeo4jConfig(configPath) {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg?.neo4j?.uri && cfg?.neo4j?.username && cfg?.neo4j?.password) {
      return cfg.neo4j;
    }
  } catch { /* missing or bad config */ }
  return null;
}

async function probe(cfg) {
  try {
    const neo4j = await import('neo4j-driver');
    const driver = neo4j.default.driver(
      cfg.uri,
      neo4j.default.auth.basic(cfg.username, cfg.password),
    );
    const session = driver.session({ database: cfg.database || 'neo4j' });
    try {
      const res = await session.run(
        'CALL dbms.components() YIELD versions RETURN versions[0] AS v',
      );
      const ver = res.records[0]?.get('v') ?? 'unknown';
      return { reachable: true, schemaVersion: String(ver) };
    } finally {
      await session.close();
      await driver.close();
    }
  } catch {
    return { reachable: false, schemaVersion: '' };
  }
}

/**
 * @param {object} ctx
 * @param {{ allowCompute?: boolean }} options
 * @returns {Promise<{ cap: object, statePatch: object|null }>}
 */
export async function neo4jCapability(ctx, { allowCompute = false } = {}) {
  const cached = ctx.state?.cap?.neo4j;

  if (cached && cached.lastCheckTs && (Date.now() - cached.lastCheckTs < FIVE_MIN_MS)) {
    return { cap: cached, statePatch: null };
  }

  if (!allowCompute) {
    return { cap: cached ?? UNAVAILABLE, statePatch: null };
  }

  const cfg = loadNeo4jConfig(ctx.paths.configFile);
  if (!cfg) {
    const cap = { ...UNAVAILABLE, lastCheckTs: Date.now() };
    return { cap, statePatch: { cap: { neo4j: cap } } };
  }

  const { reachable, schemaVersion } = await probe(cfg);
  const cap = {
    enabled: true,
    reachable,
    schemaVersion,
    lastCheckTs: Date.now(),
  };
  return { cap, statePatch: { cap: { neo4j: cap } } };
}
