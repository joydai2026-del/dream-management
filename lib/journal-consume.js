// Reads today's learning-journals/<YYYY-MM-DD>.md and distills it into a
// "Journal Distilled" markdown block for the session log. P2 SUCCESS-CRITERIA #1:
// the block is ≤30 lines, so it fits inside a single screen of session log.
//
// Frontmatter-aware (skips the YAML preamble). No-journal-today is a normal
// outcome, not an error — wrap-up still runs, the section just records "no
// entries captured this session" so memory-loader sees an honest signal.
//
// Entry format from ~/.claude/CLAUDE.md learning-journal protocol:
//   - [HH:MM] [category] one-to-three sentences + path or commit SHA
//
// Categories observed in the protocol get bucketed; unknown ones land in "Other"
// rather than being dropped, so the operator can see them in the distilled view.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ENTRY_RE = /^\s*-\s*\[(\d{1,2}:\d{2})\]\s*\[([^\]]+)\]\s*(.+)$/;

// Map of raw category tokens (lower-cased) → display bucket.
// Synonyms collapse so the distilled view stays readable.
const CATEGORY_BUCKETS = {
  mistake: 'Mistakes',
  correction: 'Corrections / JJ inputs',
  'jj-input': 'Corrections / JJ inputs',
  worked: 'Methods that worked',
  'method-worked': 'Methods that worked',
  completed: 'Methods that worked',
  'didnt-work': "Methods that didn't work",
  "didn't-work": "Methods that didn't work",
  'method-failed': "Methods that didn't work",
  insight: 'Insights',
  start: 'Insights',
};

const BUCKET_ORDER = [
  'Mistakes',
  'Corrections / JJ inputs',
  "Methods that didn't work",
  'Methods that worked',
  'Insights',
  'Other',
];

// Hard cap interpreted as `out.split('\n').length` ≤ MAX_LINES — matches how the
// session-log linter counts lines after the trailing newline.
const MAX_LINES = 30;

function bucketFor(rawCategory) {
  const k = rawCategory.trim().toLowerCase();
  return CATEGORY_BUCKETS[k] || 'Other';
}

// Strip optional YAML frontmatter (lines between the first two `---` markers).
// If no frontmatter, return the input unchanged.
function stripFrontmatter(lines) {
  if (lines.length === 0 || lines[0] !== '---') return lines;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return lines.slice(i + 1);
  }
  return lines; // unterminated frontmatter — be permissive
}

export function parseJournalEntries(content) {
  const body = stripFrontmatter(content.split('\n'));
  const entries = [];
  for (const line of body) {
    const m = line.match(ENTRY_RE);
    if (!m) continue;
    entries.push({
      time: m[1],
      category: m[2].trim(),
      bucket: bucketFor(m[2]),
      summary: m[3].trim(),
    });
  }
  return entries;
}

export function distillEntries(entries, opts = {}) {
  const { date = null, journalPath = null } = opts;
  const dateLabel = date ? ` — ${date}` : '';

  if (entries.length === 0) {
    return `## Journal Distilled${dateLabel}\n\n_No journal entries captured this session._\n`;
  }

  const grouped = new Map();
  for (const e of entries) {
    if (!grouped.has(e.bucket)) grouped.set(e.bucket, []);
    grouped.get(e.bucket).push(e);
  }

  const counts = BUCKET_ORDER
    .filter(b => grouped.has(b))
    .map(b => `${grouped.get(b).length} ${b.toLowerCase()}`);

  const header = [
    `## Journal Distilled${dateLabel}`,
    '',
    `**${entries.length} entries** (${counts.join(', ')}).`,
    '',
  ];

  const body = [];
  for (const bucket of BUCKET_ORDER) {
    if (!grouped.has(bucket)) continue;
    body.push(`**${bucket}**`);
    for (const e of grouped.get(bucket)) {
      body.push(`- [${e.time}] ${e.summary}`);
    }
    body.push('');
  }

  let allLines = [...header, ...body];
  // We append a trailing '\n' to the joined string, so split('\n') sees
  // allLines.length + 1 elements. Cap allLines.length at MAX_LINES - 1.
  if (allLines.length >= MAX_LINES) {
    // Reserve room for marker + trailing-empty. Body is what gets clipped;
    // the header is small and load-bearing for skim-readability.
    const ref = journalPath ? ` see ${journalPath}` : '';
    const marker = `_(truncated to fit ${MAX_LINES}-line cap;${ref})_`;
    const budget = MAX_LINES - 1 - header.length - 1; // -1 marker, -1 trailing empty
    allLines = [...header, ...body.slice(0, Math.max(0, budget)), marker];
  }

  return allLines.join('\n') + '\n';
}

export function journalPathFor(memoryRoot, date) {
  return path.join(memoryRoot, 'learning-journals', `${date}.md`);
}

export async function consumeTodaysJournal(opts) {
  const { memoryRoot, date, journalPath: explicitPath = null } = opts;

  if (!explicitPath && (!memoryRoot || !date)) {
    throw new Error('consumeTodaysJournal: provide journalPath OR (memoryRoot + date)');
  }

  const jp = explicitPath || journalPathFor(memoryRoot, date);

  let content;
  try {
    content = await fs.readFile(jp, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {
        found: false,
        path: jp,
        entries: [],
        distilled: distillEntries([], { date, journalPath: jp }),
      };
    }
    throw e;
  }

  const entries = parseJournalEntries(content);
  return {
    found: true,
    path: jp,
    entries,
    distilled: distillEntries(entries, { date, journalPath: jp }),
  };
}
