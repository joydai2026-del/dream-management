// Phase-4 CONTRADICTIONS + DATES.
//
// Per ARCHITECTURE.md § 3.2 Phase 4 + atomicity-contract.md § 2:
//
//   1. Relative-date sweep: scan hot-tier files for relative date phrases
//      (today, yesterday, tomorrow, last week, last month) and rewrite to
//      ISO YYYY-MM-DD. Skips text inside fenced code blocks and inline
//      code spans so a `yesterday` literal in documentation isn't mangled.
//
//   2. Contradiction detection: scan for cited rules whose recent corrections
//      contradict them. Phase-4 starter ships a STUB returning an empty list
//      with a TODO marker — the architecture says "DO NOT auto-fix" so the
//      detection output is purely advisory (consumed by P5 dream-log writer).
//      A meaningful detector is deferred until pre-action.md (the rule
//      surface) is generated and the dream-log entry shape is locked in P5.
//
// Phase-4 mutates ONLY the staged tree; live tree is untouched. Stage paths
// are `archive/dreams/<date>/staged/<rel>.tmp` per atomicity-contract § 2.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../atomic-write.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Relative-date phrases handled by the sweep. Keys are phrases (case-insensitive
// match with word boundaries); values are functions of `today` that return the
// suggested ISO date. The matcher is a simple alternation; precedence follows
// declaration order so multi-word phrases match before bare words.
const RELATIVE_DATE_RULES = [
  { phrase: 'last week', offsetDays: -7 },
  { phrase: 'last month', offsetDays: -30 },
  { phrase: 'next week', offsetDays: +7 },
  { phrase: 'next month', offsetDays: +30 },
  { phrase: 'tomorrow', offsetDays: +1 },
  { phrase: 'yesterday', offsetDays: -1 },
  { phrase: 'today', offsetDays: 0 },
];

// Sorted longest-first so the alternation in the regex prefers `last week` over
// `last` (which we don't match anyway, but order matters once `last <unit>` and
// `last` overlap). This sort is the single source of phrase ordering.
const SORTED_PHRASES = RELATIVE_DATE_RULES
  .map(r => r.phrase)
  .sort((a, b) => b.length - a.length);

// Explicit "plain English" boundary class: ASCII whitespace + ASCII
// punctuation only. CJK letters, emoji surrogates, accented letters, and
// the underscore are NOT in this class, so phrases adjacent to them
// (e.g., `今天today`, `🚀today`, `_today_`) do NOT match. Without this,
// `\b` (which is ASCII-only) treats CJK as non-word and the match fires.
// Code-reviewer R1 M1.
//
// Multi-word phrases use `[ \t]+` between words (horizontal whitespace
// only) so `last\nweek` (split across lines) does NOT match. Codex R1 #4.
const PLAIN_BOUNDARY = "[ \\t\\r\\n.,:;!?'\"()\\[\\]{}/\\\\|@#$%^&+=~\\-]";
const DATE_PHRASE_RE = new RegExp(
  `(^|${PLAIN_BOUNDARY})(${SORTED_PHRASES.map(p => p.replace(/ /g, '[ \\t]+')).join('|')})(?=$|${PLAIN_BOUNDARY})`,
  'gi',
);

const PHRASE_TO_OFFSET = new Map(
  RELATIVE_DATE_RULES.map(r => [r.phrase.toLowerCase(), r.offsetDays]),
);

function offsetISO(today, offsetDays) {
  if (!ISO_DATE_RE.test(today)) {
    throw new Error(`offsetISO: today must match YYYY-MM-DD; got '${today}'`);
  }
  // Parse as UTC midnight so day arithmetic isn't perturbed by local DST.
  const baseMs = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(baseMs)) throw new Error(`offsetISO: invalid date '${today}'`);
  const next = new Date(baseMs + offsetDays * 86_400_000);
  return next.toISOString().slice(0, 10);
}

/**
 * Build a list of [start, end) char-index ranges that should be SKIPPED by
 * the relative-date matcher.
 *
 * Covered span types (R1 reality-checker findings F1, F2, F4 + code-reviewer M2):
 *   - Fenced code blocks (```…```)
 *   - Indent-style code blocks (≥4 leading spaces or a leading tab) per
 *     CommonMark; matched on a per-line basis since fences have already
 *     been consumed.
 *   - Double-backtick inline spans (``…``) — must come BEFORE single
 *     because markdown allows backticks inside ``…``
 *   - Single-backtick inline spans (`…`)
 *   - URLs (https?://…)
 *   - Markdown-link target spans `](…)`
 *   - Double-quoted strings ("…") — preserves verbatim quotes in prose
 *
 * Each successive matcher refuses to claim positions already inside an
 * earlier range, so a `today` inside a fenced span can't be re-marked by
 * a wider matcher.
 */
function buildSkipRanges(content) {
  const ranges = [];
  const claim = ([s, e]) => {
    if (ranges.some(([rs, re]) => s >= rs && s < re)) return;
    ranges.push([s, e]);
  };

  let m;

  // 1. Fenced code blocks (multi-line). Anchored at line-start.
  const fenceRe = /^```[\s\S]*?^```/gm;
  while ((m = fenceRe.exec(content)) !== null) {
    claim([m.index, m.index + m[0].length]);
  }

  // 2. Indent-style code blocks: a line beginning with ≥4 spaces or a tab.
  //    Markdown's other code-block form. Matched per-line; merging adjacent
  //    indented lines into one range is OK but per-line is enough since the
  //    relative-date regex doesn't match across newlines anyway.
  const indentRe = /^(?: {4}|\t)[^\n]*$/gm;
  while ((m = indentRe.exec(content)) !== null) {
    claim([m.index, m.index + m[0].length]);
  }

  // 3. Double-backtick inline (must precede single).
  const dblRe = /``[^\n]+?``/g;
  while ((m = dblRe.exec(content)) !== null) {
    claim([m.index, m.index + m[0].length]);
  }

  // 4. Single-backtick inline.
  const inlineRe = /`[^`\n]+`/g;
  while ((m = inlineRe.exec(content)) !== null) {
    claim([m.index, m.index + m[0].length]);
  }

  // 5. URLs. Bare http(s) up to first whitespace / closing bracket.
  const urlRe = /https?:\/\/[^\s)\]]+/g;
  while ((m = urlRe.exec(content)) !== null) {
    claim([m.index, m.index + m[0].length]);
  }

  // 6. Markdown link targets: `](anything)` (the URL part of a link).
  const mdLinkRe = /\]\([^)\n]+\)/g;
  while ((m = mdLinkRe.exec(content)) !== null) {
    claim([m.index, m.index + m[0].length]);
  }

  // 7. Double-quoted strings — preserves "yesterday" used as a quoted
  //    historical reference.
  const quoteRe = /"[^"\n]*"/g;
  while ((m = quoteRe.exec(content)) !== null) {
    claim([m.index, m.index + m[0].length]);
  }

  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

function inAnyRange(idx, ranges) {
  for (const [s, e] of ranges) {
    if (idx >= s && idx < e) return true;
  }
  return false;
}

function lineNumberAt(content, idx) {
  // 1-based. Counts \n up to (but not including) idx.
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Detect every rewritable relative-date phrase in `content`.
 *
 * @param {string} content
 * @param {string} today    YYYY-MM-DD
 * @returns {Array<{
 *   start: number,
 *   end: number,
 *   lineNumber: number,
 *   phrase: string,
 *   suggestedISO: string,
 * }>}
 */
export function findRelativeDates(content, today) {
  if (typeof content !== 'string') return [];
  const skips = buildSkipRanges(content);
  const out = [];
  // Use a per-call regex so a throw mid-loop doesn't leave a sticky
  // lastIndex on the module-scoped regex (code-reviewer R1 S2).
  const re = new RegExp(DATE_PHRASE_RE.source, DATE_PHRASE_RE.flags);
  let m;
  while ((m = re.exec(content)) !== null) {
    // Group 1 is the leading boundary char (or empty at start-of-string);
    // group 2 is the phrase. Adjust start accordingly.
    const phraseRaw = m[2];
    const start = m.index + m[1].length;
    if (inAnyRange(start, skips)) continue;
    const key = phraseRaw.toLowerCase().replace(/\s+/g, ' ');
    const offset = PHRASE_TO_OFFSET.get(key);
    if (offset === undefined) continue;
    out.push({
      start,
      end: start + phraseRaw.length,
      lineNumber: lineNumberAt(content, start),
      phrase: phraseRaw,
      suggestedISO: offsetISO(today, offset),
    });
  }
  return out;
}

/**
 * Rewrite all relative-date matches in `content` to ISO dates.
 *
 * @returns {{
 *   content: string,
 *   replacements: Array<{lineNumber, phrase, suggestedISO}>,
 * }}
 */
export function rewriteRelativeDates(content, today) {
  const matches = findRelativeDates(content, today);
  if (matches.length === 0) return { content, replacements: [] };
  // Apply right-to-left so earlier indices stay stable.
  let out = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    out = out.slice(0, m.start) + m.suggestedISO + out.slice(m.end);
  }
  return {
    content: out,
    replacements: matches.map(m => ({
      lineNumber: m.lineNumber,
      phrase: m.phrase,
      suggestedISO: m.suggestedISO,
    })),
  };
}

const DEFAULT_HOT_FILES = ['working-memory.md', 'corrections.md', 'session-index.md'];

// Hard cap on working-memory.md line count + line length (per
// SUCCESS-CRITERIA P1 #1: working-memory.md ≤80 lines). The Phase-4 sweep
// must not push the file past this boundary; if a rewrite would overflow,
// the file is dropped from `byFile` and a warning surfaced in summary.
const WORKING_MEMORY_REL = 'working-memory.md';
const WORKING_MEMORY_MAX_LINES = 80;
const WORKING_MEMORY_MAX_LINE_LENGTH = 200;

/**
 * Build the Phase-4 plan: which files have relative-date replacements + a
 * stub list of contradictions (empty for now).
 *
 * @param {object} opts
 * @param {string} opts.memoryRoot
 * @param {string} opts.today                    YYYY-MM-DD
 * @param {string[]} [opts.files]                hot-tier files; defaults
 * @param {string[]} [opts.patternsDirs]         additional dirs to scan
 * @returns {Promise<{plan, summary}>}
 */
export async function runDatesContradictions(opts) {
  const {
    memoryRoot,
    today,
    files = DEFAULT_HOT_FILES,
    patternsDirs = ['patterns/active'],
    excludePaths = [],
    // Codex R1 #1 BLOCKER: when Phase-3 has staged a trimmed version of a
    // hot-tier file (e.g., corrections.md after TTL trim), Phase-4 must
    // apply its rewrite on TOP of that trimmed version, not on the live
    // pre-trim file. Otherwise Phase-4's stage overwrites Phase-3's stage
    // at the same path and Phase-3's compaction is silently lost.
    // The caller (CLI) builds this map from Phase-3 plan output.
    preStaged = null,
  } = opts || {};
  if (!memoryRoot) throw new Error('runDatesContradictions: memoryRoot required');
  if (!today) throw new Error('runDatesContradictions: today required');
  if (!ISO_DATE_RE.test(today)) {
    throw new Error(`runDatesContradictions: today must match YYYY-MM-DD; got '${today}'`);
  }

  // Reality-checker R1 F7 BLOCKER: Phase-3 demotion stages
  // `patterns/reference/X.md.tmp` + tombstones `patterns/active/X.md`. If
  // Phase-4 also stages `patterns/active/X.md.tmp` (date rewrite), the
  // sweep step's tombstone interpretation is ambiguous and a demoted
  // pattern can be silently resurrected with the date rewrite applied.
  // Caller (the CLI) MUST pass `excludePaths` containing the Phase-3
  // demotion source paths so we skip those files entirely.
  const exclude = new Set((excludePaths || []).map(p => p.split(path.sep).join('/')));

  const targetRels = [...files];
  for (const dir of patternsDirs) {
    const abs = path.join(memoryRoot, dir);
    let names = [];
    try {
      names = (await fs.readdir(abs)).sort();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    for (const n of names) {
      if (n.endsWith('.md')) targetRels.push(path.join(dir, n));
    }
  }

  const byFile = [];
  let workingMemoryOverflowSkipped = 0;
  let preStagedHits = 0;
  for (const rel of targetRels) {
    const sourceRel = rel.split(path.sep).join('/');
    if (exclude.has(sourceRel)) continue;
    let content;
    // Prefer the Phase-3 staged version when present so we rewrite on top of
    // the trim, not the pre-trim live file. Falls back to live for any file
    // Phase-3 didn't touch.
    if (preStaged && typeof preStaged.get === 'function' && preStaged.has(sourceRel)) {
      content = preStaged.get(sourceRel);
      preStagedHits += 1;
    } else {
      try {
        content = await fs.readFile(path.join(memoryRoot, rel), 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw e;
      }
    }
    const result = rewriteRelativeDates(content, today);
    if (result.replacements.length === 0) continue;

    // Working-memory line cap guard (code-reviewer R1 M3): Phase-4 must
    // not push working-memory.md past its 80-line / per-line caps. If a
    // rewrite would, drop the file from byFile and surface in the summary.
    if (sourceRel === WORKING_MEMORY_REL) {
      const lines = result.content.split('\n');
      const overflow = lines.length > WORKING_MEMORY_MAX_LINES
        || lines.some(l => l.length > WORKING_MEMORY_MAX_LINE_LENGTH);
      if (overflow) {
        workingMemoryOverflowSkipped += 1;
        continue;
      }
    }

    byFile.push({
      sourceRel,
      newContent: result.content,
      replacements: result.replacements,
    });
  }

  // Contradiction detection: STUB. Real detection is deferred until P5
  // ships pre-action.md and the dream-log writer; the surface and consumer
  // both live there. Returning [] keeps the plan shape stable so downstream
  // (P5 dream-log entry generation) can iterate over it without conditionals.
  const contradictions = [];

  const plan = { today, byFile, contradictions };
  const summary = {
    filesScanned: targetRels.length,
    filesWithReplacements: byFile.length,
    totalReplacements: byFile.reduce((s, f) => s + f.replacements.length, 0),
    contradictionCount: contradictions.length,
    contradictionsStub: true, // P5 will set false when real detection ships
    workingMemoryOverflowSkipped,
    excludedCount: exclude.size,
    preStagedHits,
  };
  return { plan, summary };
}

/**
 * Write Phase-4 rewritten files into `archive/dreams/<date>/staged/`.
 * Same staged-tree pattern as Phase 2 / Phase 3; the P5 sweep step renames
 * each `.tmp` onto its live path.
 */
export async function stageDatesContradictionsPlan(args) {
  const { plan, dreamDir, memoryRoot, today } = args || {};
  if (!plan) throw new Error('stageDatesContradictionsPlan: plan required');
  if (!dreamDir) throw new Error('stageDatesContradictionsPlan: dreamDir required');
  if (!memoryRoot) throw new Error('stageDatesContradictionsPlan: memoryRoot required');
  if (!today) throw new Error('stageDatesContradictionsPlan: today required');

  const stagedRoot = path.join(dreamDir, 'staged');
  const stagedFiles = [];
  for (const entry of (plan.byFile || [])) {
    const stagedPath = path.join(stagedRoot, `${entry.sourceRel}.tmp`);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await atomicWrite(stagedPath, entry.newContent);
    stagedFiles.push(stagedPath);
  }
  return { stagedFiles };
}

export const _internals = {
  RELATIVE_DATE_RULES,
  PHRASE_TO_OFFSET,
  DATE_PHRASE_RE,
  buildSkipRanges,
  inAnyRange,
  lineNumberAt,
  offsetISO,
};
