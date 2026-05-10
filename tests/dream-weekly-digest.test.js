// Tests for lib/dream/weekly-digest.js — last-N-days event.json digest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateWeeklyDigest, _internals } from '../lib/dream/weekly-digest.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-digest-'));
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

async function placeRun(memoryRoot, date, evt) {
  await writeFile(
    path.join(memoryRoot, 'archive', 'dreams', date, 'event.json'),
    JSON.stringify(evt, null, 2),
  );
}

const minimalEvt = (verdict = 'PASS') => ({
  schema_version: '1.0.0',
  verdict,
  routed: { patterns_reinforced: [], patterns_promoted: [], patterns_promotion_declined: [] },
  pruned: { corrections_lines_archived: 0, session_index_lines_before: 0, session_index_lines_after: 0, patterns_demoted: [] },
  contradictions_surfaced: [],
  audit: { stage_a: { verdict: 'PASS', findings: [] }, stage_b: { verdict: 'PASS', findings: [], model: 'gpt-5-codex' } },
});

test('generateWeeklyDigest: empty memory tree → "no event.json files" report', async () => {
  const dir = await tmpDir();
  const r = await generateWeeklyDigest({ memoryRoot: dir, today: '2026-05-09' });
  assert.match(r.content, /Dream-management weekly digest/);
  assert.match(r.content, /No event\.json files/);
  assert.equal(r.summary.runs, 0);
});

test('generateWeeklyDigest: 7-day window picks events in range', async () => {
  const dir = await tmpDir();
  await placeRun(dir, '2026-05-09', minimalEvt('PASS'));
  await placeRun(dir, '2026-05-08', minimalEvt('WARN'));
  await placeRun(dir, '2026-05-03', minimalEvt('PASS'));
  // Outside window
  await placeRun(dir, '2026-05-01', minimalEvt('PASS'));
  const r = await generateWeeklyDigest({ memoryRoot: dir, today: '2026-05-09' });
  assert.equal(r.summary.runs, 3);
  assert.equal(r.summary.verdicts.PASS, 2);
  assert.equal(r.summary.verdicts.WARN, 1);
});

test('generateWeeklyDigest: writes to dream-log-weekly.md by default', async () => {
  const dir = await tmpDir();
  await placeRun(dir, '2026-05-09', minimalEvt());
  const r = await generateWeeklyDigest({ memoryRoot: dir, today: '2026-05-09' });
  assert.equal(r.path, path.join(dir, 'dream-log-weekly.md'));
  const onDisk = await fs.readFile(r.path, 'utf8');
  assert.equal(onDisk, r.content);
});

test('generateWeeklyDigest: write=false skips disk', async () => {
  const dir = await tmpDir();
  await placeRun(dir, '2026-05-09', minimalEvt());
  const r = await generateWeeklyDigest({ memoryRoot: dir, today: '2026-05-09', write: false });
  assert.equal(r.path, null);
  // No file was written.
  await assert.rejects(
    () => fs.readFile(path.join(dir, 'dream-log-weekly.md'), 'utf8'),
    /ENOENT/,
  );
});

test('generateWeeklyDigest: aggregates routed counts', async () => {
  const dir = await tmpDir();
  await placeRun(dir, '2026-05-09', {
    ...minimalEvt('PASS'),
    routed: {
      patterns_reinforced: [{ pattern: 'a', sightings_after: 5 }],
      patterns_promoted: [{ slug: 'b' }],
      patterns_promotion_declined: [{ slug: 'c', reason: 'low' }],
    },
  });
  await placeRun(dir, '2026-05-08', {
    ...minimalEvt('WARN'),
    routed: {
      patterns_reinforced: [{ pattern: 'd', sightings_after: 3 }, { pattern: 'e', sightings_after: 2 }],
      patterns_promoted: [],
      patterns_promotion_declined: [],
    },
  });
  const r = await generateWeeklyDigest({ memoryRoot: dir, today: '2026-05-09' });
  assert.equal(r.summary.reinforce, 3);
  assert.equal(r.summary.promote, 1);
  assert.equal(r.summary.decline, 1);
});

test('generateWeeklyDigest: contradictions surface in pending review section', async () => {
  const dir = await tmpDir();
  await placeRun(dir, '2026-05-09', {
    ...minimalEvt('WARN'),
    run_id: '2026-05-09T03:00:00Z',
    contradictions_surfaced: [
      { description: 'Rule X violated 3x in 14d', severity: 'high' },
    ],
  });
  const r = await generateWeeklyDigest({ memoryRoot: dir, today: '2026-05-09' });
  assert.match(r.content, /Pending JJ review/);
  assert.match(r.content, /Rule X violated/);
  assert.equal(r.summary.contradictions_total, 1);
  assert.equal(r.summary.pending_contradictions.length, 1);
});

test('generateWeeklyDigest: corrupt event.json silently skipped', async () => {
  const dir = await tmpDir();
  await placeRun(dir, '2026-05-09', minimalEvt());
  await writeFile(
    path.join(dir, 'archive', 'dreams', '2026-05-08', 'event.json'),
    '{ not json',
  );
  const r = await generateWeeklyDigest({ memoryRoot: dir, today: '2026-05-09' });
  assert.equal(r.summary.runs, 1); // corrupt one skipped
});

test('generateWeeklyDigest: per-night entries include audit verdicts', async () => {
  const dir = await tmpDir();
  await placeRun(dir, '2026-05-09', {
    ...minimalEvt('PASS'),
    audit: {
      stage_a: { verdict: 'PASS', findings: [], summary: {} },
      stage_b: { verdict: 'PASS', findings: [], model: 'gpt-5-codex' },
    },
  });
  const r = await generateWeeklyDigest({ memoryRoot: dir, today: '2026-05-09' });
  assert.match(r.content, /Stage A PASS/);
  assert.match(r.content, /Stage B PASS/);
});

test('generateWeeklyDigest: rejects bad today', async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () => generateWeeklyDigest({ memoryRoot: dir, today: 'bad' }),
    /today must match YYYY-MM-DD/,
  );
});

test('lastNDates: returns descending', () => {
  const out = _internals.lastNDates('2026-05-09', 3);
  assert.deepEqual(out, ['2026-05-09', '2026-05-08', '2026-05-07']);
});

test('digest (final R5): contradiction date uses dream-pass date, not run_id', async () => {
  // Reality-checker final #5: a 3:45am wall-clock run_id is "next day" —
  // pendingContradictions[].date must come from the dream-pass date
  // (the iterating events[].date) so the per-night attribution is correct.
  const dir = await tmpDir();
  await placeRun(dir, '2026-05-09', {
    ...minimalEvt('WARN'),
    run_id: '2026-05-10T03:45:00Z', // wall clock the next day
    contradictions_surfaced: [
      { description: 'Rule X violated 2x', severity: 'medium' },
    ],
  });
  const r = await generateWeeklyDigest({ memoryRoot: dir, today: '2026-05-10' });
  assert.equal(r.summary.pending_contradictions[0].date, '2026-05-09');
  assert.notEqual(r.summary.pending_contradictions[0].date, '2026-05-10');
});

test('digest (final R6): reinforce entries with missing sightings_after render cleanly', async () => {
  // Reality-checker final #6: older event.json shapes may lack
  // sightings_after on reinforce entries. Render must not produce
  // `pattern→undefined`; fall back to bare pattern name.
  const dir = await tmpDir();
  await placeRun(dir, '2026-05-09', {
    ...minimalEvt('PASS'),
    routed: {
      patterns_reinforced: [{ pattern: 'no-after-field' }],
      patterns_promoted: [],
      patterns_promotion_declined: [],
    },
  });
  const r = await generateWeeklyDigest({ memoryRoot: dir, today: '2026-05-09' });
  assert.doesNotMatch(r.content, /undefined/);
  assert.match(r.content, /no-after-field/);
});
