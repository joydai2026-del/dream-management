// Weekly dream-log digest generator.
//
// Per ARCHITECTURE.md § 6 should-fix list ("Weekly dream digest
// `dream-log-weekly.md`"). Reads the last 7 days of event.json files
// from archive/dreams/<date>/event.json and emits a single human-
// readable summary at <memoryRoot>/dream-log-weekly.md.
//
// The digest is intended to land at the END of each Sunday's dream
// pass (or whichever day the launchd plist hits each week). Writing
// is atomic per atomic-write.js. The file is regenerated, not appended;
// each run produces the canonical "last 7 days" snapshot.
//
// The weekly digest is OBSERVABILITY ONLY. It does not feed back into
// the worker's decisions; JJ reads it as an "is the dream system doing
// what I want?" sanity check.
//
// Output shape (markdown):
//   # Dream-management weekly digest — YYYY-MM-DD..YYYY-MM-DD
//
//   ## Summary
//   - 7 nightly runs (5 PASS, 1 WARN, 1 FAIL, 0 SKIP)
//   - 4 patterns reinforced, 1 promoted, 0 declined
//   - 12 corrections aged out, 8 sessions archived
//   - 2 contradictions surfaced (still pending JJ review)
//
//   ## Per-night entries
//   ### 2026-05-09 PASS
//   - 1 reinforce (external-dom-drift sightings 11→12)
//   - 5 corrections archived to 2026-05.md
//   - Stage A 0 findings, Stage B 0 findings
//
//   ## Pending JJ review
//   - <contradiction descriptions>

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../atomic-write.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_DAYS = 7;

/**
 * Generate the weekly digest.
 *
 * @param {object} opts
 * @param {string} opts.memoryRoot
 * @param {string} opts.today                   YYYY-MM-DD
 * @param {number} [opts.windowDays]            default 7
 * @param {boolean} [opts.write]                default true; false → return content only
 * @returns {Promise<{content, summary, path: string|null}>}
 */
export async function generateWeeklyDigest(opts) {
  const {
    memoryRoot,
    today,
    windowDays = DEFAULT_WINDOW_DAYS,
    write = true,
  } = opts || {};
  if (!memoryRoot) throw new Error('generateWeeklyDigest: memoryRoot required');
  if (!today) throw new Error('generateWeeklyDigest: today required');
  if (!ISO_DATE_RE.test(today)) {
    throw new Error(`generateWeeklyDigest: today must match YYYY-MM-DD; got '${today}'`);
  }

  const dates = lastNDates(today, windowDays);
  const events = [];
  for (const d of dates) {
    const evt = await readEvent(memoryRoot, d);
    if (evt) events.push({ date: d, evt });
  }

  const summary = summarize(events);
  const content = renderDigest({
    today,
    windowStart: dates[dates.length - 1],
    windowEnd: dates[0],
    events,
    summary,
  });

  let outPath = null;
  if (write) {
    outPath = path.join(memoryRoot, 'dream-log-weekly.md');
    await atomicWrite(outPath, content);
  }
  return { content, summary, path: outPath };
}

function lastNDates(today, n) {
  const baseMs = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(baseMs)) {
    throw new Error(`lastNDates: invalid today '${today}'`);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(baseMs - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out; // descending
}

async function readEvent(memoryRoot, date) {
  const fp = path.join(memoryRoot, 'archive', 'dreams', date, 'event.json');
  let raw;
  try { raw = await fs.readFile(fp, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try { return JSON.parse(raw); }
  catch { return null; } // corrupt event.json → treated as missing
}

function summarize(events) {
  const verdicts = { PASS: 0, WARN: 0, FAIL: 0, 'PASS-TENTATIVE': 0, OTHER: 0 };
  let reinforce = 0;
  let promote = 0;
  let decline = 0;
  let correctionsArchived = 0;
  let sessionsArchived = 0;
  let demoted = 0;
  let contradictions = 0;
  const pendingContradictions = [];
  for (const { evt } of events) {
    const v = evt.verdict;
    if (v in verdicts) verdicts[v] += 1; else verdicts.OTHER += 1;
    const r = evt.routed || {};
    reinforce += (r.patterns_reinforced || []).length;
    promote += (r.patterns_promoted || []).length;
    decline += (r.patterns_promotion_declined || []).length;
    const p = evt.pruned || {};
    correctionsArchived += p.corrections_lines_archived || 0;
    sessionsArchived += Math.max(0, (p.session_index_lines_before || 0) - (p.session_index_lines_after || 0));
    demoted += (p.patterns_demoted || []).length;
    const cs = evt.contradictions_surfaced || [];
    contradictions += cs.length;
    for (const c of cs) {
      pendingContradictions.push({
        date: evt.run_id?.slice(0, 10) || 'unknown',
        description: c.description || '(no description)',
        severity: c.severity || 'medium',
      });
    }
  }
  return {
    runs: events.length,
    verdicts,
    reinforce,
    promote,
    decline,
    corrections_archived: correctionsArchived,
    sessions_archived: sessionsArchived,
    demoted,
    contradictions_total: contradictions,
    pending_contradictions: pendingContradictions,
  };
}

function renderDigest({ today, windowStart, windowEnd, events, summary }) {
  const lines = [];
  lines.push(`# Dream-management weekly digest — ${windowStart}..${windowEnd}`);
  lines.push('');
  lines.push(`Generated by /dream on ${today}.`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  const v = summary.verdicts;
  lines.push(`- ${summary.runs} run${summary.runs === 1 ? '' : 's'} found in window (${v.PASS} PASS, ${v.WARN} WARN, ${v.FAIL} FAIL${v['PASS-TENTATIVE'] ? `, ${v['PASS-TENTATIVE']} PASS-TENTATIVE` : ''}${v.OTHER ? `, ${v.OTHER} other` : ''})`);
  lines.push(`- Patterns: ${summary.reinforce} reinforced, ${summary.promote} promoted, ${summary.decline} declined, ${summary.demoted} demoted`);
  lines.push(`- Pruning: ${summary.corrections_archived} correction lines archived, ~${summary.sessions_archived} session-index lines compacted`);
  lines.push(`- Contradictions surfaced: ${summary.contradictions_total} (still pending JJ review)`);
  lines.push('');

  if (events.length === 0) {
    lines.push('## Per-night entries');
    lines.push('');
    lines.push('_No event.json files in window — likely the system has only just started running._');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Per-night entries');
  lines.push('');
  for (const { date, evt } of events) {
    const v = evt.verdict || 'unknown';
    lines.push(`### ${date} ${v}`);
    const r = evt.routed || {};
    if ((r.patterns_reinforced || []).length > 0) {
      const examples = r.patterns_reinforced.slice(0, 3)
        .map(p => `${p.pattern}→${p.sightings_after}`).join(', ');
      lines.push(`- reinforced: ${r.patterns_reinforced.length} (${examples})`);
    }
    if ((r.patterns_promoted || []).length > 0) {
      lines.push(`- promoted: ${r.patterns_promoted.map(p => p.slug).join(', ')}`);
    }
    if ((r.patterns_promotion_declined || []).length > 0) {
      lines.push(`- declined: ${r.patterns_promotion_declined.length}`);
    }
    const p = evt.pruned || {};
    if ((p.corrections_lines_archived || 0) > 0) {
      lines.push(`- archived ${p.corrections_lines_archived} correction lines`);
    }
    if ((p.patterns_demoted || []).length > 0) {
      lines.push(`- demoted: ${p.patterns_demoted.map(d => d.name).join(', ')}`);
    }
    const aud = evt.audit || {};
    const sa = aud.stage_a || {};
    const sb = aud.stage_b || {};
    lines.push(`- Stage A ${sa.verdict || 'pending'}${(sa.findings || []).length ? ` (${(sa.findings || []).length} findings)` : ''} | Stage B ${sb.verdict || 'pending'}${(sb.findings || []).length ? ` (${(sb.findings || []).length} findings, ${sb.model || 'n/a'})` : ''}`);
    lines.push('');
  }

  if (summary.pending_contradictions.length > 0) {
    lines.push('## Pending JJ review');
    lines.push('');
    for (const c of summary.pending_contradictions) {
      lines.push(`- **${c.date}** [${c.severity}] ${c.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export const _internals = {
  DEFAULT_WINDOW_DAYS,
  lastNDates,
  readEvent,
  summarize,
  renderDigest,
};
