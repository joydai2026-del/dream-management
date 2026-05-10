// Tests for lib/dream/heuristic-eval.js — calibration harness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalHeuristic, _internals } from '../lib/dream/heuristic-eval.js';

const fixture = (label, bucket, text, expected_band) => ({
  insight: { label, bucket, text },
  expected_band,
});

test('evalHeuristic: empty fixtures → zero distribution', () => {
  const r = evalHeuristic({ fixtures: [] });
  assert.equal(r.total, 0);
  assert.equal(r.calibration.hit_rate, 0);
});

test('evalHeuristic: distribution sums to fixture count', () => {
  const fxs = [
    fixture('a', 'mistake', 'simple typo cleanup', 'low'),
    fixture('b', 'correction', 'JJ said critical regression', 'high'),
    fixture('c', 'correction', 'JJ told me to redo Phase 4', 'high'),
  ];
  const r = evalHeuristic({ fixtures: fxs });
  assert.equal(r.total, 3);
  const sum = Object.values(r.distribution).reduce((s, n) => s + n, 0);
  assert.equal(sum, 3);
});

test('evalHeuristic: band hits / misses tallied', () => {
  const fxs = [
    fixture('a', 'mistake', 'critical production crash JJ corrected', 'high'),
    fixture('b', 'other', 'quick typo nit', 'low'),
  ];
  const r = evalHeuristic({ fixtures: fxs });
  assert.ok(r.band_hits.high >= 1);
});

test('evalHeuristic: per-bucket stats include mean + stddev', () => {
  const fxs = [
    fixture('a', 'correction', 'JJ said something', 'high'),
    fixture('b', 'correction', 'JJ corrected something', 'high'),
    fixture('c', 'mistake', 'small mistake', 'mid'),
  ];
  const r = evalHeuristic({ fixtures: fxs });
  assert.ok(r.per_bucket.correction);
  assert.equal(r.per_bucket.correction.count, 2);
  assert.ok(typeof r.per_bucket.correction.mean === 'number');
  assert.ok(typeof r.per_bucket.correction.stddev === 'number');
  assert.equal(r.per_bucket.mistake.count, 1);
});

test('evalHeuristic: drift detection — all "high" miss below high band', () => {
  // Construct fixtures where heuristic under-scores. The heuristic gives
  // base 4 to bucket=other, so a fixture labeled high but text is plain
  // should miss to low or mid.
  const fxs = [
    fixture('a', 'other', 'plain text, no signal words', 'high'),
    fixture('b', 'other', 'plain text two', 'high'),
  ];
  const r = evalHeuristic({ fixtures: fxs });
  assert.equal(r.calibration.drift_detected, true);
  assert.ok(r.calibration.notes.some(n => /under-scores severity/.test(n)));
});

test('evalHeuristic: hit_rate computed only over labeled fixtures', () => {
  const fxs = [
    fixture('a', 'correction', 'JJ critical regression', 'high'),
    { insight: { bucket: 'mistake', text: 'unlabelled' } }, // no expected_band
  ];
  const r = evalHeuristic({ fixtures: fxs });
  // band_hits.none counts unlabeled fixtures.
  assert.equal(r.band_hits.none, 1);
  // hit_rate denominator = labelled (1) only.
  assert.ok(r.calibration.hit_rate >= 0 && r.calibration.hit_rate <= 1);
});

test('evalHeuristic: report contains markdown distribution + sections', () => {
  const r = evalHeuristic({ fixtures: [
    fixture('a', 'correction', 'JJ said critical', 'high'),
  ] });
  assert.match(r.report, /^# Heuristic Scorer Calibration/m);
  assert.match(r.report, /## Score distribution/);
  assert.match(r.report, /## Per-bucket statistics/);
});

test('evalHeuristic: rejects non-array fixtures', () => {
  assert.throws(
    () => evalHeuristic({ fixtures: null }),
    /must be an array/,
  );
});

test('scoreToBand: boundaries', () => {
  assert.equal(_internals.scoreToBand(1), 'low');
  assert.equal(_internals.scoreToBand(4), 'low');
  assert.equal(_internals.scoreToBand(5), 'mid');
  assert.equal(_internals.scoreToBand(7), 'mid');
  assert.equal(_internals.scoreToBand(8), 'high');
  assert.equal(_internals.scoreToBand(10), 'high');
});

test('evalHeuristic: custom scorer injection', () => {
  const fakeScorer = () => ({ score: 9, rationale: 'forced' });
  const r = evalHeuristic({
    fixtures: [
      fixture('a', 'other', 'anything', 'high'),
      fixture('b', 'other', 'anything', 'low'),
    ],
    scorer: fakeScorer,
  });
  assert.equal(r.distribution['9'], 2);
  assert.equal(r.distribution['1'], 0);
});
