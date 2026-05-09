import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRePromote,
  validateDemotionPhase,
  _internals,
} from '../lib/dream/bootstrap-guard.js';

// (1) re-promotion guard

test('canRePromote: non-bootstrap files pass through unconditionally', () => {
  const r = canRePromote({ identifier: 'foo' }, { passes: false });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresFlagClear, false);
});

test('canRePromote: bootstrap:true with failing evidence is rejected', () => {
  const r = canRePromote(
    { bootstrap: true },
    { passes: false, weightedEvidence: 1.5, threshold: 3.0 },
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason, /weighted=1\.5/);
  assert.match(r.reason, /threshold=3/);
});

test('canRePromote: bootstrap:true with no evidence object is rejected', () => {
  const r = canRePromote({ bootstrap: true }, null);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /weighted=n\/a/);
});

test('canRePromote: bootstrap:true with passing evidence allows + flags clear-required', () => {
  const r = canRePromote(
    { bootstrap: true },
    { passes: true, weightedEvidence: 4.0, threshold: 3.0 },
  );
  assert.equal(r.allowed, true);
  assert.equal(r.requiresFlagClear, true);
  // Per ADR 008 Consequences §, re-promotion clears BOTH bootstrap AND
  // demotion_phase tags (the file is no longer a one-time-cleanup artifact).
  assert.deepEqual(r.flagsToClear, ['bootstrap', 'demotion_phase']);
});

test('canRePromote: non-bootstrap pass-through has empty flagsToClear', () => {
  const r = canRePromote({ identifier: 'foo' }, { passes: true });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.flagsToClear, []);
});

test('canRePromote: bootstrap:true with failing evidence has empty flagsToClear', () => {
  const r = canRePromote({ bootstrap: true }, { passes: false, weightedEvidence: 1, threshold: 3 });
  assert.equal(r.allowed, false);
  assert.deepEqual(r.flagsToClear, []);
});

// (2) + (3) demotion-phase guard

test('validateDemotionPhase: rejects the frozen p3-2026-05-09 historical marker', () => {
  const r = validateDemotionPhase('p3-2026-05-09', '2026-06-15');
  assert.equal(r.allowed, false);
  assert.equal(r.suggested, 'p3-2026-06-15');
  assert.match(r.reason, /frozen/);
});

test('validateDemotionPhase: rejects malformed phase strings', () => {
  const cases = ['p3-cleanup', 'cleanup-p3-2026-05-20', 'p3-26-05-20', '', null];
  for (const v of cases) {
    const r = validateDemotionPhase(v, '2026-06-15');
    assert.equal(r.allowed, false, `expected reject on ${v}`);
    assert.equal(r.suggested, 'p3-2026-06-15');
  }
});

test('validateDemotionPhase: accepts well-formed past-dated phases (backlog cleanup)', () => {
  // Per ADR 008 spirit: the rule is that each cleanup uses a NEW
  // demotion_phase, not that the date must equal currentDate. A worker
  // batching a queued cleanup may legitimately write a past date.
  const r = validateDemotionPhase('p3-2026-05-20', '2026-06-15');
  assert.equal(r.allowed, true);
});

test('validateDemotionPhase: accepts well-formed future-dated phases (loose semantics)', () => {
  const r = validateDemotionPhase('p3-2026-12-31', '2026-06-15');
  assert.equal(r.allowed, true);
});

test('validateDemotionPhase: accepts well-formed phase tag for the current run', () => {
  const r = validateDemotionPhase('p3-2026-06-15', '2026-06-15');
  assert.equal(r.allowed, true);
});

test('frozen set contains the canonical 2026-05-09 marker', () => {
  assert.ok(_internals.FROZEN_DEMOTION_PHASES.has('p3-2026-05-09'));
});

test('FLAGS_TO_CLEAR_ON_REPROMOTE matches ADR 008 Consequences §', () => {
  assert.deepEqual(_internals.FLAGS_TO_CLEAR_ON_REPROMOTE, ['bootstrap', 'demotion_phase']);
});
