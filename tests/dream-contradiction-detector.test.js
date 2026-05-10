// Tests for lib/dream/contradiction-detector.js — wraps recurrentViolations
// from firing-log-read into the dream-worker contradiction shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContradictions, _internals } from '../lib/dream/contradiction-detector.js';

function makeFiringEntries(rows) {
  // Build entries shaped like firing-log-read.parseEntryYaml output.
  return rows.map(r => ({
    session: r.session,
    firings: r.firings || [],
  }));
}

test('detectContradictions: empty input → no contradictions', () => {
  const r = detectContradictions({ firingEntries: [] });
  assert.deepEqual(r.contradictions, []);
  assert.equal(r.summary.recurrent_count, 0);
});

test('detectContradictions: single violation does NOT meet minCount', () => {
  const entries = makeFiringEntries([
    { session: '2026-05-09-1', firings: [{ pattern: 'caveman', outcome: 'violated' }] },
  ]);
  const r = detectContradictions({ firingEntries: entries, now: new Date('2026-05-09T12:00:00Z') });
  assert.deepEqual(r.contradictions, []);
});

test('detectContradictions: two violations of same pattern → contradiction', () => {
  const entries = makeFiringEntries([
    { session: '2026-05-08-1', firings: [{ pattern: 'caveman', outcome: 'violated', evidence: 'log line A' }] },
    { session: '2026-05-09-1', firings: [{ pattern: 'caveman', outcome: 'violated', evidence: 'log line B' }] },
  ]);
  const r = detectContradictions({ firingEntries: entries, now: new Date('2026-05-09T12:00:00Z') });
  assert.equal(r.contradictions.length, 1);
  assert.match(r.contradictions[0].description, /caveman/);
  assert.equal(r.contradictions[0].count, 2);
  assert.deepEqual(r.contradictions[0].file_paths, [
    'patterns/active/caveman.md', 'pattern-firing-log.md',
  ]);
  assert.equal(r.contradictions[0].decision, 'JJ to resolve next morning');
  assert.equal(r.contradictions[0].source, 'firing_log_recurrent_violations');
});

test('detectContradictions: severity scales with count', () => {
  const entries = makeFiringEntries([
    { session: '2026-05-05-1', firings: [{ pattern: 'caveman', outcome: 'violated' }] },
    { session: '2026-05-06-1', firings: [{ pattern: 'caveman', outcome: 'violated' }] },
    { session: '2026-05-07-1', firings: [{ pattern: 'caveman', outcome: 'violated' }] },
    { session: '2026-05-08-1', firings: [{ pattern: 'caveman', outcome: 'violated' }] },
    { session: '2026-05-09-1', firings: [{ pattern: 'caveman', outcome: 'violated' }] },
  ]);
  const r = detectContradictions({ firingEntries: entries, now: new Date('2026-05-09T12:00:00Z') });
  assert.equal(r.contradictions[0].count, 5);
  assert.equal(r.contradictions[0].severity, 'high');
});

test('detectContradictions: violations OUTSIDE 14-day window ignored', () => {
  const entries = makeFiringEntries([
    { session: '2026-04-01-1', firings: [{ pattern: 'caveman', outcome: 'violated' }] },
    { session: '2026-04-02-1', firings: [{ pattern: 'caveman', outcome: 'violated' }] },
  ]);
  const r = detectContradictions({ firingEntries: entries, now: new Date('2026-05-09T12:00:00Z') });
  assert.deepEqual(r.contradictions, []);
});

test('detectContradictions: applied/referenced outcomes not counted (only "violated")', () => {
  const entries = makeFiringEntries([
    { session: '2026-05-08-1', firings: [
      { pattern: 'caveman', outcome: 'applied' },
      { pattern: 'caveman', outcome: 'referenced' },
    ] },
    { session: '2026-05-09-1', firings: [
      { pattern: 'caveman', outcome: 'applied' },
    ] },
  ]);
  const r = detectContradictions({ firingEntries: entries, now: new Date('2026-05-09T12:00:00Z') });
  assert.deepEqual(r.contradictions, []);
});

test('detectContradictions: evidence captured, capped at 3 examples', () => {
  const entries = makeFiringEntries([
    { session: '2026-05-05-1', firings: [{ pattern: 'caveman', outcome: 'violated', evidence: 'a' }] },
    { session: '2026-05-06-1', firings: [{ pattern: 'caveman', outcome: 'violated', evidence: 'b' }] },
    { session: '2026-05-07-1', firings: [{ pattern: 'caveman', outcome: 'violated', evidence: 'c' }] },
    { session: '2026-05-08-1', firings: [{ pattern: 'caveman', outcome: 'violated', evidence: 'd' }] },
    { session: '2026-05-09-1', firings: [{ pattern: 'caveman', outcome: 'violated', evidence: 'e' }] },
  ]);
  const r = detectContradictions({ firingEntries: entries, now: new Date('2026-05-09T12:00:00Z') });
  assert.equal(r.contradictions[0].evidence.length, 3);
});

test('detectContradictions: configurable thresholds', () => {
  const entries = makeFiringEntries([
    { session: '2026-05-09-1', firings: [{ pattern: 'caveman', outcome: 'violated' }] },
  ]);
  const r = detectContradictions({
    firingEntries: entries,
    now: new Date('2026-05-09T12:00:00Z'),
    minViolationCount: 1,
  });
  assert.equal(r.contradictions.length, 1);
});

test('detectContradictions: multiple distinct patterns produce separate contradictions', () => {
  const entries = makeFiringEntries([
    { session: '2026-05-08-1', firings: [
      { pattern: 'caveman', outcome: 'violated' },
      { pattern: 'parallelization', outcome: 'violated' },
    ] },
    { session: '2026-05-09-1', firings: [
      { pattern: 'caveman', outcome: 'violated' },
      { pattern: 'parallelization', outcome: 'violated' },
    ] },
  ]);
  const r = detectContradictions({ firingEntries: entries, now: new Date('2026-05-09T12:00:00Z') });
  assert.equal(r.contradictions.length, 2);
  const patterns = r.contradictions.map(c => c.file_paths[0]).sort();
  assert.deepEqual(patterns, ['patterns/active/caveman.md', 'patterns/active/parallelization.md']);
});
