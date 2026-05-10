// Contradiction detector — wraps firingLogRead.recurrentViolations into a
// dream-worker-shaped output that Phase 5 can route into event.json's
// contradictions_surfaced field + dream-log-entry.md.
//
// Per ARCHITECTURE.md § 3.2 Phase 4 + § 3.5 (rule #4 — contradictions
// surface, never auto-fix). Phase 4 ships a STUB; Phase D promotes it to
// a real detector.
//
// Two contradiction sources combined:
//
// 1. Recurrent violations (from pattern-firing-log.md): a pattern fired
//    `violated` ≥minCount times within `days` is a contradiction in
//    practice — the rule exists but isn't holding. The dream-log surfaces
//    the pattern + the violation evidence so JJ can decide whether to
//    rewrite the rule, demote it, or hand-correct the workflow that's
//    causing repeated misses.
//
// 2. Direct contradictions across hot-tier files: scan working-memory.md,
//    corrections.md, and patterns/active/*.md for paired anti-rules
//    (e.g., one rule says "always X", a correction says "don't X").
//    P5 starter ships ONLY the firing-log-based path; cross-file scanning
//    is heuristic-prone and deferred until the firing-log signal proves
//    insufficient (call it MF-12 — log it, don't build it speculatively).
//
// Output shape mirrors the schema in archive-schema.md § 2.5:
//   {
//     description: string,           // human-readable summary
//     file_paths: string[],          // related files JJ should read
//     decision: 'JJ to resolve next morning'  // sweep never auto-fixes
//   }

import { recurrentViolations } from '../firing-log-read.js';

const DEFAULT_VIOLATION_DAYS = 14;
const DEFAULT_MIN_VIOLATION_COUNT = 2;

/**
 * Detect contradictions for the current dream pass.
 *
 * @param {object} opts
 * @param {Array<FiringLogEntry>} opts.firingEntries  output of readAllEntries()
 * @param {Date}   [opts.now]                          default new Date()
 * @param {number} [opts.violationDays]                default 14
 * @param {number} [opts.minViolationCount]            default 2
 * @returns {{
 *   contradictions: Array<{description, file_paths, decision, severity, source}>,
 *   summary: { recurrent_count: number },
 * }}
 */
export function detectContradictions(opts) {
  const {
    firingEntries = [],
    now = new Date(),
    violationDays = DEFAULT_VIOLATION_DAYS,
    minViolationCount = DEFAULT_MIN_VIOLATION_COUNT,
  } = opts || {};

  const recurrent = recurrentViolations(firingEntries, {
    days: violationDays,
    minCount: minViolationCount,
    now: now.getTime(),
  });

  const contradictions = recurrent.map(r => ({
    description:
      `Pattern '${r.pattern}' was violated ${r.count}× in the last ${violationDays} days `
      + `despite being in patterns/active/. The rule exists but isn't firing at decision time.`,
    file_paths: [`patterns/active/${r.pattern}.md`, 'pattern-firing-log.md'],
    decision: 'JJ to resolve next morning',
    severity: r.count >= minViolationCount + 2 ? 'high' : 'medium',
    source: 'firing_log_recurrent_violations',
    evidence: (r.sources || []).slice(0, 3).map(s => ({
      session: s.session,
      evidence: s.evidence,
    })),
    count: r.count,
  }));

  return {
    contradictions,
    summary: {
      recurrent_count: recurrent.length,
    },
  };
}

export const _internals = {
  DEFAULT_VIOLATION_DAYS,
  DEFAULT_MIN_VIOLATION_COUNT,
};
