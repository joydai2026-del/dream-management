// Flatten a Phase-1 replay output into a unified `Insight[]` list.
//
// Phase-1 emits two heterogeneous signal streams:
//   journal.entries        — `{ time, category, bucket, summary }`
//   sessionLogs.entries[].markers — `{ lineNumber, kind, text }`
//
// Phase-2 needs them in one shape so scoring, classification, and routing are
// uniform. The Insight shape is intentionally narrow:
//
//   {
//     id:       stable identifier — `journal:<path>#L<n>` or `marker:<path>#L<n>`
//     source:   'journal' | 'session-marker'
//     bucket:   'mistake' | 'correction' | 'method-worked' | 'didnt-work' | 'other'
//     text:     the raw content (one line, trimmed)
//     date:     YYYY-MM-DD parsed from the source file (journal date OR session date)
//     evidence: { path, lineNumber }   — used as source citation downstream
//   }
//
// Bucket vocabulary is the closed set the worker reasons about; journal categories
// (which can be arbitrary tags) are mapped down. Unknown categories collapse to
// 'other' so they don't disappear silently — Phase 4 contradictions/observability
// can still see them.

import path from 'node:path';

// Journal categories → bucket. Mirrors `journal-consume.js` BUCKET map intent
// but emits the canonical 4-tag vocabulary used by session markers (so a single
// scoring/classification table works across both signal streams).
const JOURNAL_CATEGORY_TO_BUCKET = {
  mistake: 'mistake',
  correction: 'correction',
  'jj-input': 'correction',
  worked: 'method-worked',
  'method-worked': 'method-worked',
  completed: 'method-worked',
  'didnt-work': 'didnt-work',
  "didn't-work": 'didnt-work',
  'method-failed': 'didnt-work',
  insight: 'other',
  start: 'other',
};

const KNOWN_BUCKETS = new Set(['mistake', 'correction', 'method-worked', 'didnt-work', 'other']);

// Parse a journal-line line number from its `[HH:MM]` time stamp by counting
// occurrences in the source file. We don't have line numbers from the parser,
// so emit a deterministic fallback: position in entry list. It's used only as
// an anchor in the evidence path; nightly observability accepts that it points
// to the entry's ordinal, not the literal file line.
function journalLineAnchor(index) {
  return index + 1;
}

function bucketForJournalCategory(category) {
  const k = String(category || '').trim().toLowerCase();
  return JOURNAL_CATEGORY_TO_BUCKET[k] || 'other';
}

function dateFromSessionPath(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function relativeIfPossible(memoryRoot, abs) {
  if (!memoryRoot) return abs;
  const rel = path.relative(memoryRoot, abs);
  return rel.startsWith('..') ? abs : rel;
}

/**
 * Flatten replay output to insights.
 *
 * @param {object} replay — output of phase-1-replay.runReplay
 * @param {object} opts
 * @param {string} [opts.memoryRoot]  — when provided, evidence.path is rewritten
 *                                       relative to this root for portability.
 * @returns {Array<Insight>}
 */
export function collectInsights(replay, opts = {}) {
  const { memoryRoot = null } = opts;
  if (!replay || typeof replay !== 'object') return [];

  const out = [];

  if (replay.journal?.found && Array.isArray(replay.journal.entries)) {
    const jpath = replay.journal.path;
    for (let i = 0; i < replay.journal.entries.length; i++) {
      const e = replay.journal.entries[i];
      const bucket = bucketForJournalCategory(e.category);
      if (!KNOWN_BUCKETS.has(bucket)) continue;
      const lineNo = journalLineAnchor(i);
      out.push({
        id: `journal:${relativeIfPossible(memoryRoot, jpath)}#L${lineNo}`,
        source: 'journal',
        bucket,
        text: String(e.summary || '').trim(),
        date: replay.today,
        evidence: {
          path: relativeIfPossible(memoryRoot, jpath),
          lineNumber: lineNo,
        },
      });
    }
  }

  if (replay.sessionLogs && Array.isArray(replay.sessionLogs.entries)) {
    for (const sess of replay.sessionLogs.entries) {
      for (const m of sess.markers) {
        const bucket = String(m.kind || '').toLowerCase();
        if (!KNOWN_BUCKETS.has(bucket) && bucket !== 'method-worked' && bucket !== 'didnt-work') {
          // Defensive: scanSessionMarkers is closed-set, but if the regex ever
          // grows, future tags drop into 'other' rather than crash routing.
          out.push({
            id: `marker:${relativeIfPossible(memoryRoot, sess.path)}#L${m.lineNumber}`,
            source: 'session-marker',
            bucket: 'other',
            text: String(m.text || '').trim(),
            date: dateFromSessionPath(sess.path) || sess.date || null,
            evidence: {
              path: relativeIfPossible(memoryRoot, sess.path),
              lineNumber: m.lineNumber,
            },
          });
          continue;
        }
        out.push({
          id: `marker:${relativeIfPossible(memoryRoot, sess.path)}#L${m.lineNumber}`,
          source: 'session-marker',
          bucket,
          text: String(m.text || '').trim(),
          date: dateFromSessionPath(sess.path) || sess.date || null,
          evidence: {
            path: relativeIfPossible(memoryRoot, sess.path),
            lineNumber: m.lineNumber,
          },
        });
      }
    }
  }

  return out;
}

export const _internals = { JOURNAL_CATEGORY_TO_BUCKET, KNOWN_BUCKETS };
