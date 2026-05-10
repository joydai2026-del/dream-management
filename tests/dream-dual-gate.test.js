// Tests for lib/dream/dual-gate.js — cadence-gate decision matrix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDualGate, renderSkipLogLine, _internals } from '../lib/dream/dual-gate.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-dualgate-'));
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

async function placeRun(memoryRoot, date, verdict, runIdISO) {
  const dir = path.join(memoryRoot, 'archive', 'dreams', date);
  await fs.mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'event.json'), JSON.stringify({
    schema_version: '1.0.0',
    run_id: runIdISO || `${date}T03:00:00Z`,
    verdict,
  }));
}

async function placeSession(memoryRoot, name, daysAgo) {
  const fp = path.join(memoryRoot, 'session-logs', name);
  await writeFile(fp, '# session log\n');
  if (daysAgo > 0) {
    const t = Date.now() - daysAgo * 86_400_000;
    await fs.utimes(fp, t / 1000, t / 1000);
  }
}

// ---- checkDualGate ---------------------------------------------------

test('checkDualGate: no prior runs + 1 recent session → shouldRun=true', async () => {
  const dir = await tmpDir();
  await placeSession(dir, 'today.md', 0);
  const r = await checkDualGate({ memoryRoot: dir });
  assert.equal(r.shouldRun, true);
  assert.equal(r.gates.last_run_date, null);
  assert.equal(r.gates.sessions_in_window, 1);
});

test('checkDualGate: no sessions in 24h → shouldRun=false', async () => {
  const dir = await tmpDir();
  // Place a session, but make it 2 days old.
  await placeSession(dir, 'old.md', 2);
  const r = await checkDualGate({ memoryRoot: dir });
  assert.equal(r.shouldRun, false);
  assert.match(r.reason, /quiet day/);
});

test('checkDualGate: last run <24h ago → shouldRun=false', async () => {
  const dir = await tmpDir();
  await placeSession(dir, 'today.md', 0);
  // Place a recent successful run.
  const lastRunIso = new Date(Date.now() - 12 * 3_600_000).toISOString();
  const date = lastRunIso.slice(0, 10);
  await placeRun(dir, date, 'PASS', lastRunIso);
  const r = await checkDualGate({ memoryRoot: dir });
  assert.equal(r.shouldRun, false);
  assert.match(r.reason, /< 24h threshold/);
});

test('checkDualGate: last run 25h ago + 1 session → shouldRun=true', async () => {
  const dir = await tmpDir();
  await placeSession(dir, 'recent.md', 0);
  const lastRunIso = new Date(Date.now() - 25 * 3_600_000).toISOString();
  const date = lastRunIso.slice(0, 10);
  await placeRun(dir, date, 'PASS', lastRunIso);
  const r = await checkDualGate({ memoryRoot: dir });
  assert.equal(r.shouldRun, true);
});

test('checkDualGate: FAIL run does not satisfy "last successful run" gate', async () => {
  const dir = await tmpDir();
  await placeSession(dir, 'today.md', 0);
  // FAIL run yesterday.
  const failIso = new Date(Date.now() - 12 * 3_600_000).toISOString();
  await placeRun(dir, failIso.slice(0, 10), 'FAIL', failIso);
  const r = await checkDualGate({ memoryRoot: dir });
  // FAIL doesn't count → no last successful run → gate (a) passes.
  assert.equal(r.shouldRun, true);
  assert.equal(r.gates.last_run_date, null);
});

test('checkDualGate: WARN run DOES satisfy gate (treated as successful)', async () => {
  const dir = await tmpDir();
  await placeSession(dir, 'today.md', 0);
  const warnIso = new Date(Date.now() - 1 * 3_600_000).toISOString();
  await placeRun(dir, warnIso.slice(0, 10), 'WARN', warnIso);
  const r = await checkDualGate({ memoryRoot: dir });
  // 1h ago, threshold 24h → blocks.
  assert.equal(r.shouldRun, false);
  assert.equal(r.gates.last_run_verdict, 'WARN');
});

test('checkDualGate: PASS-TENTATIVE is NOT successful (audits incomplete)', async () => {
  const dir = await tmpDir();
  await placeSession(dir, 'today.md', 0);
  const tentIso = new Date(Date.now() - 1 * 3_600_000).toISOString();
  await placeRun(dir, tentIso.slice(0, 10), 'PASS-TENTATIVE', tentIso);
  const r = await checkDualGate({ memoryRoot: dir });
  // PASS-TENTATIVE skipped → first-run-ever path.
  assert.equal(r.shouldRun, true);
  assert.equal(r.gates.last_run_date, null);
});

test('checkDualGate: most-recent successful run picked from descending dates', async () => {
  const dir = await tmpDir();
  await placeSession(dir, 'today.md', 0);
  // Place an old PASS and a more recent FAIL. The dual-gate should pick
  // the OLD pass as last successful, ignoring the newer FAIL.
  const oldIso = new Date(Date.now() - 30 * 3_600_000).toISOString();
  await placeRun(dir, oldIso.slice(0, 10), 'PASS', oldIso);
  const newFailIso = new Date(Date.now() - 5 * 3_600_000).toISOString();
  await placeRun(dir, newFailIso.slice(0, 10), 'FAIL', newFailIso);
  const r = await checkDualGate({ memoryRoot: dir });
  assert.equal(r.shouldRun, true);
  assert.equal(r.gates.last_run_verdict, 'PASS');
  assert.ok(r.gates.hours_since_last_run >= 30);
});

test('checkDualGate: corrupt event.json is skipped (not failed)', async () => {
  const dir = await tmpDir();
  await placeSession(dir, 'today.md', 0);
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-08');
  await fs.mkdir(dreamDir, { recursive: true });
  await writeFile(path.join(dreamDir, 'event.json'), '{ not json');
  const r = await checkDualGate({ memoryRoot: dir });
  assert.equal(r.shouldRun, true); // corrupt run ignored, treated as no-prior-run
});

test('checkDualGate: rejects missing memoryRoot', async () => {
  await assert.rejects(
    () => checkDualGate({}),
    /memoryRoot required/,
  );
});

test('checkDualGate: configurable thresholds', async () => {
  const dir = await tmpDir();
  await placeSession(dir, 'today.md', 0);
  await placeSession(dir, 'today2.md', 0);
  // Lower the session-window threshold to 3 → gate (b) fails.
  const r = await checkDualGate({
    memoryRoot: dir,
    minSessionsInWindow: 3,
  });
  assert.equal(r.shouldRun, false);
  assert.match(r.reason, /< 3 threshold/);
});

test('checkDualGate: ignores non-md files in session-logs/', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'session-logs', 'note.md'), 'a');
  await writeFile(path.join(dir, 'session-logs', '.DS_Store'), 'b');
  await writeFile(path.join(dir, 'session-logs', 'other.txt'), 'c');
  const r = await checkDualGate({ memoryRoot: dir });
  assert.equal(r.gates.sessions_in_window, 1);
});

// ---- renderSkipLogLine ----------------------------------------------

test('renderSkipLogLine: produces SKIP entry for log append', () => {
  const line = renderSkipLogLine({
    today: '2026-05-09',
    gateResult: { reason: 'last successful run was 12.0h ago' },
  });
  assert.match(line, /^## 2026-05-09 03:00 SKIP — /);
  assert.match(line, /12\.0h ago/);
  assert.ok(line.endsWith('\n'));
});

test('renderSkipLogLine: tolerates missing reason', () => {
  const line = renderSkipLogLine({ today: '2026-05-09', gateResult: null });
  assert.match(line, /SKIP — unknown/);
});

// ---- internals -------------------------------------------------------

test('countRecentSessions internal: window cutoff is exclusive of older', async () => {
  const dir = await tmpDir();
  await placeSession(dir, 'old.md', 2);
  await placeSession(dir, 'recent.md', 0);
  const n = await _internals.countRecentSessions(
    dir, new Date(), _internals.DEFAULT_SESSION_WINDOW_MS,
  );
  assert.equal(n, 1);
});
