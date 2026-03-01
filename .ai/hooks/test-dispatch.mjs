#!/usr/bin/env node
/**
 * .ai/hooks/test-dispatch.mjs — Dry-run test harness
 *
 * Tests each event type by piping synthetic stdin to dispatch.mjs
 * and validating the stdout JSON.
 *
 * Usage:  node .ai/hooks/test-dispatch.mjs
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { rmSync, existsSync, readFileSync } from 'node:fs';

const DISPATCH = resolve(import.meta.dirname, 'dispatch.mjs');
const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

// Clean up any previous test session dirs matching test pattern
const testWorkDir = resolve(REPO_ROOT, '.ai', 'tmp', 'w');

let passed = 0;
let failed = 0;

function test(name, eventName, stdinObj, assertions) {
  try {
    const input = JSON.stringify(stdinObj);
    const result = execFileSync('node', [DISPATCH, eventName], {
      input,
      encoding: 'utf-8',
      timeout: 10000,
      cwd: REPO_ROOT,
      env: { ...process.env, COPILOT_SESSION_ID: 'deadbeef' },
    });

    let output;
    try {
      output = JSON.parse(result);
    } catch (e) {
      console.error(`  FAIL [${name}]: stdout not valid JSON`);
      console.error(`  raw: ${result.slice(0, 500)}`);
      failed++;
      return;
    }

    // Run assertions
    for (const [check, fn] of Object.entries(assertions)) {
      if (!fn(output)) {
        console.error(`  FAIL [${name}] assertion "${check}": ${JSON.stringify(output, null, 2).slice(0, 500)}`);
        failed++;
        return;
      }
    }

    console.log(`  PASS [${name}]`);
    passed++;
    return output;
  } catch (err) {
    console.error(`  FAIL [${name}]: ${err.message}`);
    if (err.stderr) console.error(`  stderr: ${err.stderr.toString().slice(0, 300)}`);
    failed++;
  }
}

console.log('\n── Hook Dispatcher Dry-Run Tests ────────────────────\n');

// 1. SessionStart
test('SessionStart', 'SessionStart', { event: 'SessionStart' }, {
  'has _debug': (o) => !!o._debug,
  'modulesRan includes session': (o) => o._debug?.modulesRan?.includes('session'),
  'has additionalContext': (o) => Array.isArray(o.additionalContext) && o.additionalContext.length > 0,
});

// 2. UserPromptSubmit
test('UserPromptSubmit', 'UserPromptSubmit', {
  event: 'UserPromptSubmit',
  prompt: 'Show me the home component',
  transcript_path: '/fake/transcript',
}, {
  'has _debug': (o) => !!o._debug,
  'modulesRan includes session': (o) => o._debug?.modulesRan?.includes('session'),
  'modulesRan includes memory-journal': (o) => o._debug?.modulesRan?.includes('memory-journal'),
});

// 3. PreToolUse — normal allowed tool
test('PreToolUse-allow', 'PreToolUse', {
  event: 'PreToolUse',
  toolName: 'read_file',
  toolInput: { filePath: 'src/app/app.component.ts', startLine: 1, endLine: 50 },
}, {
  'decision is allow': (o) => o.decision === 'allow',
  'modulesRan includes all PreToolUse modules': (o) => {
    const ran = o._debug?.modulesRan || [];
    return ran.includes('session') && ran.includes('graph-pretooluse')
      && ran.includes('planGraph-exec') && ran.includes('rlm-work')
      && ran.includes('memory-activation');
  },
});

// 4. PreToolUse — unbounded grep (should warn/ask)
test('PreToolUse-unbounded-grep', 'PreToolUse', {
  event: 'PreToolUse',
  toolName: 'grep_search',
  toolInput: { query: 'TODO', isRegexp: false },
}, {
  'decision is ask': (o) => o.decision === 'ask',
  'has warnings': (o) => Array.isArray(o.warnings) && o.warnings.length > 0,
  'warning mentions includePattern': (o) => o.warnings?.some(w => w.includes('includePattern')),
});

// 5. PreToolUse — scoped grep (should allow)
test('PreToolUse-scoped-grep', 'PreToolUse', {
  event: 'PreToolUse',
  toolName: 'grep_search',
  toolInput: { query: 'TODO', isRegexp: false, includePattern: 'src/app/**' },
}, {
  'decision is allow': (o) => o.decision === 'allow',
});

// 6. PostToolUse
test('PostToolUse', 'PostToolUse', {
  event: 'PostToolUse',
  toolName: 'read_file',
  toolInput: { filePath: 'src/app/app.component.ts' },
  toolOutput: 'file contents...',
}, {
  'has _debug': (o) => !!o._debug,
  'modulesRan includes session': (o) => o._debug?.modulesRan?.includes('session'),
  'modulesRan includes memory-journal': (o) => o._debug?.modulesRan?.includes('memory-journal'),
  'modulesRan includes memory-activation': (o) => o._debug?.modulesRan?.includes('memory-activation'),
});

// 7. PreCompact
test('PreCompact', 'PreCompact', {
  event: 'PreCompact',
  compactSummary: 'Summary of conversation...',
}, {
  'has _debug': (o) => !!o._debug,
  'has additionalContext': (o) => Array.isArray(o.additionalContext) && o.additionalContext.length > 0,
});

// 8. Stop
test('Stop', 'Stop', { event: 'Stop' }, {
  'has _debug': (o) => !!o._debug,
  'modulesRan includes session': (o) => o._debug?.modulesRan?.includes('session'),
  'modulesRan includes memory-journal': (o) => o._debug?.modulesRan?.includes('memory-journal'),
  'modulesRan includes stop-synth': (o) => o._debug?.modulesRan?.includes('stop-synth'),
});

// 10. SubagentStart — Plan subagent
test('SubagentStart-Plan', 'SubagentStart', {
  event: 'SubagentStart',
  subagentType: 'Plan',
  subagentId: 'a01',
}, {
  'has _debug': (o) => !!o._debug,
  'modulesRan includes plan-subagent-contract': (o) => o._debug?.modulesRan?.includes('plan-subagent-contract'),
  'modulesRan includes rlm-work': (o) => o._debug?.modulesRan?.includes('rlm-work'),
  'has additionalContext': (o) => Array.isArray(o.additionalContext) && o.additionalContext.length > 0,
});

// 11. SubagentStop — Plan subagent (no artifacts to harvest, just runs)
test('SubagentStop-Plan', 'SubagentStop', {
  event: 'SubagentStop',
  subagentType: 'Plan',
  subagentId: 'a01',
}, {
  'has _debug': (o) => !!o._debug,
  'modulesRan includes plan-subagent-contract': (o) => o._debug?.modulesRan?.includes('plan-subagent-contract'),
  'modulesRan includes rlm-work': (o) => o._debug?.modulesRan?.includes('rlm-work'),
});

// 9. Invalid event — should fail open
test('Invalid event', 'BogusEvent', {}, {
  'has warnings': (o) => Array.isArray(o.warnings) && o.warnings.length > 0,
});

// ── Lifecycle integration test ──────────────────────────────────────────
// Simulates a full session: start → prompt → read (planning) → write (→ executing) → stop (→ complete)
// Validates state persists across separate process invocations.

console.log('\n── Lifecycle Integration Test ───────────────────────\n');

{
  const SID = 'e2e00001';
  const sessionDir = resolve(REPO_ROOT, '.ai', 'tmp', 'w', SID);

  // Clean slate
  if (existsSync(sessionDir)) {
    rmSync(sessionDir, { recursive: true, force: true });
  }

  const run = (eventName, stdinObj) => {
    const result = execFileSync('node', [DISPATCH, eventName], {
      input: JSON.stringify(stdinObj),
      encoding: 'utf-8',
      timeout: 10000,
      cwd: REPO_ROOT,
      env: { ...process.env, COPILOT_SESSION_ID: SID },
    });
    return JSON.parse(result);
  };

  let allOk = true;
  const check = (label, ok) => {
    if (!ok) {
      console.error(`  FAIL [lifecycle] ${label}`);
      allOk = false;
    }
  };

  // Step 1: SessionStart → UNINITIALIZED
  const r1 = run('SessionStart', { event: 'SessionStart' });
  check('SessionStart returns additionalContext', r1.additionalContext?.length > 0);

  // Verify s.json exists with UNINITIALIZED phase
  const stateFile = resolve(sessionDir, 's.json');
  check('state file created', existsSync(stateFile));
  let state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  check('phase is UNINITIALIZED', state.core?.phase === 'UNINITIALIZED');

  // Step 2: UserPromptSubmit → PLANNING
  run('UserPromptSubmit', {
    event: 'UserPromptSubmit',
    prompt: 'Refactor the home component',
    transcript_path: '/fake',
  });
  state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  check('phase is PLANNING after prompt', state.core?.phase === 'PLANNING');
  check('turnId is 1', state.core?.lastTurnId === 1);

  // Step 3: PreToolUse with read_file (non-mutating) → stays PLANNING
  run('PreToolUse', {
    event: 'PreToolUse',
    toolName: 'read_file',
    toolInput: { filePath: 'src/app/home/home.component.ts', startLine: 1, endLine: 50 },
  });
  state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  check('phase stays PLANNING after read_file', state.core?.phase === 'PLANNING');

  // Step 4: PreToolUse with create_file (mutating) → EXECUTING
  run('PreToolUse', {
    event: 'PreToolUse',
    toolName: 'create_file',
    toolInput: { filePath: 'src/app/home/home.component.new.ts', content: '// new' },
  });
  state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  check('phase is EXECUTING after create_file', state.core?.phase === 'EXECUTING');

  // Step 5: PostToolUse → stays EXECUTING
  run('PostToolUse', {
    event: 'PostToolUse',
    toolName: 'create_file',
    toolInput: { filePath: 'src/app/home/home.component.new.ts' },
    toolOutput: 'created',
  });
  state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  check('phase stays EXECUTING after PostToolUse', state.core?.phase === 'EXECUTING');

  // Step 6: Stop → COMPLETE
  run('Stop', { event: 'Stop' });
  state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  check('phase is COMPLETE after Stop', state.core?.phase === 'COMPLETE');

  // Step 7: Verify event log has entries
  const eventsFile = resolve(sessionDir, 'e.jsonl');
  check('events file exists', existsSync(eventsFile));
  const events = readFileSync(eventsFile, 'utf-8').trim().split('\n').filter(Boolean);
  check('event log has >= 6 entries', events.length >= 6);

  // Verify phase transitions are in the log
  const phaseEvents = events
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e?.kind === 'PHASE_TRANSITION');
  check('has UNINITIALIZED→PLANNING transition', phaseEvents.some(e => e.data?.from === 'UNINITIALIZED' && e.data?.to === 'PLANNING'));
  check('has PLANNING→EXECUTING transition', phaseEvents.some(e => e.data?.from === 'PLANNING' && e.data?.to === 'EXECUTING'));
  check('has EXECUTING→COMPLETE transition', phaseEvents.some(e => e.data?.from === 'EXECUTING' && e.data?.to === 'COMPLETE'));

  if (allOk) {
    console.log('  PASS [lifecycle] Full session: UNINITIALIZED → PLANNING → EXECUTING → COMPLETE');
    passed++;
  } else {
    failed++;
  }

  // Clean up
  rmSync(sessionDir, { recursive: true, force: true });
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
process.exit(failed > 0 ? 1 : 0);
