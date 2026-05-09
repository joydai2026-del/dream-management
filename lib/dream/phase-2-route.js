// Phase-2 ROUTE: classify scored insights and apply hard promotion gates.
//
// Per ARCHITECTURE.md § 3.2 and ADR/002-auto-merge-with-gates, the worker:
//
//   - REINFORCES an existing active pattern when a scored insight (importance
//     ≥ gates.minImportance) mentions the pattern's identifier or any of its
//     declared trigger_phrases. Multiple matching insights for the same
//     pattern collapse into one reinforcement decision; evidence accumulates.
//
//   - PROMOTES a candidate from `patterns/reference/` (or net-new) when ALL
//     of the following hold simultaneously:
//       1. importance ≥ gates.minImportance
//       2. firing-log promotionEvidence(...).passes === true
//       3. bootstrap-guard.canRePromote(...).allowed === true
//          (auto-allows for net-new candidates with no reference frontmatter)
//       4. ≥1 source citation (evidence entry)
//       5. no contradiction with an existing active pattern of the same slug
//
//   - Among qualifying promotions, ranks by importance and applies a HARD
//     `maxPromotionsPerNight` cap (default 1, per the locked decision in
//     Section 5 of the design doc). The cap is the throttle that prevents
//     auto-merge from blowing the patterns/active/ size budget.
//
// Output is a pure-data PLAN. Staging (writing into archive/dreams/<date>/
// staged/<rel>.tmp) is the next module's job. Keeping the two separated lets
// the dream-log entry, the auditor, and tests inspect the routing decisions
// without an fs side-effect.

import { promotionEvidence } from '../firing-log-read.js';
import { canRePromote } from './bootstrap-guard.js';

const DEFAULT_GATES = {
  maxPromotionsPerNight: 1,
  minImportance: 7,
  promotionThreshold: 3.0,
  firingLogWeight: 0.5,
  promotionLookbackDays: 30,
};

/**
 * Slugify a free-form pattern name for identifier-substring matching.
 * Mirrors the kebab-case-stem convention used elsewhere (firing-log spec § 5.2).
 */
export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Match an insight against a pattern descriptor.
 *
 * @param {Insight} insight
 * @param {{name: string, identifierStem?: string, triggerPhrases?: string[]}} pat
 * @returns {boolean}
 */
export function insightMentionsPattern(insight, pat) {
  if (!insight || !pat) return false;
  const haystack = String(insight.text || '').toLowerCase();
  if (!haystack) return false;

  const stem = (pat.identifierStem || pat.name || '').toLowerCase();
  if (stem && haystack.includes(stem)) return true;

  const triggers = Array.isArray(pat.triggerPhrases) ? pat.triggerPhrases : [];
  for (const t of triggers) {
    if (!t) continue;
    if (haystack.includes(String(t).toLowerCase())) return true;
  }
  return false;
}

/**
 * Build the reinforcement plan from scored insights × active patterns.
 *
 * Insights below `minImportance` are dropped. An insight may match multiple
 * patterns; each match contributes evidence to that pattern's reinforcement.
 *
 * @returns {{
 *   reinforce: Array<{
 *     pattern: string,
 *     identifierStem: string,
 *     sightingsBefore: number,
 *     sightingsAfter: number,
 *     latestSeen: string,
 *     evidence: Array<{path: string, lineNumber: number, score: number, rationale: string}>,
 *   }>,
 *   reinforcementDecisions: Array<{insightId: string, decision: 'reinforce' | 'below-importance' | 'no-match'}>,
 * }}
 */
export function planReinforcements(scoredInsights, activePatterns, opts = {}) {
  const { gates = {}, today } = opts;
  const merged = { ...DEFAULT_GATES, ...gates };
  if (!today) throw new Error('planReinforcements: today required');

  const byPattern = new Map();
  const decisions = [];

  for (const si of (scoredInsights || [])) {
    if (!si || !si.insight) continue;
    if (si.score < merged.minImportance) {
      decisions.push({ insightId: si.insight.id, decision: 'below-importance' });
      continue;
    }
    let matched = false;
    for (const pat of (activePatterns || [])) {
      if (!insightMentionsPattern(si.insight, pat)) continue;
      matched = true;
      const key = pat.name;
      if (!byPattern.has(key)) {
        const before = Number.isFinite(pat.sightings) ? pat.sightings : 0;
        byPattern.set(key, {
          pattern: pat.name,
          identifierStem: pat.identifierStem || pat.name,
          sightingsBefore: before,
          sightingsAfter: before + 1,
          latestSeen: today,
          evidence: [],
        });
      }
      const r = byPattern.get(key);
      r.evidence.push({
        path: si.insight.evidence?.path,
        lineNumber: si.insight.evidence?.lineNumber,
        score: si.score,
        rationale: si.rationale,
      });
    }
    decisions.push({
      insightId: si.insight.id,
      decision: matched ? 'reinforce' : 'no-match',
    });
  }

  // sightingsAfter is `sightingsBefore + 1` regardless of how many insights
  // matched, because architecture says "bump sightings count" — once per
  // dream-pass per pattern. The accumulated evidence list is what records the
  // multi-source basis of the bump.
  return {
    reinforce: [...byPattern.values()].sort((a, b) => a.pattern.localeCompare(b.pattern)),
    reinforcementDecisions: decisions,
  };
}

/**
 * Apply hard promotion gates to a list of explicit candidates.
 *
 * Candidates are NOT auto-extracted in Phase 2 starter; the caller (Phase 1.5
 * clustering, manual curation, or future LLM extractor) supplies them. This
 * keeps the routing engine deterministic and lets the candidate-discovery
 * mechanism evolve without rewriting the gate logic.
 *
 * Each candidate shape:
 *   {
 *     slug: 'kebab-case-name',
 *     importance: 1-10,         // typically max score among supporting insights
 *     journalMentions: number,  // pre-computed prior-journal-mention count
 *     evidence: Array<{path, lineNumber, ...}>,  // ≥1 required
 *     referenceFrontmatter?: object | null,      // if reference/ file exists
 *   }
 *
 * @returns {{
 *   promote: Array<PromoteEntry>,
 *   declined: Array<{ slug: string, reason: string }>,
 * }}
 */
export function applyPromotionGates(candidates, opts = {}) {
  const {
    gates = {},
    activePatterns = [],
    firingEntries = [],
    now = Date.now(),
  } = opts;
  const merged = { ...DEFAULT_GATES, ...gates };

  const activeSlugs = new Set(
    (activePatterns || []).map(p => slugify(p.name)).filter(Boolean),
  );
  const qualified = [];
  const declined = [];

  for (const c of (candidates || [])) {
    if (!c || !c.slug) {
      declined.push({ slug: c?.slug || '<missing-slug>', reason: 'malformed candidate' });
      continue;
    }
    const reasons = [];

    // Gate 1: importance
    if (!Number.isFinite(c.importance) || c.importance < merged.minImportance) {
      reasons.push(`importance=${c.importance ?? 'n/a'} < min=${merged.minImportance}`);
    }
    // Gate 5: contradiction with active
    if (activeSlugs.has(c.slug)) {
      reasons.push(`contradiction: '${c.slug}' already in patterns/active/`);
    }
    // Gate 4: source citation
    if (!Array.isArray(c.evidence) || c.evidence.length === 0) {
      reasons.push('no source citation');
    }

    // Gate 2: firing-log promotion evidence
    const evidence = promotionEvidence(c.slug, firingEntries, {
      days: merged.promotionLookbackDays,
      journalMentions: Number.isFinite(c.journalMentions) ? c.journalMentions : 0,
      firingLogWeight: merged.firingLogWeight,
      threshold: merged.promotionThreshold,
      now,
    });
    if (!evidence.passes) {
      reasons.push(
        `weighted_evidence=${evidence.weightedEvidence.toFixed(2)} < threshold=${evidence.threshold}`,
      );
    }

    // Gate 3: bootstrap-guard re-promotion
    const guard = canRePromote(c.referenceFrontmatter || null, evidence);
    if (!guard.allowed) {
      reasons.push(`bootstrap-guard: ${guard.reason}`);
    }

    if (reasons.length > 0) {
      declined.push({ slug: c.slug, reason: reasons.join('; ') });
      continue;
    }

    qualified.push({
      slug: c.slug,
      importance: c.importance,
      journalMentions: c.journalMentions,
      evidence: c.evidence,
      firingHits: evidence.firingHits,
      weightedEvidence: evidence.weightedEvidence,
      threshold: evidence.threshold,
      flagsToClear: guard.flagsToClear,
      requiresFlagClear: guard.requiresFlagClear,
      fromReference: Boolean(c.referenceFrontmatter),
    });
  }

  // Rank qualified by importance desc, tie-break by weightedEvidence desc, then
  // alphabetical for determinism. Apply maxPerNight cap.
  qualified.sort((a, b) => (
    b.importance - a.importance
    || b.weightedEvidence - a.weightedEvidence
    || a.slug.localeCompare(b.slug)
  ));
  const cap = merged.maxPromotionsPerNight;
  const promote = qualified.slice(0, cap);
  const overflow = qualified.slice(cap);
  for (const o of overflow) {
    declined.push({
      slug: o.slug,
      reason: `over cap: maxPromotionsPerNight=${cap}, ranked outside top ${cap}`,
    });
  }
  return { promote, declined };
}

/**
 * Top-level entry point: produce the full Phase-2 RoutePlan.
 *
 * @param {object} input
 * @param {Array<ScoredInsight>} input.scoredInsights
 * @param {Array<PatternDescriptor>} input.activePatterns
 * @param {Array<PromotionCandidate>} [input.promotionCandidates]
 * @param {Array<FiringLogEntry>} [input.firingEntries]
 * @param {object} [input.gates]
 * @param {string} input.today                 — YYYY-MM-DD
 * @param {number} [input.now]                 — Date.now() override for tests
 * @returns {{ plan: RoutePlan, summary: object }}
 */
export function runRoute(input) {
  const {
    scoredInsights = [],
    activePatterns = [],
    promotionCandidates = [],
    firingEntries = [],
    gates = {},
    today,
    now = Date.now(),
  } = input || {};

  if (!today) throw new Error('runRoute: today required');

  const reinforcement = planReinforcements(scoredInsights, activePatterns, { gates, today });
  const promotionResult = applyPromotionGates(promotionCandidates, {
    gates, activePatterns, firingEntries, now,
  });

  const plan = {
    today,
    reinforce: reinforcement.reinforce,
    promote: promotionResult.promote,
    declined: promotionResult.declined,
  };
  const summary = {
    scoredInsightCount: scoredInsights.length,
    aboveThresholdCount: scoredInsights.filter(s =>
      Number.isFinite(s.score) && s.score >= (gates.minImportance ?? DEFAULT_GATES.minImportance),
    ).length,
    reinforcedPatternCount: plan.reinforce.length,
    promotedCount: plan.promote.length,
    declinedCount: plan.declined.length,
    reinforcementDecisions: reinforcement.reinforcementDecisions,
  };
  return { plan, summary };
}

export const _internals = { DEFAULT_GATES };
