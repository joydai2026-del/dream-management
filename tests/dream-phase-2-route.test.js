import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify,
  insightMentionsPattern,
  planReinforcements,
  applyPromotionGates,
  runRoute,
} from '../lib/dream/phase-2-route.js';

function makeScoredInsight(text, score, opts = {}) {
  return {
    insight: {
      id: opts.id || `x-${score}`,
      source: opts.source || 'journal',
      bucket: opts.bucket || 'correction',
      text,
      date: '2026-05-10',
      evidence: { path: opts.path || 'learning-journals/2026-05-10.md', lineNumber: opts.line || 1 },
    },
    score,
    rationale: opts.rationale || 'fixture',
  };
}

test('slugify produces stable kebab-case identifiers', () => {
  assert.equal(slugify('External DOM Drift — LLM Default'), 'external-dom-drift-llm-default');
  assert.equal(slugify('  multi  word  '), 'multi-word');
  assert.equal(slugify(null), '');
});

test('insightMentionsPattern matches identifier substring', () => {
  const pat = { name: 'external-dom-drift-llm-default', identifierStem: 'external-dom-drift-llm-default' };
  const ins = { text: 'we triggered external-dom-drift-llm-default again' };
  assert.equal(insightMentionsPattern(ins, pat), true);
});

test('insightMentionsPattern matches trigger phrase', () => {
  const pat = {
    name: 'external-dom-drift-llm-default',
    identifierStem: 'external-dom-drift-llm-default',
    triggerPhrases: ['selector miss', 'DOM drift'],
  };
  assert.equal(insightMentionsPattern({ text: 'TuneCore had a Selector Miss again' }, pat), true);
  assert.equal(insightMentionsPattern({ text: 'unrelated text' }, pat), false);
});

test('planReinforcements bumps once per pattern with multiple supporting insights', () => {
  const pats = [
    { name: 'caveman-check', identifierStem: 'caveman-check', triggerPhrases: ['caveman check'], sightings: 11 },
  ];
  const insights = [
    makeScoredInsight('caveman check failed today', 8, { id: 'a' }),
    makeScoredInsight('another caveman-check violation', 9, { id: 'b' }),
    makeScoredInsight('unrelated text', 8, { id: 'c' }),
  ];
  const { reinforce, reinforcementDecisions } = planReinforcements(insights, pats, { today: '2026-05-10' });
  assert.equal(reinforce.length, 1);
  assert.equal(reinforce[0].pattern, 'caveman-check');
  assert.equal(reinforce[0].sightingsBefore, 11);
  assert.equal(reinforce[0].sightingsAfter, 12);
  assert.equal(reinforce[0].evidence.length, 2);
  assert.equal(reinforce[0].latestSeen, '2026-05-10');
  assert.equal(reinforcementDecisions.find(d => d.insightId === 'c').decision, 'no-match');
});

test('planReinforcements drops insights below minImportance', () => {
  const pats = [{ name: 'x', identifierStem: 'x', sightings: 0 }];
  const insights = [makeScoredInsight('mentions x but boring', 5)];
  const { reinforce, reinforcementDecisions } = planReinforcements(insights, pats, {
    today: '2026-05-10',
    gates: { minImportance: 7 },
  });
  assert.equal(reinforce.length, 0);
  assert.equal(reinforcementDecisions[0].decision, 'below-importance');
});

test('applyPromotionGates: passes evidence + bootstrap-guard, applies cap', () => {
  const candidates = [
    {
      slug: 'verify-live-claims-against-git',
      importance: 9,
      journalMentions: 4,
      evidence: [{ path: 'learning-journals/2026-05-10.md', lineNumber: 42 }],
    },
  ];
  const { promote, declined } = applyPromotionGates(candidates, {
    activePatterns: [],
    firingEntries: [],
    gates: { promotionThreshold: 3.0 },
  });
  assert.equal(promote.length, 1);
  assert.equal(promote[0].slug, 'verify-live-claims-against-git');
  assert.equal(declined.length, 0);
  assert.ok(promote[0].weightedEvidence >= 3.0);
});

test('applyPromotionGates declines when journalMentions below threshold and no firing hits', () => {
  const candidates = [{
    slug: 'foo',
    importance: 9,
    journalMentions: 1,
    evidence: [{ path: 'p', lineNumber: 1 }],
  }];
  const { promote, declined } = applyPromotionGates(candidates, {
    activePatterns: [],
    firingEntries: [],
  });
  assert.equal(promote.length, 0);
  assert.match(declined[0].reason, /weighted_evidence=/);
});

test('applyPromotionGates declines when active/ contains same slug (contradiction)', () => {
  const candidates = [{
    slug: 'caveman-check',
    importance: 9,
    journalMentions: 5,
    evidence: [{ path: 'p', lineNumber: 1 }],
  }];
  const { promote, declined } = applyPromotionGates(candidates, {
    activePatterns: [{ name: 'caveman-check' }],
    firingEntries: [],
  });
  assert.equal(promote.length, 0);
  assert.match(declined[0].reason, /contradiction/);
});

test('applyPromotionGates declines bootstrap:true reference without evidence.passes', () => {
  const candidates = [{
    slug: 'bootstrap-pat',
    importance: 9,
    journalMentions: 0,        // weighted = 0 < 3.0 → evidence.passes = false
    evidence: [{ path: 'p', lineNumber: 1 }],
    referenceFrontmatter: { bootstrap: true, demotion_phase: 'p3-2026-05-09' },
  }];
  const { promote, declined } = applyPromotionGates(candidates, {
    activePatterns: [],
    firingEntries: [],
  });
  assert.equal(promote.length, 0);
  // Both gates should fire: evidence + bootstrap-guard
  assert.match(declined[0].reason, /weighted_evidence|bootstrap-guard/);
});

test('applyPromotionGates allows bootstrap re-promotion when evidence passes; flags flagged for clear', () => {
  const candidates = [{
    slug: 'bootstrap-pat',
    importance: 9,
    journalMentions: 4,
    evidence: [{ path: 'p', lineNumber: 1 }],
    referenceFrontmatter: { bootstrap: true, demotion_phase: 'p3-2026-05-09' },
  }];
  const { promote, declined } = applyPromotionGates(candidates, {
    activePatterns: [],
    firingEntries: [],
  });
  assert.equal(declined.length, 0);
  assert.equal(promote.length, 1);
  assert.equal(promote[0].requiresFlagClear, true);
  assert.deepEqual(promote[0].flagsToClear, ['bootstrap', 'demotion_phase']);
});

test('applyPromotionGates enforces maxPromotionsPerNight cap', () => {
  const cs = ['a', 'b', 'c'].map(s => ({
    slug: s,
    importance: 9,
    journalMentions: 5,
    evidence: [{ path: 'p', lineNumber: 1 }],
  }));
  const { promote, declined } = applyPromotionGates(cs, {
    activePatterns: [],
    firingEntries: [],
    gates: { maxPromotionsPerNight: 1 },
  });
  assert.equal(promote.length, 1);
  assert.equal(declined.length, 2);
  for (const d of declined) assert.match(d.reason, /over cap/);
});

test('applyPromotionGates orders top-N by importance then weightedEvidence then slug', () => {
  const cs = [
    { slug: 'b', importance: 9, journalMentions: 4, evidence: [{ path: 'p', lineNumber: 1 }] },
    { slug: 'a', importance: 9, journalMentions: 4, evidence: [{ path: 'p', lineNumber: 1 }] },
    { slug: 'c', importance: 10, journalMentions: 4, evidence: [{ path: 'p', lineNumber: 1 }] },
  ];
  const { promote } = applyPromotionGates(cs, {
    activePatterns: [],
    firingEntries: [],
    gates: { maxPromotionsPerNight: 2 },
  });
  assert.deepEqual(promote.map(p => p.slug), ['c', 'a']); // c by importance, then a alphabetically
});

test('runRoute combines reinforcement + promotion + summary', () => {
  const result = runRoute({
    today: '2026-05-10',
    scoredInsights: [
      makeScoredInsight('caveman-check fired again', 9, { id: 'r1' }),
      makeScoredInsight('low score note', 4, { id: 'r2' }),
    ],
    activePatterns: [{ name: 'caveman-check', identifierStem: 'caveman-check', sightings: 11 }],
    promotionCandidates: [{
      slug: 'new-thing',
      importance: 9,
      journalMentions: 4,
      evidence: [{ path: 'p', lineNumber: 1 }],
    }],
    firingEntries: [],
  });
  assert.equal(result.plan.reinforce.length, 1);
  assert.equal(result.plan.reinforce[0].sightingsAfter, 12);
  assert.equal(result.plan.promote.length, 1);
  assert.equal(result.plan.promote[0].slug, 'new-thing');
  assert.equal(result.summary.scoredInsightCount, 2);
  assert.equal(result.summary.aboveThresholdCount, 1);
  assert.equal(result.summary.reinforcedPatternCount, 1);
  assert.equal(result.summary.promotedCount, 1);
});

test('runRoute requires today', () => {
  assert.throws(() => runRoute({ scoredInsights: [], activePatterns: [] }), /today required/);
});

// --- R2 fixes ---

test('insightMentionsPattern: kebab-token-majority fallback fires on prose phrasing', () => {
  // Reality-checker R1 F3: "DOM drift broke the walker" should match
  // `external-dom-drift-llm-default` when no trigger_phrases declared.
  const pat = { name: 'external-dom-drift-llm-default', identifierStem: 'external-dom-drift-llm-default' };
  assert.equal(insightMentionsPattern({ text: 'DOM drift broke the walker' }, pat), true);
  assert.equal(insightMentionsPattern({ text: 'DOM rebroke the walker' }, pat), false); // only 1 token
  assert.equal(insightMentionsPattern({ text: 'we used llm and default mode' }, pat), true); // llm + default
});

test('insightMentionsPattern: 1-token identifiers do NOT trigger fallback (must use full stem)', () => {
  const pat = { name: 'caveman', identifierStem: 'caveman' };
  assert.equal(insightMentionsPattern({ text: 'caveman approach' }, pat), true);  // stem hit
  assert.equal(insightMentionsPattern({ text: 'unrelated text' }, pat), false);
});

test('insightMentionsPattern: word-boundary respect (no substring of unrelated word)', () => {
  const pat = { name: 'drift-mode', identifierStem: 'drift-mode' };
  assert.equal(insightMentionsPattern({ text: 'drift mode engaged' }, pat), true);
  // "drifted modeled" has both `drift` and `mode` AS SUBSTRINGS but not as
  // bounded tokens. Word-boundary regex blocks the false match.
  assert.equal(insightMentionsPattern({ text: 'drifted modeled' }, pat), false);
});

test('applyPromotionGates: importance gate isolated (sole reason)', () => {
  const cs = [{
    slug: 'foo', importance: 5, journalMentions: 10,
    evidence: [{ path: 'p', lineNumber: 1 }],
  }];
  const { promote, declined } = applyPromotionGates(cs, {
    activePatterns: [], firingEntries: [],
  });
  assert.equal(promote.length, 0);
  assert.match(declined[0].reason, /importance=5 < min=7/);
  assert.equal(declined[0].reason.includes('weighted_evidence'), false);
});

test('applyPromotionGates: source citation gate isolated', () => {
  const cs = [{
    slug: 'foo', importance: 9, journalMentions: 10,
    evidence: [], // empty
  }];
  const { promote, declined } = applyPromotionGates(cs, {
    activePatterns: [], firingEntries: [],
  });
  assert.equal(promote.length, 0);
  assert.match(declined[0].reason, /no source citation/);
});

test('applyPromotionGates: numeric coercion on string importance / journalMentions', () => {
  const cs = [{
    slug: 'foo', importance: '9', journalMentions: '4',
    evidence: [{ path: 'p', lineNumber: 1 }],
  }];
  const { promote } = applyPromotionGates(cs, {
    activePatterns: [], firingEntries: [],
  });
  assert.equal(promote.length, 1);
  assert.equal(promote[0].importance, 9);
  assert.equal(promote[0].journalMentions, 4);
});

test('applyPromotionGates: NaN importance declined cleanly', () => {
  const cs = [{
    slug: 'foo', importance: 'not-a-number', journalMentions: 4,
    evidence: [{ path: 'p', lineNumber: 1 }],
  }];
  const { promote, declined } = applyPromotionGates(cs, {
    activePatterns: [], firingEntries: [],
  });
  assert.equal(promote.length, 0);
  assert.match(declined[0].reason, /importance=not-a-number/);
});

test('applyPromotionGates: 0 candidates returns empty', () => {
  const out = applyPromotionGates([], { activePatterns: [], firingEntries: [] });
  assert.deepEqual(out, { promote: [], declined: [] });
});

test('runRoute: fromReference promotion produces removeReference entry', () => {
  const result = runRoute({
    today: '2026-05-10',
    scoredInsights: [],
    activePatterns: [],
    promotionCandidates: [{
      slug: 'foo',
      importance: 9,
      journalMentions: 4,
      evidence: [{ path: 'p', lineNumber: 1 }],
      referenceFrontmatter: { bootstrap: true, demotion_phase: 'p3-2026-05-09' },
    }],
    firingEntries: [],
  });
  assert.equal(result.plan.promote.length, 1);
  assert.equal(result.plan.promote[0].fromReference, true);
  assert.equal(result.plan.removeReference.length, 1);
  assert.equal(result.plan.removeReference[0].slug, 'foo');
  assert.equal(result.plan.removeReference[0].path, 'patterns/reference/foo.md');
});

test('runRoute: net-new promotion (no reference) does NOT produce removeReference', () => {
  const result = runRoute({
    today: '2026-05-10',
    scoredInsights: [],
    activePatterns: [],
    promotionCandidates: [{
      slug: 'fresh',
      importance: 9,
      journalMentions: 4,
      evidence: [{ path: 'p', lineNumber: 1 }],
    }],
    firingEntries: [],
  });
  assert.equal(result.plan.promote[0].fromReference, false);
  assert.deepEqual(result.plan.removeReference, []);
});
