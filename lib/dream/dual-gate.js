// Dual-gate cadence check.
//
// Per ARCHITECTURE.md § 3.1 + the locked decision in front-matter:
// the nightly dream pass runs at 3am ONLY IF
//   (a) ≥24h since the last successful dream run, AND
//   (b) ≥1 session log in the past 24h
//
// The launchd plist fires bin/dream.js at 3am every day; this check is
// what dream.js calls FIRST to decide whether to do real work or skip.
// The skip path writes a single SKIP line to .dream-log.md and exits 0
// so launchd considers the run successful.
//
// `lastSuccessfulRunAt`:
//   We don't read .dream-log.md content (parsing markdown is fragile);
//   instead we look for the most recent `archive/dreams/<YYYY-MM-DD>/event.json`
//   whose `verdict` field is one of {PASS, WARN}. FAIL runs DON'T satisfy
//   the gate (a FAIL might re-run sooner). PASS-TENTATIVE means the
//   audits hadn't completed; treat as "no successful run yet."
//
// `recentSessionCount`:
//   Count files in `<memoryRoot>/session-logs/` whose mtime falls within
//   the last `windowMs` (default 24h). Configurable via opts.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_MIN_HOURS_SINCE_LAST = 24;
const DEFAULT_MIN_SESSIONS_IN_WINDOW = 1;
const DEFAULT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} opts
 * @param {string} opts.memoryRoot
 * @param {Date}   [opts.now]                       default new Date()
 * @param {number} [opts.minHoursSinceLast]         default 24
 * @param {number} [opts.minSessionsInWindow]       default 1
 * @param {number} [opts.sessionWindowMs]           default 24h
 * @returns {Promise<{
 *   shouldRun: boolean,
 *   reason: string,
 *   gates: {
 *     hours_since_last_run: number | null,
 *     last_run_date: string | null,
 *     last_run_verdict: string | null,
 *     sessions_in_window: number,
 *   }
 * }>}
 */
export async function checkDualGate(opts) {
  const {
    memoryRoot,
    now = new Date(),
    minHoursSinceLast = DEFAULT_MIN_HOURS_SINCE_LAST,
    minSessionsInWindow = DEFAULT_MIN_SESSIONS_IN_WINDOW,
    sessionWindowMs = DEFAULT_SESSION_WINDOW_MS,
  } = opts || {};
  if (!memoryRoot) throw new Error('checkDualGate: memoryRoot required');

  const last = await findLastSuccessfulRun(memoryRoot);
  let hoursSinceLast = null;
  if (last) {
    hoursSinceLast = (now.getTime() - Date.parse(last.runIdISO)) / 3_600_000;
  }
  const sessionsInWindow = await countRecentSessions(memoryRoot, now, sessionWindowMs);

  const gates = {
    hours_since_last_run: hoursSinceLast,
    last_run_date: last?.date || null,
    last_run_verdict: last?.verdict || null,
    sessions_in_window: sessionsInWindow,
  };

  // Sweep-abort recovery: if the most recent run was FAIL with staged/
  // still present, refuse to start a new run. JJ must inspect the staged
  // tree and either complete recovery or delete it. Surfaces as a
  // shouldRun=false reason that the SKIP log line carries forward.
  if (last && last.verdict === 'FAIL-WITH-STAGED') {
    return {
      shouldRun: false,
      reason: `previous run on ${last.date} aborted with staged tree preserved — JJ must inspect archive/dreams/${last.date}/staged/ before next run`,
      gates,
    };
  }

  // Gate (a): ≥minHoursSinceLast since last successful run.
  if (last && hoursSinceLast < minHoursSinceLast) {
    return {
      shouldRun: false,
      reason: `last successful run was ${hoursSinceLast.toFixed(1)}h ago (< ${minHoursSinceLast}h threshold)`,
      gates,
    };
  }
  // Gate (b): ≥minSessionsInWindow sessions in the recent window.
  if (sessionsInWindow < minSessionsInWindow) {
    return {
      shouldRun: false,
      reason: `${sessionsInWindow} sessions in last ${(sessionWindowMs / 3_600_000).toFixed(0)}h (< ${minSessionsInWindow} threshold) — quiet day`,
      gates,
    };
  }
  return {
    shouldRun: true,
    reason: last
      ? `${hoursSinceLast.toFixed(1)}h since last ${last.verdict} run (${last.date}); ${sessionsInWindow} sessions in window`
      : `no prior successful run; ${sessionsInWindow} sessions in window`,
    gates,
  };
}

/**
 * Walk archive/dreams/ in descending date order; return the first event.json
 * whose verdict is "successful enough" to gate the next dream run.
 *
 * "Successful enough" includes:
 *   - PASS: full happy path (Stage A + Stage B + sweep all clean, finalize ran)
 *   - WARN: warn-only findings, sweep proceeded (mitigation logged)
 *   - PASS-TENTATIVE w/ sweep absent in audit AND staged tree gone:
 *     a worker that completed sweep but crashed before finalize updates
 *     event.json.verdict still mutated the live tree. The next run must
 *     NOT treat this as "no prior run" or it'll do duplicate work and
 *     potentially create cross-day inconsistencies. Detect by the
 *     presence of staged/ — its absence indicates a successful sweep.
 *
 * FAIL is not "successful enough"; the next run can re-attempt sooner.
 */
async function findLastSuccessfulRun(memoryRoot) {
  const dreamsDir = path.join(memoryRoot, 'archive', 'dreams');
  let dates;
  try {
    dates = (await fs.readdir(dreamsDir, { withFileTypes: true }))
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map(d => d.name)
      .sort((a, b) => b.localeCompare(a)); // descending
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  for (const date of dates) {
    const dreamRoot = path.join(dreamsDir, date);
    const evtPath = path.join(dreamRoot, 'event.json');
    let raw;
    try { raw = await fs.readFile(evtPath, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    let evt;
    try { evt = JSON.parse(raw); }
    catch { continue; }
    if (evt.verdict === 'PASS' || evt.verdict === 'WARN') {
      return {
        date,
        verdict: evt.verdict,
        runIdISO: evt.run_id || `${date}T03:00:00Z`,
      };
    }
    if (evt.verdict === 'PASS-TENTATIVE') {
      // Crash-recovery detection: if the staged tree is gone, sweep
      // succeeded — finalize crashed mid-write. Treat as PASS-TENTATIVE-
      // SWEPT (a successful run with stale verdict label).
      const stagedDir = path.join(dreamRoot, 'staged');
      let stagedExists = true;
      try { await fs.access(stagedDir); }
      catch (e) { if (e.code === 'ENOENT') stagedExists = false; else throw e; }
      if (!stagedExists) {
        return {
          date,
          verdict: 'PASS-TENTATIVE-SWEPT',
          runIdISO: evt.run_id || `${date}T03:00:00Z`,
        };
      }
    }
    if (evt.verdict === 'FAIL') {
      // Sweep-abort recovery: a FAIL with staged/ still present is a
      // partial-commit state that needs JJ inspection. The next dream
      // run MUST NOT proceed against the same dreamDir or it'll either
      // collide with the preserved staged tree or silently overwrite
      // recovery evidence. Treat as a "blocking last run" — gate (a)
      // ignores it (FAIL doesn't satisfy success), but we surface it
      // separately so the run-decision can refuse with a recovery hint.
      const stagedDir = path.join(dreamRoot, 'staged');
      let stagedExists = true;
      try { await fs.access(stagedDir); }
      catch (e) { if (e.code === 'ENOENT') stagedExists = false; else throw e; }
      if (stagedExists) {
        return {
          date,
          verdict: 'FAIL-WITH-STAGED',
          runIdISO: evt.run_id || `${date}T03:00:00Z`,
          blocking: true,
        };
      }
    }
  }
  return null;
}

/**
 * Count files in <memoryRoot>/session-logs/ whose mtime falls within
 * (now - sessionWindowMs, now]. Non-existent dir returns 0.
 */
async function countRecentSessions(memoryRoot, now, sessionWindowMs) {
  const sessionsDir = path.join(memoryRoot, 'session-logs');
  let entries;
  try { entries = await fs.readdir(sessionsDir, { withFileTypes: true }); }
  catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  const cutoff = now.getTime() - sessionWindowMs;
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    let stat;
    try { stat = await fs.stat(path.join(sessionsDir, entry.name)); }
    catch { continue; }
    if (stat.mtimeMs > cutoff) count += 1;
  }
  return count;
}

/**
 * Render the SKIP line that bin/dream.js writes to .dream-log.md when
 * the dual gate fails. Append-only one-liner; safe to drop into the live
 * log without atomicAppend collision because launchd serializes runs.
 */
export function renderSkipLogLine({ today, gateResult }) {
  const reason = gateResult?.reason || 'unknown';
  return `## ${today} 03:00 SKIP — ${reason}\n`;
}

export const _internals = {
  DEFAULT_MIN_HOURS_SINCE_LAST,
  DEFAULT_MIN_SESSIONS_IN_WINDOW,
  DEFAULT_SESSION_WINDOW_MS,
  findLastSuccessfulRun,
  countRecentSessions,
};
