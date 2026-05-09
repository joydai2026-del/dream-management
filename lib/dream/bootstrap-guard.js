// ADR 008 STRUCTURAL ENFORCEMENT TODO — bootstrap-rejection guards.
//
// Background: the 2026-05-09 P3 cleanup demoted 16 patterns under a one-time
// concession (bootstrap:true + demotion_phase: p3-2026-05-09). ADR 008 makes
// that concession structurally enforceable in the P4 worker by requiring:
//
//   (1) bootstrap:true files cannot be re-promoted unless evidence-based
//       criteria are met. Per ADR 008 Consequences §, re-promotion clears
//       BOTH the bootstrap flag AND the demotion_phase tag (the file is no
//       longer a one-time-cleanup artifact).
//   (2) The literal demotion_phase value `p3-2026-05-09` is frozen as a
//       historical marker — refused on any new write.
//   (3) Future P3-style cleanups must use a NEW well-shaped demotion_phase:
//       p3-YYYY-MM-DD that is not in the frozen set.
//
// P4 starter ships the predicate library. The Phase-3 demotion gate (later
// scope) calls these predicates before mutating pattern frontmatter. Tests
// pin the contract so a future Phase-3 implementer cannot bypass it without
// also breaking the tests.
//
// TODO (P5+ wrapup-pattern-promote pipeline): consume `canRePromote` and
// honor `flagsToClear`. Until that callsite ships, the predicate's contract
// is enforced by tests only.

const FROZEN_DEMOTION_PHASES = new Set(['p3-2026-05-09']);
const DEMOTION_PHASE_SHAPE_RE = /^p3-\d{4}-\d{2}-\d{2}$/;

const FLAGS_TO_CLEAR_ON_REPROMOTE = ['bootstrap', 'demotion_phase'];

/**
 * Decide whether a candidate pattern may be re-promoted from reference/ to
 * active/.
 *
 * @param {object|null} frontmatter — parsed YAML object from the pattern file
 * @param {object|null} evidence    — output of firing-log-read.promotionEvidence()
 * @returns {{
 *   allowed: boolean,
 *   reason: string,
 *   requiresFlagClear: boolean,
 *   flagsToClear: string[],
 * }}
 *
 * Non-bootstrap patterns are out of this guard's scope: they pass through with
 * allowed=true and an empty flagsToClear. The guard governs only files
 * carrying the bootstrap flag from the 2026-05-09 cleanup (or future scoped
 * cleanups using the same flag).
 */
export function canRePromote(frontmatter, evidence) {
  const isBootstrap = frontmatter && frontmatter.bootstrap === true;
  if (!isBootstrap) {
    return {
      allowed: true,
      reason: 'not a bootstrap file',
      requiresFlagClear: false,
      flagsToClear: [],
    };
  }
  if (!evidence || evidence.passes !== true) {
    const w = evidence?.weightedEvidence;
    const t = evidence?.threshold;
    return {
      allowed: false,
      reason: `bootstrap:true requires evidence.passes=true; got weighted=${w ?? 'n/a'} threshold=${t ?? 'n/a'}`,
      requiresFlagClear: false,
      flagsToClear: [],
    };
  }
  return {
    allowed: true,
    reason: 'evidence-based criteria met; bootstrap and demotion_phase flags must be cleared on re-promotion',
    requiresFlagClear: true,
    flagsToClear: [...FLAGS_TO_CLEAR_ON_REPROMOTE],
  };
}

/**
 * Decide whether a proposed demotion_phase value is allowed for the current run.
 *
 * @param {string} phaseValue — what the worker proposes to write
 * @param {string} currentDate — ISO YYYY-MM-DD of the run; used only to
 *                                generate the suggested replacement string
 *                                on rejection. Per ADR 008 spirit, we DO NOT
 *                                require the phase date to equal currentDate;
 *                                a worker batching a backlog cleanup may
 *                                legitimately write a past date. We only
 *                                refuse the FROZEN historical marker and
 *                                require well-shaped p3-YYYY-MM-DD.
 * @returns {{ allowed: boolean, reason: string, suggested?: string }}
 */
export function validateDemotionPhase(phaseValue, currentDate) {
  if (FROZEN_DEMOTION_PHASES.has(phaseValue)) {
    return {
      allowed: false,
      reason: `demotion_phase '${phaseValue}' is frozen as a one-time historical marker (ADR 008); use p3-${currentDate}`,
      suggested: `p3-${currentDate}`,
    };
  }
  if (typeof phaseValue !== 'string' || !DEMOTION_PHASE_SHAPE_RE.test(phaseValue)) {
    return {
      allowed: false,
      reason: `demotion_phase must match p3-YYYY-MM-DD; got '${phaseValue}'`,
      suggested: `p3-${currentDate}`,
    };
  }
  return { allowed: true, reason: 'phase value valid (not in frozen set, shape OK)' };
}

export const _internals = {
  FROZEN_DEMOTION_PHASES,
  FLAGS_TO_CLEAR_ON_REPROMOTE,
};
