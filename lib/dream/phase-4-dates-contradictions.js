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

const DATE_PHRASE_RE = new RegExp(
  // Word-boundary on both sides so `tomorrow` doesn't match inside `tomorrows`.
  `\\b(${SORTED_PHRASES.map(p => p.replace(/ /g, '\\s+')).join('|')})\\b`,
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
 * Build a Set of [start, end) char-index ranges that should be SKIPPED by
 * the relative-date matcher. Covers fenced code blocks (```…```) and inline
 * code spans (`…`). Skipping these preserves prose-as-data and keeps
 * documentation snippets like `yesterday's value` from being rewritten.
 */
function buildSkipRanges(content) {
  const ranges = [];

  // Fenced code blocks. Match opener-to-closer non-greedily; line-based.
  const fenceRe = /^```[\s\S]*?^```/gm;
  let m;
  while ((m = fenceRe.exec(content)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // Inline single-backtick spans. Don't cross newlines.
  const inlineRe = /`[^`\n]+`/g;
  while ((m = inlineRe.exec(content)) !== null) {
    // Skip if already inside a fenced range
    if (ranges.some(([s, e]) => m.index >= s && m.index < e)) continue;
    ranges.push([m.index, m.index + m[0].length]);
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
  // Reset stickiness so successive calls don't share lastIndex state.
  DATE_PHRASE_RE.lastIndex = 0;
  let m;
  while ((m = DATE_PHRASE_RE.exec(content)) !== null) {
    const start = m.index;
    if (inAnyRange(start, skips)) continue;
    const phraseRaw = m[1];
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
  } = opts || {};
  if (!memoryRoot) throw new Error('runDatesContradictions: memoryRoot required');
  if (!today) throw new Error('runDatesContradictions: today required');
  if (!ISO_DATE_RE.test(today)) {
    throw new Error(`runDatesContradictions: today must match YYYY-MM-DD; got '${today}'`);
  }

  const targetRels = [...files];
  for (const dir of patternsDirs) {
    const abs = path.join(memoryRoot, dir);
    let names = [];
    try {
      names = await fs.readdir(abs);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    for (const n of names) {
      if (n.endsWith('.md')) targetRels.push(path.join(dir, n));
    }
  }

  const byFile = [];
  for (const rel of targetRels) {
    const abs = path.join(memoryRoot, rel);
    let content;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    const result = rewriteRelativeDates(content, today);
    if (result.replacements.length === 0) continue;
    byFile.push({
      sourceRel: rel.split(path.sep).join('/'),
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
